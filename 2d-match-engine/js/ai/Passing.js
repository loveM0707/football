import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

/**
 * @fileoverview 패스 판단 전면 재작성 모듈.
 *
 * 기존의 THROUGH / FORWARD / SAFE 3분류를 폐기하고, 실제 축구에서 구분되는
 * 10가지 패스 유형으로 나눠 각각을 독립적으로 평가한다. 유형이 분리되어
 * 있으므로 감독의 전술 지시(팀 전술·공격 방향·패스 유형·좌우 폭)가 어떤
 * 유형을 얼마나 선호할지 직접 지정할 수 있고, 지시에 따라 패스 성향이
 * 뚜렷하게 달라진다.
 *
 * 평가 구조:
 *   1) 동료마다 후보 패스를 만들고 유형을 분류한다 (classifyPass)
 *   2) 유형별 기본 점수 + 상황 항(전진·개방도·경합) + 전술 항을 더한다
 *   3) 거리 감쇠를 적용해 최종 점수를 낸다
 *
 * 스루패스 계열(THROUGH / LOFTED_THROUGH)은 예외 없이 "동료가 뛰어가는
 * 앞 공간"을 목표(futurePos)로 삼는다. 발밑으로 주는 스루패스는 없다.
 */

/** 10가지 패스 유형 */
export const PassType = {
  CENTRAL_SHORT:  'CENTRAL_SHORT',   // 중앙으로 주는 숏패스
  CENTRAL_LONG:   'CENTRAL_LONG',    // 중앙으로 주는 롱패스
  WIDE_SHORT:     'WIDE_SHORT',      // 측면으로 주는 숏패스
  WIDE_LONG:      'WIDE_LONG',       // 측면으로 주는 롱패스
  CIRCULATE:      'CIRCULATE',       // 볼돌리기용 숏패스
  BACK_PASS:      'BACK_PASS',       // 백패스
  THROUGH:        'THROUGH',         // 스루패스 (지상, 앞 공간)
  LOFTED_THROUGH: 'LOFTED_THROUGH',  // 로빙 스루패스 (수비 위로, 앞 공간)
  GROUND_CROSS:   'GROUND_CROSS',    // 땅볼 크로스
  HIGH_CROSS:     'HIGH_CROSS',      // 높은 크로스
};

/** 한국어 라벨 (디버그 표시용) */
export const PASS_TYPE_LABEL = {
  CENTRAL_SHORT: '중앙 숏패스',
  CENTRAL_LONG: '중앙 롱패스',
  WIDE_SHORT: '측면 숏패스',
  WIDE_LONG: '측면 롱패스',
  CIRCULATE: '볼돌리기',
  BACK_PASS: '백패스',
  THROUGH: '스루패스',
  LOFTED_THROUGH: '로빙 스루패스',
  GROUND_CROSS: '땅볼 크로스',
  HIGH_CROSS: '높은 크로스',
};

/** 숏패스/롱패스 경계 (m) */
const SHORT_MAX = 18;
/** 이 비율(피치 폭의 절반 기준)보다 바깥이면 '측면'으로 본다 */
const WIDE_LATERAL = 0.45;
/** 공중으로 띄워 보내는 유형 */
const LOFTED_TYPES = new Set([PassType.LOFTED_THROUGH, PassType.HIGH_CROSS]);
/** 앞 공간(리드)으로 보내는 스루패스 계열 */
const THROUGH_TYPES = new Set([PassType.THROUGH, PassType.LOFTED_THROUGH]);
/** 크로스 계열 */
const CROSS_TYPES = new Set([PassType.GROUND_CROSS, PassType.HIGH_CROSS]);
/** 전진(공격) 성격의 유형 — 공격적 전술이 선호 */
const FORWARD_TYPES = new Set([
  PassType.THROUGH, PassType.LOFTED_THROUGH,
  PassType.CENTRAL_LONG, PassType.WIDE_LONG,
  PassType.GROUND_CROSS, PassType.HIGH_CROSS,
]);
/** 소유 유지 성격의 유형 — 수비적 전술이 선호 */
const RETAIN_TYPES = new Set([PassType.CIRCULATE, PassType.BACK_PASS]);
/** 중앙 지향 유형 */
const CENTRAL_TYPES = new Set([PassType.CENTRAL_SHORT, PassType.CENTRAL_LONG]);
/** 측면 지향 유형 */
const WIDE_ORIENTED_TYPES = new Set([
  PassType.WIDE_SHORT, PassType.WIDE_LONG,
  PassType.GROUND_CROSS, PassType.HIGH_CROSS,
]);
/** 롱패스 성격 (패스 유형 지시의 짧게/길게가 직접 가감) */
const LONG_TYPES = new Set([
  PassType.CENTRAL_LONG, PassType.WIDE_LONG,
  PassType.LOFTED_THROUGH, PassType.HIGH_CROSS,
]);
const SHORT_TYPES = new Set([
  PassType.CENTRAL_SHORT, PassType.WIDE_SHORT,
  PassType.CIRCULATE, PassType.BACK_PASS,
  PassType.GROUND_CROSS,
]);

/** 유형별 기본 점수 */
const TYPE_BASE = {
  [PassType.THROUGH]:        86,
  [PassType.LOFTED_THROUGH]: 70,
  [PassType.HIGH_CROSS]:     68,
  [PassType.GROUND_CROSS]:   66,
  [PassType.CENTRAL_SHORT]:  50,
  [PassType.WIDE_SHORT]:     48,
  [PassType.CENTRAL_LONG]:   44,
  [PassType.WIDE_LONG]:      42,
  [PassType.CIRCULATE]:      20,
  [PassType.BACK_PASS]:      14,
};

/** 거리 감쇠 계수: S_final = S_base / (1 + k·d) */
const DIST_DECAY_K = 0.050;
/** 이 거리를 넘는 패스는 (능력치 + 전술 보정)이 충분해야 시도한다 */
const D_MAX_LONG = 32;

export function isThroughType(type) { return THROUGH_TYPES.has(type); }
export function isCrossType(type) { return CROSS_TYPES.has(type); }
export function isLoftedType(type) { return LOFTED_TYPES.has(type); }

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function segmentPointInfo(p, a, b) {
  const ab = b.sub(a);
  const t = clamp01(p.sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6));
  const proj = a.add(ab.scale(t));
  return { dist: p.sub(proj).length(), t };
}

/** from→to 경로를 상대가 가로막고 있는지 */
function laneBlocked(from, to, opponents, radius = 1.8) {
  return opponents.some((o) => {
    if (o.role === 'GK') return false;
    const { dist, t } = segmentPointInfo(o.position, from, to);
    return dist < radius && t > 0.08 && t < 0.92;
  });
}

/** 상대 최종 수비 라인 X */
function lastDefenderX(opponentTeam, attackDir) {
  const out = opponentTeam.players.filter((p) => p.role !== 'GK');
  if (out.length === 0) return attackDir === 1 ? Pitch.LENGTH : 0;
  return attackDir === 1
    ? Math.max(...out.map((p) => p.position.x))
    : Math.min(...out.map((p) => p.position.x));
}

/** 좌우 위치를 중앙성으로 환산: +1 = 정중앙, -1 = 터치라인 */
function centralityOf(point) {
  const lateralNorm = Math.min(1, Math.abs(point.y - Pitch.WIDTH / 2) / (Pitch.WIDTH / 2));
  return 1 - lateralNorm * 2;
}

function lateralNormOf(point) {
  return Math.min(1, Math.abs(point.y - Pitch.WIDTH / 2) / (Pitch.WIDTH / 2));
}

// ═══════════════════════════════════════════════════════════════
// 스루패스 리드 목표 — 항상 "동료가 뛰어가는 앞 공간"
//
// 동료의 진행 방향(속도 벡터 → 오프볼 목표 → 공격 방향 순)을 구해 그 방향
// 앞 10~15m 지점을 목표로 삼는다. 동료는 그 공간까지 전력 질주해서 받는다.
// ═══════════════════════════════════════════════════════════════
const LEAD_MIN = 10;
const LEAD_MAX = 15;

function computeRunSpace(passer, runner, attackDir) {
  // 1) 실제로 달리고 있으면 그 방향
  let dir = null;
  if (runner.velocity && runner.velocity.length() > 1.2) {
    dir = runner.velocity.normalize();
  }
  // 2) 아니면 오프볼 목표 방향
  if (!dir) {
    const tgt = runner.brainMemory?.offBallTarget;
    if (tgt) {
      const toTgt = tgt.sub(runner.position);
      if (toTgt.length() > 1.5) dir = toTgt.normalize();
    }
  }
  // 3) 그래도 없으면 공격 방향
  if (!dir) dir = new Vector2D(attackDir, 0);

  // 뒤로 달리는 중이면 스루패스 대상이 아니다
  if (dir.x * attackDir < -0.25) return null;

  const leadDist = Math.max(LEAD_MIN, Math.min(LEAD_MAX, (runner.maxSpeed ?? 5.5) * 2.2));
  const raw = runner.position.add(dir.scale(leadDist));

  // 골라인 앞 7m까지만 (골키퍼가 잡아 버리는 지점 방지)
  const goalLineX = attackDir === 1 ? Pitch.LENGTH : 0;
  const cappedX = attackDir === 1
    ? Math.min(raw.x, goalLineX - 7)
    : Math.max(raw.x, goalLineX + 7);
  const target = new Vector2D(
    cappedX,
    Math.max(3, Math.min(Pitch.WIDTH - 3, raw.y))
  );

  // 패서보다 앞이어야 스루패스다
  if ((target.x - passer.position.x) * attackDir < 3) return null;
  return target;
}

/**
 * 스루패스 유효성: 동료가 수비수보다 먼저 그 공간에 도달할 수 있는가.
 * @returns {{target: Vector2D, raceMargin: number}|null}
 */
function evaluateRunSpace(passer, runner, opponentTeam, attackDir) {
  const target = computeRunSpace(passer, runner, attackDir);
  if (!target) return null;

  const runnerTime = target.sub(runner.position).length() / Math.max(1, runner.maxSpeed);
  let defTime = Infinity;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const t = target.sub(o.position).length() / Math.max(1, o.maxSpeed);
    if (t < defTime) defTime = t;
  }
  // 동료가 명확히 먼저 닿아야 한다
  if (runnerTime >= defTime * 0.92) return null;
  return { target, raceMargin: defTime - runnerTime };
}

// ═══════════════════════════════════════════════════════════════
// 패스 유형 분류
// ═══════════════════════════════════════════════════════════════
function classifyPass({ dist, forwardProgress, receiverPoint, isCrossSituation, groundLaneOpen }) {
  if (isCrossSituation) {
    return groundLaneOpen ? PassType.GROUND_CROSS : PassType.HIGH_CROSS;
  }
  if (forwardProgress < -3) return PassType.BACK_PASS;
  if (dist <= SHORT_MAX && Math.abs(forwardProgress) <= 3) return PassType.CIRCULATE;

  const wide = lateralNormOf(receiverPoint) > WIDE_LATERAL;
  if (dist <= SHORT_MAX) return wide ? PassType.WIDE_SHORT : PassType.CENTRAL_SHORT;
  return wide ? PassType.WIDE_LONG : PassType.CENTRAL_LONG;
}

// ═══════════════════════════════════════════════════════════════
// 메인: 패스 후보 평가
// ═══════════════════════════════════════════════════════════════
export function evaluatePassOptions(player, team, opponentTeam) {
  const attackDir = team.attackingDirection;
  const tactics = team.tactics ?? {};
  const goalPos = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
  const goalLineX = attackDir === 1 ? Pitch.LENGTH : 0;
  const opponents = opponentTeam.players;
  const mem = player.brainMemory ?? {};

  const visionStat = player.attributes.vision ?? player.attributes.positioning;
  const vision = visionStat / 100;
  const passingStat = player.attributes.passing;
  const maxScanDist = 22 + visionStat * 0.26;

  // ── 전술 파라미터 ───────────────────────────────────────────
  const mentality = tactics.mentalityScalar ?? 0;            // -1(수비적) ~ +1(공격적)
  const centralPref = tactics.centralityPreference ?? 0;     // -1.45(측면) ~ +1.45(중앙)
  const lengthPref = tactics.passLengthPreference ?? 0;      // -1(짧게) ~ +1(길게)
  const forwardWeight = tactics.forwardPassWeight ?? 1.5;
  const longSkillBonus = tactics.longPassSkillBonus ?? 0;
  const crossPref = tactics.crossPreference ?? 0.5;

  // 파이널 서드 안에서는 패스 유형(짧게/길게) 지시를 적용하지 않는다
  const finalThirdEdge = attackDir === 1
    ? Pitch.LENGTH - Pitch.LENGTH / 3
    : Pitch.LENGTH / 3;
  const passerInFinalThird = attackDir === 1
    ? player.position.x > finalThirdEdge
    : player.position.x < finalThirdEdge;

  // 크로스 상황: 측면 깊은 위치에서 박스 안 동료를 노릴 때
  const passerLateral = lateralNormOf(player.position);
  const distToGoalLine = Math.abs(player.position.x - goalLineX);
  const inCrossZone = passerLateral > 0.42 &&
    distToGoalLine < Pitch.PENALTY_BOX_LENGTH + 16;

  // 직전에 차단당한 패스 회피
  const cutActive = (mem.cutPassTimer ?? 0) > 0;
  const cutTarget = cutActive ? mem.cutPassTarget : null;
  const cutDir = cutActive ? mem.cutPassDir : null;

  // 자기 진영 압박 회피: 가장 가까운 상대의 반대쪽 동료를 우선한다
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const inOwnThird = Math.abs(player.position.x - ownGoalX) < Pitch.LENGTH / 3;
  let presserDir = null;
  let nearestOppDist = Infinity;
  for (const o of opponents) {
    if (o.role === 'GK') continue;
    const d = o.position.sub(player.position).length();
    if (d < nearestOppDist) {
      nearestOppDist = d;
      presserDir = o.position.sub(player.position);
    }
  }
  const avoidPresser = nearestOppDist < 9 && presserDir && presserDir.length() > 0.5;
  const presserUnit = avoidPresser ? presserDir.normalize() : null;

  const oppLineX = lastDefenderX(opponentTeam, attackDir);
  const options = [];

  for (const teammate of team.players) {
    if (teammate === player || teammate.role === 'GK') continue;
    const dist = teammate.position.sub(player.position).length();
    if (dist < 3 || dist > maxScanDist) continue;
    // 롱패스 사거리: 능력치 + 전술(길게/짧게) 보정
    if (dist > D_MAX_LONG && passingStat + longSkillBonus < 72) continue;

    const forwardProgress = (teammate.position.x - player.position.x) * attackDir;
    const nearReceiver = opponents.filter(
      (o) => o.role !== 'GK' && o.position.sub(teammate.position).length() < 6
    ).length;
    const footBlocked = laneBlocked(player.position, teammate.position, opponents);
    const open = nearReceiver === 0 && !footBlocked;

    // ── ① 스루패스 계열: 항상 "뛰어가는 앞 공간"으로 ────────────
    // 침투/측면돌파/박스쇄도/서포트 러너에게만, 그리고 그 공간을 동료가
    // 먼저 잡을 수 있을 때만 성립한다.
    const ob = teammate.brainMemory?.offBallBehavior;
    const isRunner = ob === 'PENETRATING' || ob === 'FLANKING' ||
                     ob === 'BOX_CRASHING' || ob === 'OVERLAPPING' ||
                     ob === 'OPP_RUN' || ob === 'SEEKING_SUPPORT';
    if (isRunner || forwardProgress > 6) {
      const run = evaluateRunSpace(player, teammate, opponentTeam, attackDir);
      if (run) {
        // 시야가 낮으면 스루패스 기회를 놓칠 수 있다
        if (Math.random() <= Math.min(1, vision * 1.15)) {
          const spaceGroundOpen = !laneBlocked(player.position, run.target, opponents, 1.6);
          const type = spaceGroundOpen ? PassType.THROUGH : PassType.LOFTED_THROUGH;
          const spaceDist = player.position.sub(run.target).length();
          options.push(buildOption({
            player: teammate, type, distance: spaceDist,
            forwardProgress: (run.target.x - player.position.x) * attackDir,
            open: spaceGroundOpen, futurePos: run.target,
            raceMargin: run.raceMargin, nearReceiver: 0, blocked: !spaceGroundOpen,
            receiverPoint: run.target,
          }));
        }
      }
    }

    // ── ② 크로스 계열 ────────────────────────────────────────
    const receiverInBox = Math.abs(teammate.position.x - goalLineX) < Pitch.PENALTY_BOX_LENGTH + 6 &&
      lateralNormOf(teammate.position) < 0.62;
    if (inCrossZone && receiverInBox && forwardProgress > -6) {
      // 박스 중앙 앞쪽 지점으로 올린다 (동료 미래 위치와 박스 중심을 절충)
      const [gTop, gBottom] = Pitch.goalYRange();
      const boxCenter = new Vector2D(
        goalLineX - attackDir * (Pitch.GOAL_BOX_LENGTH + 3),
        (gTop + gBottom) / 2
      );
      const recvFuture = teammate.position.add(teammate.velocity.scale(0.7));
      const crossTarget = Vector2D.lerp(recvFuture, boxCenter, 0.45);
      const groundLaneOpen = !laneBlocked(player.position, crossTarget, opponents, 1.5);
      const type = classifyPass({
        dist, forwardProgress, receiverPoint: crossTarget,
        isCrossSituation: true, groundLaneOpen,
      });
      const crossDist = player.position.sub(crossTarget).length();
      options.push(buildOption({
        player: teammate, type, distance: crossDist, forwardProgress,
        open: groundLaneOpen, futurePos: crossTarget, raceMargin: 0,
        nearReceiver, blocked: !groundLaneOpen, receiverPoint: crossTarget,
      }));
    }

    // ── ③ 일반 패스 (중앙/측면 × 숏/롱, 볼돌리기, 백패스) ───────
    const type = classifyPass({
      dist, forwardProgress, receiverPoint: teammate.position,
      isCrossSituation: false, groundLaneOpen: !footBlocked,
    });
    options.push(buildOption({
      player: teammate, type, distance: dist, forwardProgress,
      open, futurePos: null, raceMargin: 0,
      nearReceiver, blocked: footBlocked, receiverPoint: teammate.position,
    }));
  }

  return options;

  // ── 후보 하나를 점수화해 옵션 객체로 만든다 ──────────────────
  function buildOption({
    player: teammate, type, distance, forwardProgress, open,
    futurePos, raceMargin, nearReceiver, blocked, receiverPoint,
  }) {
    let score = TYPE_BASE[type] ?? 30;

    // 전진 이득 — 가중치는 팀 전술이 좌우 (공격적일수록 크다)
    score += forwardProgress * forwardWeight;

    // 골문에 얼마나 가까워지는가
    const senderToGoal = player.position.sub(goalPos).length();
    const receiverToGoal = receiverPoint.sub(goalPos).length();
    score += Math.max(0, senderToGoal - receiverToGoal) * 1.6;

    // ── 전술 ①: 팀 전술 (공격적 = 전진 패스 / 수비적 = 백패스·볼돌리기) ──
    if (FORWARD_TYPES.has(type)) score += mentality * 22;
    else if (RETAIN_TYPES.has(type)) score -= mentality * 42;
    else if (forwardProgress > 3) score += mentality * 10;

    // 뒤로 돌릴 이유가 없으면 백패스·볼돌리기를 강하게 억제한다.
    // 압박을 받을수록 이 페널티가 사라져(진짜 필요할 때만) 뒤로 뺀다.
    if (RETAIN_TYPES.has(type)) {
      const pressureNorm = clamp01((player.brainMemory?.pressureScore ?? 0) / 65);
      score -= (1 - pressureNorm) * 34;
    }

    // ── 전술 ②: 공격 방향 + 좌우 폭 (중앙 ↔ 측면) ────────────
    if (CENTRAL_TYPES.has(type)) score += centralPref * 26;
    else if (WIDE_ORIENTED_TYPES.has(type)) score -= centralPref * 26;
    // 수신 지점의 실제 좌우 위치도 함께 반영 (상대 진영 겨냥 패스에 한정)
    const beyondHalf = attackDir === 1
      ? receiverPoint.x > Pitch.LENGTH / 2
      : receiverPoint.x < Pitch.LENGTH / 2;
    if (beyondHalf) score += centralPref * centralityOf(receiverPoint) * 30;

    // ── 전술 ③: 패스 유형 (짧게 ↔ 길게) ─────────────────────
    // 파이널 서드 안에서는 적용하지 않는다
    if (!passerInFinalThird) {
      if (LONG_TYPES.has(type)) score += lengthPref * 24;
      else if (SHORT_TYPES.has(type)) score -= lengthPref * 24;
      score += lengthPref * (distance - SHORT_MAX) * 1.6;
    }

    // ── 전술 ④: 크로스 선호 (측면 지향일수록 크로스 우대) ─────
    if (CROSS_TYPES.has(type)) score += (crossPref - 0.5) * 40;

    // 개방도 / 차단
    score -= nearReceiver * 9;
    if (blocked && !LOFTED_TYPES.has(type)) score -= 20;

    // 스루패스 도달 경쟁 여유
    if (THROUGH_TYPES.has(type)) {
      if (raceMargin > 0.4) score += 26;
      else if (raceMargin > 0.2) score += 15;
      else if (raceMargin > 0) score += 7;
      // 수비 라인을 넘겨 받는 스루패스는 추가 가치
      const beyondLine = (receiverPoint.x - oppLineX) * attackDir > 0;
      if (beyondLine) score += 18;
    }

    // 자기 진영에서 압박받는 중이면 상대 반대쪽으로 빼는 패스를 크게 우대
    if (avoidPresser && distance > 0.5) {
      const toRecv = receiverPoint.sub(player.position);
      if (toRecv.length() > 0.5) {
        const alignment = toRecv.normalize().dot(presserUnit);
        score -= alignment * (inOwnThird ? 42 : 18);
      }
    }

    // 거리 감쇠
    score = score / (1 + DIST_DECAY_K * distance);

    // 직전 차단 회피
    if (cutActive) {
      if (cutTarget === teammate) score -= 45;
      else if (cutDir) {
        const toMate = teammate.position.sub(player.position);
        if (toMate.length() > 0.5 && toMate.normalize().dot(cutDir) > 0.82) score -= 22;
      }
    }

    const lofted = LOFTED_TYPES.has(type) || (distance > 34 && !THROUGH_TYPES.has(type));
    return {
      player: teammate,
      type,
      score,
      distance,
      forwardProgress,
      open,
      futurePos,
      lofted,
      lobbed: lofted,                 // 기존 소비처 호환
      leadSpaceOpen: THROUGH_TYPES.has(type),
      isThrough: THROUGH_TYPES.has(type),
      isCross: CROSS_TYPES.has(type),
      raceMargin,
    };
  }
}
