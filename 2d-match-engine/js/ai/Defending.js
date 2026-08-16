import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ═══════════════════════════════════════════════════════════════
// 상대 소유 시(Out of Possession) 수비 알고리즘
//
// Stage 2: 압박 선수(Presser) 선정 — 비용 함수(C_i = dist × W_role) 기반
// Stage 3: 대인 마크(Marking) + 커버 섀도우(Cover Shadow) 목표 계산
// Stage 1(수비 블록/간격 축소)은 FormationPositioning의 DEF 파이프라인이 담당
// ═══════════════════════════════════════════════════════════════

// ── 압박 선수 비용 가중치 ──────────────────────────────────────
// CB는 중앙 수비 위치가 중요해 가중치가 높고(잘 안 나섬),
// CM은 가장 낮아 공에 가장 먼저 나선다.
const PRESS_ROLE_WEIGHT = {
  GK: 99, CB: 2.0, LB: 1.4, RB: 1.4,
  CM: 0.8, LM: 1.0, RM: 1.0, ST: 1.5,
};

/** 압박 선수가 기본 위치에서 이 거리(m)를 초과하면 압박을 해제하고 복귀한다 */
export const MAX_TETHER = 18;

/** 공과 가장 가까운 수비수 maxCount명(골키퍼 제외)을 반환한다 (단순 거리 정렬) */
export function findPressers(defendingPlayers, ball, maxCount = 1) {
  return defendingPlayers
    .filter((p) => p.role !== 'GK')
    .map((p) => ({ p, d: p.position.sub(ball.position).length() }))
    .sort((a, b) => a.d - b.d)
    .slice(0, maxCount)
    .map((e) => e.p);
}

/**
 * 비용 함수 기반 압박 선수 선정 — C_i = dist × W_role
 * CB처럼 중요 수비 포지션은 W가 높아 공이 바로 앞에 없는 한 압박에 나서지 않는다.
 * CM은 W가 낮아 중거리에서도 비용이 가장 낮아 1차 압박을 자주 담당한다.
 *
 * 위치 보정(코너 보정): 공을 가진 드리블러가 우리 골문을 향해 전진하는 상황에서
 *  - 드리블러보다 "앞"(골 사이드, 우리 골문과 드리블러 사이)에 있는 가까운 수비수는
 *    정면에서 압박할 수 있으므로 비용을 낮춰 압박을 맡긴다.
 *  - 드리블러보다 "뒤"(공격측, 드리블러를 지나친 자리)에 있는 수비수는 뒤에서 쫓아가는
 *    비효율적인 압박이므로 비용을 높여 압박을 해제하게 한다.
 */
export function selectPressers(defendingPlayers, ball, count = 1) {
  const carrier = ball.owner;
  const team = defendingPlayers[0]?.team;
  let movingToOwnGoal = false;
  let attackDir = team?.attackingDirection ?? 1;
  let ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  let ownGoalPos = null;
  if (carrier && team && carrier.team !== team) {
    ownGoalPos = ownGoalCenter(team);
    if (carrier.velocity && carrier.velocity.length() > 0.3) {
      movingToOwnGoal = carrier.velocity.dot(ownGoalPos.sub(carrier.position)) > 0;
    }
  }

  return defendingPlayers
    .filter((p) => p.role !== 'GK')
    .map((p) => {
      const dist = p.position.sub(ball.position).length();
      let cost = dist * (PRESS_ROLE_WEIGHT[p.role] ?? 1.0);

      // 드리블러가 우리 골문을 향해 전진할 때만 방향 보정 적용
      if (carrier && movingToOwnGoal && carrier.team !== team) {
        const pFromGoal = (p.position.x - ownGoalX) * attackDir;      // 우리 골문에서 멀어질수록 커짐
        const carFromGoal = (carrier.position.x - ownGoalX) * attackDir;
        if (pFromGoal < carFromGoal - 0.5 && dist < 22) {
          // 드리블러 앞(골 사이드)에서 정면 압박 가능한 수비수 → 비용 감소
          cost *= 0.55;
        } else if (pFromGoal > carFromGoal + 1.0) {
          // 드리블러 뒤(공격측)에서 뒤를 쫓는 수비수 → 비용 증가
          cost *= 2.4;
        }
      }

      return { p, cost };
    })
    .sort((a, b) => a.cost - b.cost)
    .slice(0, count)
    .map((e) => e.p);
}

/**
 * 1차 압박 접근 지점 — 골 사이드 접근 벡터 (Goal-Side Approach)
 * 공 → 우리 골대 방향 단위벡터(û)로 rTackle 미터 전방에 서서 전진 경로를 차단한다.
 * P_press = P_ball + û × rTackle  (û = normalize(ownGoal − ball))
 */
export function computePresserTarget(ball, team, rTackle = 1.8) {
  const ownGoal = ownGoalCenter(team);
  const goalDir = ownGoal.sub(ball.position);
  const len = goalDir.length();
  if (len < 1e-3) return ball.position.clone();
  return ball.position.add(goalDir.normalize().scale(rTackle));
}

/** 2차 압박 선수의 길목 차단 위치 — 1차 압박 선수보다 골 쪽으로 더 깊이 자리 잡는다 */
export function computeCutoffTarget(ball, team) {
  return computePresserTarget(ball, team, 3.5);
}

/**
 * Breakaway Drive 감지 — 고립된 장거리 드리블(1v1 위험 전조)
 *
 * 상대가 속도를 내며 우리 골문을 향해 장거리 드리블("후방 드리블 돌파")할 때,
 * 드리블러와 골대 사이 세로 회랑(±4.5m)에 수비수가 하나도 없어 이대로 두면
 * 1v1(키퍼와 1대1)로 이어지는 상황인지 판정한다. 정상 수비 블록이 이미
 * 경로를 막고 있으면(회랑 안에 수비수 존재) false를 반환해 과잉 대응을 막는다.
 */
export function isBreakawayDrive({ team, ball, ownGoalX, pressers = [] }) {
  const carrier = ball.owner;
  if (!carrier || carrier.team === team || carrier.role === 'GK') return false;

  const ownGoal = ownGoalCenter(team);
  const carrierDist = Math.abs(carrier.position.x - ownGoalX);

  // 후방 장거리 드리블: 속도를 내며 우리 골문으로 진행 (파이널 서드 진입 전)
  const moving = carrier.velocity && carrier.velocity.length() > 1.2 &&
    carrier.velocity.dot(ownGoal.sub(carrier.position)) > 0;
  if (!moving || carrierDist < 26 || carrierDist > 50) return false;

  // 옆에서 추격 중인 수비수(비압박)가 3m 이내로 달라붙어 있으면 추격 상황으로 간주
  // → 브레이크아웃은 아니므로 과잉 대응하지 않는다.
  const sideCover = team.outfieldPlayers.some(
    (p) => !pressers.includes(p) && p.role !== 'GK' &&
      p.position.sub(carrier.position).length() < 3.0
  );
  if (sideCover) return false;

  const axis = ownGoal.sub(carrier.position);
  const axisLen = axis.length();
  if (axisLen < 1e-3) return false;
  const axisDir = axis.normalize();

  // 골 사이드 세로 회랑(±4.5m) 안에 "후방 수비 블록"이 이미 서 있으면 정상 대응으로 판단.
  // 특수처리: 1차/2차 압박 선수(공 앞 1.8~3.5m에 붙어 있는 선수)는 회랑 걸림에서 제외 —
  // 압박 선수가 앞에서 막기 시작해도 백라인이 비어 있으면 여전히 브레이크아웃 위험으로
  // 보고, 커버 러너가 마지막 수비선을 채우도록 한다.
  const laneBlockers = team.outfieldPlayers.filter((p) => {
    if (p.role === 'GK' || pressers.includes(p)) return false;
    const vec = p.position.sub(carrier.position);
    const along = vec.dot(axisDir);
    if (along < 2 || along > axisLen - 2) return false; // 캐리어~골대 사이에 있어야 함
    const perp = Math.abs(vec.x * (-axisDir.y) + vec.y * axisDir.x); // 2D cross abs
    return perp < 4.5;
  });
  return laneBlockers.length === 0;
}

/**
 * Breakaway Cover — 고립 장거리 드리블에 대한 2차 수비선(커버 러너) 선정
 *
 * isBreakawayDrive 상황에서, 골 사이드에 몸을 담근 수비수 중 진행 경로(레인)에
 * 가장 가까운 선수(우선 CB → 풀백)를 커버 러너로 지정해 드리블러 진행 경로 위
 * 지점으로 복귀시킨다. 1차 압박 선수가 제쳐지더라도 1v1(키퍼와 1대1) 상황으로
 * 연결되는 것을 막는 마지막 방어 망이다.
 *
 * @returns 커버 러너 목표 지점. 자신이 커버 러너가 아니면 null.
 */
export function computeBreakawayCover({ player, team, opponentTeam, ball, pressers, ownGoalX, active = true }) {
  const carrier = ball.owner;
  if (!carrier || carrier.team === team || carrier.role === 'GK') return null;
  const healthy = isBreakawayDrive({ team, ball, ownGoalX, pressers });
  // active(이미 지정된 커버 윈도 내)면 잠깐 상황이 흔들려도 커버 러너를 유지해
  // 수비가 공진(oscillation)하지 않게 한다.
  if (!healthy && !active) return null;

  const ownGoal = ownGoalCenter(team);
  const carrierDist = Math.abs(carrier.position.x - ownGoalX);
  const axis = ownGoal.sub(carrier.position);
  const axisLen = axis.length();
  const axisDir = axis.normalize();

  // 커버 러너 후보: 골 사이드에 몸을 담근 수비수 중에서 진행 레인에 가장 가까운 선수
  // (CB 우선 → 풀백 → 중원, 스트라이커는 수비 회귀 대상에서 제외)
  // 주의: 랭킹 산정 시 자기 자신을 제외하지 않는다(제외하면 아무도 커버 러너가 될 수 없음).
  const ranking = team.outfieldPlayers
    .filter((p) => !pressers.includes(p) && p.role !== 'GK' && p.role !== 'ST')
    .filter((p) => Math.abs(p.position.x - ownGoalX) < carrierDist - 2)
    .map((p) => {
      const pri = p.role === 'CB' ? 0 : (p.role === 'LB' || p.role === 'RB') ? 1 : 2;
      const d = p.position.sub(carrier.position).length();
      return { p, pri, d };
    })
    .sort((a, b) => (a.pri - b.pri) || (a.d - b.d));

  if (ranking.length === 0) return null;
  if (ranking[0].p !== player) return null;

  // 드리블러 진행 경로 위, 골 방향 40% 지점(6~14m)에서 경로를 차단한다
  const laneLen = Math.min(14, Math.max(6, axisLen * 0.4));
  const lane = carrier.position.add(axisDir.scale(laneLen));

  return { target: Pitch.clampInside(lane, 1.2) };
}

/**
 * 커버링 쉬프트 — 압박 선수가 비운 앵커 위치를 주변 동료가 채운다.
 * 압박 선수(presser)의 기본 위치(basePosition)에 가까운 비-압박 선수에 한해
 * 자신의 수비 목표를 20~30% 해당 위치 쪽으로 당긴다.
 *
 * @param {Vector2D} target  — 현재 선수의 수비 목표 좌표
 * @param {Object}   presser — 1차 압박 선수 객체 (basePosition 필요)
 * @param {Object}   player  — 커버 쉬프트를 적용할 현재 선수
 */
export function computeCoveringShift(target, presser, player) {
  if (!presser?.basePosition) return target;
  const COVER_RADIUS = 20;
  const COVER_MIN = 0.20;
  const COVER_MAX = 0.30;
  const distToGap = player.position.sub(presser.basePosition).length();
  if (distToGap > COVER_RADIUS) return target;
  const proximity = 1 - distToGap / COVER_RADIUS;
  const strength = COVER_MIN + proximity * (COVER_MAX - COVER_MIN);
  return Vector2D.lerp(target, presser.basePosition, strength);
}

/** 우리 진영 방향 벡터/목표 (attackingDirection 1 = 오른쪽 공격 → 왼쪽 골문) */
function ownGoalCenter(team) {
  return Pitch.goalCenter(team.attackingDirection === 1 ? 'left' : 'right');
}

/** 점 p와 선분 a→b 사이의 거리/투영 계수 */
function segmentDistance(p, a, b) {
  const ab = b.sub(a);
  const lenSq = ab.lengthSq();
  let t = lenSq > 1e-6 ? p.sub(a).dot(ab) / lenSq : 0;
  t = clamp01(t);
  const proj = a.add(ab.scale(t));
  return { dist: p.sub(proj).length(), t };
}

// ═══════════════════════════════════════════════════════════════
// 수비 라인 정렬 (Defensive Line Alignment)
//
// 같은 라인(CB, LB, RB)의 X좌표 분산(σx)을 최소화한다.
// 공의 X좌표를 기준으로 수비 라인 목표 X를 산출하고, 개별 선수의 X를
// 라인 평균 X 쪽으로 보정하여 일직선 수비를 유지한다.
// ═══════════════════════════════════════════════════════════════
const DEF_LINE_ROLES = new Set(['CB', 'LB', 'RB']);

export function alignDefensiveLine(targetX, player, team, ball) {
  if (!DEF_LINE_ROLES.has(player.role)) return targetX;

  const linemates = team.players.filter(p => DEF_LINE_ROLES.has(p.role) && p !== player);
  if (linemates.length === 0) return targetX;

  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const ballDistFromGoal = Math.abs(ball.position.x - ownGoalX);
  let baseLineX = ownGoalX + attackDir * Math.min(ballDistFromGoal * 0.65, 35);

  // 측면 돌파 대응: 상대 윙어가 터치라인을 타고 골라인(오프사이드 라인)까지
  // 돌파하려 할 때, 수비 라인을 돌파자보다 더 깊게(골 쪽으로) 내린다.
  // 높게 유지하면 돌파자 뒤 공간으로 컷백·스루 패스를 허용하기 때문.
  const carrier = ball.owner;
  if (carrier && carrier.team !== team && carrier.brainMemory?.flankBreakthrough) {
    const carrierDepth = Math.abs(carrier.position.x - ownGoalX);
    // 돌파자보다 4m 뒤(골 쪽)에 라인을 두되, 최소 8m 깊이는 유지한다.
    const sinkDepth = Math.max(8, Math.min(carrierDepth - 4, 30));
    const sinkX = ownGoalX + attackDir * sinkDepth;
    baseLineX = attackDir === 1 ? Math.min(baseLineX, sinkX) : Math.max(baseLineX, sinkX);
  }

  // 자기 진영 루즈볼: 소유자 없는 공이 우리 진영에서 수비 라인보다 골 쪽(아래)으로
  // 흘러 들어오면 라인 전체를 공 뒤(골 쪽)로 내려 안전하게 커버한다. 높은 라인을
  // 유지하면 라인 뒤 공간으로 역습·슈팅을 허용하기 때문.
  if (!carrier && ballDistFromGoal < Pitch.LENGTH * 0.5) {
    const ballXDepth = Math.abs(ball.position.x - ownGoalX);
    const looseInBehind = attackDir === 1
      ? ball.position.x < baseLineX
      : ball.position.x > baseLineX;
    if (looseInBehind) {
      // 공보다 3m 아래(골 쪽)에 라인을 두되, 최소 6m 깊이는 유지한다.
      const looseDepth = Math.max(6, ballXDepth - 3);
      const looseX = ownGoalX + attackDir * looseDepth;
      baseLineX = attackDir === 1 ? Math.min(baseLineX, looseX) : Math.max(baseLineX, looseX);
    }
  }

  const lineXs = linemates.map(p => p.position.x);
  lineXs.push(targetX);
  const avgX = lineXs.reduce((s, x) => s + x, 0) / lineXs.length;

  // σx를 줄이기 위해 라인 평균 X로 보정 (강도 0.55)
  const aligned = targetX + (avgX - targetX) * 0.55;
  // 볼 기반 라인 깊이에도 끌어당기기 (강도 0.25)
  return aligned + (baseLineX - aligned) * 0.25;
}

/**
 * Stage 3: DEFENDING 상태 선수의 목표 좌표 계산
 *
 *  - 수비 반경(Zone) 내 상대 공격수를 자기 기본 위치 기준으로 찾는다
 *  - 최우선: 공 소유자 → 마크 대상의 패스 레이 위에 서는 커버 섀도우 위치
 *    (이미 팀원이 그 레이를 막고 있으면 제외)
 *  - 차선: 상대 공격수와 우리 골대 사이(Goal-side) 대인 마크 위치
 */
export function computeDefensiveTarget({ player, team, opponentTeam, ball, baseTarget }) {
  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const ownGoal = ownGoalCenter(team);
  const carrier = ball.owner;

  // 수비 반경 내 상대 공격수 스캔 (자기 기본 위치 기준 16m)
  const markCandidates = [];
  for (const o of opponentTeam.players) {
    if (o.role === 'GK' || o === carrier) continue;
    const d = o.position.sub(player.basePosition).length();
    if (d < 16) markCandidates.push({ opp: o, d });
  }
  markCandidates.sort((a, b) => a.d - b.d);

  if (markCandidates.length === 0) {
    let blockTarget = baseTarget;
    const alignedX = alignDefensiveLine(blockTarget.x, player, team, ball);
    if (alignedX !== blockTarget.x) {
      blockTarget = new Vector2D(alignedX, blockTarget.y);
    }
    return { target: blockTarget, markTarget: null, behavior: 'BLOCK' };
  }

  // ── 커버 섀도우 (최우선 가중치) ──────────────────────────────
  // 공을 가진 상대(carrier)와 마크 대상(opp)을 잇는 직선 위에 서서
  // 패스 경로를 물리적으로 차단한다.
  if (carrier && carrier.team !== team) {
    const threatening = markCandidates
      .map(({ opp, d }) => {
        const danger = clamp01(1 - Math.abs(opp.position.x - ownGoalX) / 40);
        return { opp, d, danger };
      })
      .sort((a, b) => b.danger - a.danger);

    for (const cand of threatening) {
      const ray = cand.opp.position.sub(carrier.position);
      const len = ray.length();
      if (len < 1e-3) continue;

      // carrier→opp 직선 위, opp에서 carrier 쪽으로 30% 지점에 서서 패스를 차단
      const shadowT = Math.max(0.3, 1 - 3.0 / len);
      const cover = carrier.position.add(ray.scale(shadowT));

      const coveredByTeammate = team.outfieldPlayers.some(
        (t2) => t2 !== player && segmentDistance(t2.position, carrier.position, cand.opp.position).dist < 1.6
      );
      if (coveredByTeammate) continue;

      if (player.position.sub(cover).length() < 15) {
        return {
          target: Pitch.clampInside(cover, 1.2),
          markTarget: cand.opp,
          behavior: 'COVER_SHADOW',
        };
      }
    }
  }

  // ── 대인 마크: 상대 공격수와 우리 골대 사이(Goal-side) ──────
  const mark = markCandidates[0];
  const danger = clamp01(1 - Math.abs(mark.opp.position.x - ownGoalX) / 40);
  const toOwnGoal = ownGoal.sub(mark.opp.position).normalize();
  const goalSide = mark.opp.position.add(toOwnGoal.scale(3.0 + danger * 2.5));
  const tightness = 0.35 + danger * 0.4;

  let markTarget = Pitch.clampInside(Vector2D.lerp(baseTarget, goalSide, tightness), 1.2);
  // 수비 라인 정렬: CB/LB/RB는 X좌표를 라인 평균으로 보정
  const alignedX = alignDefensiveLine(markTarget.x, player, team, ball);
  if (alignedX !== markTarget.x) {
    markTarget = new Vector2D(alignedX, markTarget.y);
  }

  return {
    target: markTarget,
    markTarget: mark.opp,
    behavior: 'MARKING',
  };
}