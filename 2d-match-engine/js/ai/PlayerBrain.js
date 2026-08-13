import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { computeSupportPosition } from './OffTheBallMovement.js';
import { findPressers, computePresserTarget, computeCutoffTarget, computeDefensiveTarget } from './Defending.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function moveIntent(target, sprint = false, speedFactor = null) {
  return { type: 'MOVE', target, sprint, speedFactor };
}

function segmentPointInfo(p, a, b) {
  const ab = b.sub(a);
  const t = clamp01(p.sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6));
  const proj = a.add(ab.scale(t));
  return { dist: p.sub(proj).length(), t };
}

function isPassingLaneBlocked(from, to, opponents) {
  return opponents.some((o) => {
    const { dist, t } = segmentPointInfo(o.position, from, to);
    return dist < 1.8 && t > 0.08 && t < 0.92;
  });
}

/**
 * 전방 빈 공간 탐색 — 상대 골문 방향 부채꼴(±30°, 반경 rClear m) 내
 * 수비수가 없으면 true (클리어 패스 통로 존재).
 * U_goal = 공격 방향 단위벡터, 내적이 cos(30°)를 초과하면 부채꼴 안.
 */
const CONE_COS = Math.cos(Math.PI / 6); // cos(30°) ≈ 0.866

function hasClearPath(player, opponentTeam, attackDir, rClear) {
  const goalDir = attackDir === 1 ? new Vector2D(1, 0) : new Vector2D(-1, 0);
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const toOpp = o.position.sub(player.position);
    const dist = toOpp.length();
    if (dist > rClear || dist < 0.3) continue;
    if (toOpp.normalize().dot(goalDir) > CONE_COS) return false; // 부채꼴 내 수비수 존재
  }
  return true;
}

/**
 * 드리블 스탯·창의성 기반 전방 탐색 반경 R_clear (m).
 * 고스탯 선수(윙어 등)는 rClear가 짧아 수비수가 가까워도 과감히 돌파.
 * 저스탯 선수는 rClear가 길어 넓은 공간이 있을 때만 드리블 시도.
 */
function computeRClear(player) {
  const drib    = player.attributes.dribbling / 100;
  const selfish = Math.max(0, drib * 0.6 + ((player.brainMemory?.creativity ?? 0.5) - 0.5) * 0.4);
  return Math.max(6, 14 - drib * 6 - selfish * 1.5);
  // drib=0.8 → ~9m(공격적), drib=0.4 → ~12m(신중), drib=0.2 → ~14m(보수적)
}

const BALL_FRICTION = 2.4; // PhysicsEngine.BALL_ROLL_FRICTION과 동기화

function computeInterceptionPoint(ball, player) {
  const ballSpeed = ball.velocity.length();
  if (ballSpeed < 0.5) return ball.position.clone();
  const ballDir = ball.velocity.normalize();
  const stopTime = ballSpeed / BALL_FRICTION;
  const playerSpeed = player.maxSpeed;

  for (let t = 0.1; t <= Math.min(stopTime, 3.0); t += 0.1) {
    const dist = ballSpeed * t - 0.5 * BALL_FRICTION * t * t;
    const futurePos = ball.position.add(ballDir.scale(Math.max(0, dist)));
    if (player.position.sub(futurePos).length() <= playerSpeed * t * 1.05) {
      return futurePos;
    }
  }
  const finalDist = ballSpeed * stopTime - 0.5 * BALL_FRICTION * stopTime * stopTime;
  return ball.position.add(ballDir.scale(Math.max(0, finalDist)));
}

export function decidePlayerIntent(ctx) {
  const { player, team, ball } = ctx;

  // 태클 패배 멈칫(Stun/Delay): 잠시 행동 불가
  const stun = player.brainMemory.stunTimer ?? 0;
  if (stun > 0) {
    player.brainMemory.stunTimer = Math.max(0, stun - ctx.dt);
    return { type: 'HOLD' };
  }

  if (player.role === 'GK') return decideGoalkeeper(ctx);
  if (player.hasBall) return decideBallCarrier(ctx);

  if (ball.passTargetPlayer === player && !ball.owner) {
    const intercept = computeInterceptionPoint(ball, player);
    const distToIntercept = player.position.sub(intercept).length();
    const ballSpeed = ball.velocity.length();

    // 능동적 마중 움직임(Come-Short): 느린 패스이거나 수비수가 공에 가까울 때
    // 교차점에서 기다리지 않고 공을 향해 달려 나간다
    const opponentTeam = ctx.opponentTeam;
    let nearestOppDist = Infinity;
    if (opponentTeam) {
      for (const o of opponentTeam.players) {
        if (o.role === 'GK') continue;
        const d = o.position.sub(intercept).length();
        if (d < nearestOppDist) nearestOppDist = d;
      }
    }
    const slowPass = ballSpeed < 6;
    const defenderClosing = nearestOppDist < 6;
    const shouldComeShort = slowPass || defenderClosing;

    if (shouldComeShort) {
      // 현재 공 위치를 향해 역방향 가속 — 공과 선수가 중간 지점에서 만난다
      const toBall = ball.position.sub(player.position);
      const meetPoint = player.position.add(toBall.scale(0.6));
      if (toBall.length() > 0.3) player.desiredFacingAngle = toBall.angle();
      return moveIntent(meetPoint, true);
    }

    if (distToIntercept <= 1.2) {
      const toBall = ball.position.sub(player.position);
      if (toBall.length() > 0.3) {
        player.desiredFacingAngle = toBall.angle();
      }
      return { type: 'HOLD' };
    }
    return moveIntent(intercept, true);
  }

  if (!ball.owner) {
    const distToBall = player.position.sub(ball.position).length();
    const closestTeammate = findClosestToBall(team.players, ball);
    // 파리/편향 후 루즈볼: lastTouchedTeam이 null이면 양팀 모두 적극적으로 볼을 쫓는다
    const hotLooseBall = !ball.lastTouchedTeam && ball.velocity.length() > 2;
    const chaseRadius = hotLooseBall ? 20 : 5.0;
    if ((closestTeammate === player || distToBall < chaseRadius) && distToBall < 35) {
      const intercept = computeInterceptionPoint(ball, player);
      return moveIntent(intercept, true);
    }
    const inPossession = ball.lastTouchedTeam === team;
    const supportPos = computeSupportPosition({ player, team, ball, inPossession });
    const dist = player.position.sub(supportPos).length();
    const sf = dist > 14 ? 0.85 : dist > 5 ? 0.65 : 0.45;
    return moveIntent(supportPos, false, sf);
  }

  if (ball.owner.team === team) {
    const supportPos = computeSupportPosition({
      player, team, ball, inPossession: true, opponentTeam: ctx.opponentTeam,
    });
    const sprint = player.brainMemory.offBallSprint ?? false;
    const dist = player.position.sub(supportPos).length();
    const sf = sprint ? null : (dist > 14 ? 0.85 : dist > 5 ? 0.65 : 0.45);
    return moveIntent(supportPos, sprint, sf);
  }

  return decideDefensiveOffBall(ctx);
}

function findClosestToBall(players, ball) {
  let best = null;
  let bestDist = Infinity;
  for (const p of players) {
    const d = p.position.sub(ball.position).length();
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════
// Stage 1: 상황 인식 — 압박 수치(Pressure Score, 0~100)
//
// 역제곱 가중치 모델: P = Σ (w / d²)
// 수비수가 가까울수록 기하급수적으로 압박감이 높아진다.
// w = 기본 가중치(1.0) × 방향 보정(수비수가 공을 향하면 최대 1.5배)
// ═══════════════════════════════════════════════════════════════
const PRESS_RADIUS = 12;
const PRESS_W_BASE = 18;

function computePressureScore(player, opponentTeam) {
  let raw = 0;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const toBall = player.position.sub(o.position);
    const dist = toBall.length();
    if (dist > PRESS_RADIUS || dist < 0.3) continue;

    let heading = o.velocity;
    if (heading.length() < 0.3) heading = Vector2D.fromAngle(o.facingAngle);
    const dirFactor = Math.max(0, heading.normalize().dot(toBall.normalize()));
    const w = PRESS_W_BASE * (1.0 + dirFactor * 0.5);
    raw += w / (dist * dist);
  }
  return Math.round(Math.min(100, (1 - Math.exp(-raw * 0.28)) * 110));
}

// ═══════════════════════════════════════════════════════════════
// Stage 2: 슈팅 판단
//
//  - 유효 슈팅 사거리(28m) 이내인지 확인
//  - 골대 양 기둥을 잇는 삼각 시야(Cone)의 각도와, 골대 방향 레이 위/주변의
//    차단 수비수 수를 Raycasting으로 계산해 슈팅 유틸리티(0~1)를 산출한다.
// ═══════════════════════════════════════════════════════════════
const SHOOT_RANGE = 22;
/** 드리블로 접근할 수 있는 상대 골라인 최소 거리 — 골키퍼 뒤로 몰고 가는 현상 방지 */
const MIN_DRIBBLE_DIST_FROM_GOAL_LINE = 9;
/** 이 거리 안에서는 드리블 목표를 골라인 방향이 아니라 페널티 스팟 쪽으로 잡는다 */
const BYLINE_REDIRECT_DIST = 18;

function evaluateShotOpportunity(player, opponentTeam, attackDir) {
  const goalCenter = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
  const [topY, bottomY] = Pitch.goalYRange();
  const goalX = goalCenter.x;
  const distToGoal = player.position.sub(goalCenter).length();

  // 골대 양 기둥과 선수를 잇는 시야각 (라디안)
  const toTop = new Vector2D(goalX - player.position.x, topY - player.position.y);
  const toBottom = new Vector2D(goalX - player.position.x, bottomY - player.position.y);
  const angleOpen = Math.abs(toTop.angle() - toBottom.angle());

  // 골대 방향 레이캐스팅: 경로상(반경 1.8m)에 서 있는 수비수 = 차단자
  let blockers = 0;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const { dist, t } = segmentPointInfo(o.position, player.position, goalCenter);
    if (dist < 1.8 && t > 0.05 && t < 0.97) blockers++;
  }

  const rangeFactor = clamp01((SHOOT_RANGE - distToGoal) / 12);
  const openness = clamp01(angleOpen / 0.55);
  const shooterQuality = 0.6 + (player.attributes.shooting / 100) * 0.6;
  const roleFactor = player.role === 'ST' ? 1.15 : player.role === 'CB' || player.role === 'LB' || player.role === 'RB' ? 0.45 : 0.85;

  // 1v1(GK만 남은 클린 찬스) 보너스
  const clearShot = blockers === 0;
  let score = clamp01(rangeFactor * openness * shooterQuality * roleFactor * (1 - Math.min(1, blockers * 0.45)));
  if (clearShot && distToGoal < 16.5) score = clamp01(score + 0.3);

  return { score, distToGoal, angleOpen, blockers, clearShot, goalCenter };
}

// ═══════════════════════════════════════════════════════════════
// Stage 3: 패스 판단 — 패스 가치(Pass Value) 점수 시스템
//
//  THROUGH (높은 점수): OFF_BALL_ATTACK 상태(PENETRATING)로 수비라인 뒷공간을
//                        침투 중인 동료 + 경로가 막히지 않음
//  FORWARD (중간 점수): 나보다 상대 골대에 가까운 윙어/미드필더가 비어 있음
//  SAFE    (낮은 점수): 압박이 심해 빠르게 뒤로 빼야 할 때, 안전한 백패스
// 시야(vision) 능력치가 낮으면 스루패스 옵션 자체를 인식하지 못할 수 있다.
// ═══════════════════════════════════════════════════════════════
function isBehindDefensiveLine(teammate, opponentTeam, attackDir) {
  const oppOutfield = opponentTeam.players.filter((p) => p.role !== 'GK');
  if (oppOutfield.length === 0) return false;
  const lastDefX = attackDir === 1
    ? Math.max(...oppOutfield.map((p) => p.position.x))
    : Math.min(...oppOutfield.map((p) => p.position.x));
  return attackDir === 1 ? teammate.position.x > lastDefX : teammate.position.x < lastDefX;
}

// 거리 페널티 상수
const DIST_DECAY_K = 0.055;   // S_final = S_base / (1 + k * d)
const D_MAX_LONG = 32;         // 이 거리 이상은 longPass 스탯이 높아야 가능

function evaluatePassOptions(player, team, opponentTeam) {
  const attackDir = team.attackingDirection;
  const goalPos = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
  const isWinger = player.role === 'LM' || player.role === 'RM';
  const wingY = player.role === 'LM' ? Pitch.WIDTH * 0.15 : Pitch.WIDTH * 0.85;
  const vision = (player.attributes.vision ?? player.attributes.positioning) / 100;
  const passingStat = player.attributes.passing;
  const options = [];

  // 시야 능력치 기반 패스 스캔 반경: 높은 비전일수록 더 먼 동료를 인식한다
  const visionStat = player.attributes.vision ?? player.attributes.positioning;
  const maxScanDist = 22 + visionStat * 0.26;  // vision 40→32m, 90→45m

  for (const teammate of team.players) {
    if (teammate === player || teammate.role === 'GK') continue;
    const dist = teammate.position.sub(player.position).length();
    if (dist > maxScanDist || dist < 3) continue;
    // 롱패스 차단: passing < 72면 32m 이상 동료를 패스 대상에서 제외
    if (dist > D_MAX_LONG && passingStat < 72) continue;

    const forwardProgress = (teammate.position.x - player.position.x) * attackDir;
    const nearReceiver = opponentTeam.players.filter(
      (o) => o.role !== 'GK' && o.position.sub(teammate.position).length() < 6
    ).length;
    const blocked = isPassingLaneBlocked(player.position, teammate.position, opponentTeam.players);
    const open = nearReceiver === 0 && !blocked;

    // 옵션 유형 분류
    const penetrating = teammate.brainMemory?.offBallBehavior === 'PENETRATING';
    const behindDef = isBehindDefensiveLine(teammate, opponentTeam, attackDir);
    let type = 'SAFE';
    if (penetrating || (behindDef && open && dist > 10)) type = 'THROUGH';
    else if (open && forwardProgress > 4) type = 'FORWARD';

    // 시야가 낮으면 위험한 스루/전진 옵션을 놓친다
    if ((type === 'THROUGH' || (type === 'FORWARD' && forwardProgress > 15)) && Math.random() > vision * 0.9) {
      type = 'SAFE';
    }

    // 스루패스 미래 위치: PENETRATING 동료의 1.5초 뒤 예상 위치(빈 공간)를 패스 목표로 설정
    let futurePos = null;
    if (type === 'THROUGH' && penetrating) {
      const offBallTarget = teammate.brainMemory?.offBallTarget;
      if (offBallTarget) {
        // offBallTarget(침투 목표 좌표)과 현재 위치를 보간해 1.5초 뒤 예상 지점 산출
        const toTarget = offBallTarget.sub(teammate.position);
        const maxReach = teammate.maxSpeed * 1.5;
        const reachDist = Math.min(toTarget.length(), maxReach);
        futurePos = reachDist > 0.5
          ? teammate.position.add(toTarget.normalize().scale(reachDist))
          : offBallTarget.clone();
      } else if (teammate.velocity.length() > 0.5) {
        futurePos = teammate.position.add(teammate.velocity.normalize().scale(
          Math.min(teammate.velocity.length() * 1.5, teammate.maxSpeed * 1.5)
        ));
      }
    }

    // 시야 높은 선수는 스루패스 경로를 더 잘 찾아 우선순위 부여
    const visionBonus = type === 'THROUGH' ? Math.round((visionStat - 50) * 0.35) : 0;
    const typeBase = (type === 'THROUGH' ? 65 : type === 'FORWARD' ? 35 : 18) + visionBonus;

    const isAttacker = teammate.role === 'ST' || teammate.role === 'LM' || teammate.role === 'RM';
    const attackerBonus = isAttacker ? 10 : 0;
    const isMidfield = teammate.role === 'CM';
    const midfieldBonus = isMidfield && forwardProgress > 5 ? 5 : 0;

    const receiverDistToGoal = teammate.position.sub(goalPos).length();
    const senderDistToGoal = player.position.sub(goalPos).length();
    const progressToGoal = Math.max(0, senderDistToGoal - receiverDistToGoal);

    let wingBonus = 0;
    if (isWinger && Math.abs(player.position.y - wingY) < 10) {
      if (teammate.role === 'ST') wingBonus = 15;
      else if (teammate.role === 'CM') wingBonus = 8;
    }

    let score =
      typeBase +
      forwardProgress * 1.5 +
      progressToGoal * 2.0 +
      midfieldBonus +
      attackerBonus +
      wingBonus -
      nearReceiver * 8 -
      (blocked ? 15 : 0) +
      team.tactics.directnessBias * forwardProgress * 0.4;

    // 거리 감쇠 (Distance Decay): S_final = S_base / (1 + k * d)
    // 멀수록 점수 급락 → 숏패스 우선, 무리한 롱패스 억제
    score = score / (1 + DIST_DECAY_K * dist);

    options.push({ player: teammate, score, distance: dist, forwardProgress, open, type, futurePos });
  }
  return options;
}

// ═══════════════════════════════════════════════════════════════
// Stage 4: 드리블 판단 — 수비수 회피(Avoidance) 전진 벡터
//
// 슛도 패스도 어렵고 전방 빈 공간이 열렸을 때, 가장 가까운 수비수를 피하면서
// 상대 골대를 향해 전진하는 드리블 타겟을 계산한다.
// ═══════════════════════════════════════════════════════════════
function evaluateDribble(player, team, opponentTeam, pressure) {
  const goalPos = Pitch.goalCenter(team.attackingDirection === 1 ? 'right' : 'left');
  const target = pickDribbleTarget(player, team, opponentTeam, goalPos);

  const noOpponentAhead = hasClearPath(player, opponentTeam, team.attackingDirection, computeRClear(player));
  const dribblingStat = player.attributes.dribbling / 100;
  const creativityBonus = (player.brainMemory.creativity - 0.5) * 0.35;

  let utility;
  if (noOpponentAhead) {
    utility = 1.0 + creativityBonus;
  } else {
    // 수비수가 있어도 드리블 능력+창의성이 높으면 개인 돌파를 시도한다 (이기심 계수)
    const selfishness = dribblingStat * 0.60 + (player.brainMemory.creativity - 0.3) * 0.50;
    utility = 0.30 + selfishness * 0.75;
  }
  utility -= pressure / 260;

  return { utility, target, noOpponentAhead };
}

// ═══════════════════════════════════════════════════════════════
// Stage 5: 능력치·압박 기반 실수(RNG/Error)는 ActionExecutor에서 실행한다.
// 여기서는 SHOOT / PASS / DRIBBLE 중 하나를 유틸리티 가중치로 결정하고,
// 시각 디버깅용 debugIntent를 brainMemory에 기록한다.
// ═══════════════════════════════════════════════════════════════
function decideBallCarrier(ctx) {
  const { player, team, opponentTeam, dt } = ctx;
  const mem = player.brainMemory;

  mem.possessionTimer = (mem.possessionTimer ?? 0) + dt;

  if (mem.controlTimer > 0) {
    mem.controlTimer -= dt;
    mem.debugIntent = null;
    return { type: 'MOVE', target: player.position.clone(), sprint: false };
  }

  if (mem.decisionCooldown > 0) {
    mem.decisionCooldown -= dt;
    if (mem.lastIntent) return mem.lastIntent;
  }
  // 판단 주기를 늘려 매 프레임 마음이 바뀌는 산만한 플레이를 줄인다
  mem.decisionCooldown = 0.35 + Math.random() * 0.35;

  const attackDir = team.attackingDirection;

  // 볼을 잡은 직후 1.2초 동안은 패스보다 운반(드리블)을 선호한다 — 탁구 패스 방지
  const settleFactor = clamp01((mem.possessionTimer - 0.2) / 1.2);

  // ── Stage 1: 압박 수치 계산 ────────────────────────────────
  const pressure = computePressureScore(player, opponentTeam);
  mem.pressureScore = pressure;

  // 클리어링: 수비수가 자기 페널티 박스 근처에서 강한 압박을 받을 때만 걷어낸다.
  // (임계값이 낮으면 여유가 있는데도 뜬금없이 볼을 걷어차 버린다)
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const distFromOwnGoal = Math.abs(player.position.x - ownGoalX);
  const isDefender = player.role === 'CB' || player.role === 'LB' || player.role === 'RB';
  if (isDefender && distFromOwnGoal < 22 && pressure >= 48) {
    mem.lastIntent = { type: 'CLEAR', pressure };
    mem.debugIntent = null;
    return mem.lastIntent;
  }

  // ── Stage 2: 슈팅 판단 ─────────────────────────────────────
  const shot = evaluateShotOpportunity(player, opponentTeam, attackDir);
  const canShootNow = shot.distToGoal < SHOOT_RANGE && shot.angleOpen > 0.11 && (shot.clearShot || pressure < 60);
  // rangeFactor: 22m에서 0, 10m 이내에서 1.0 — 제곱을 적용해 장거리 슛 확률을 급감시킨다
  const rangeFactor = clamp01((SHOOT_RANGE - shot.distToGoal) / 12);
  const creativeBonus = (mem.creativity - 0.5) * 0.2;
  const baseShootProb = clamp01(
    (rangeFactor * rangeFactor * (0.6 + (player.attributes.shooting / 100) * 0.6) *
      (player.role === 'ST' ? 1.15 : isDefender ? 0.45 : 0.85) * (0.75 + shot.angleOpen * 0.6) +
      creativeBonus * rangeFactor) * 0.35
  );
  // 노마크 찬스여도 거리에 따라 급격히 감소 (25m 노마크 = 거의 안 참)
  const clearShotUtility = clamp01(rangeFactor * rangeFactor * 0.9);
  const shootUtility = canShootNow
    ? (shot.clearShot ? Math.max(clearShotUtility, baseShootProb) : baseShootProb) * (1 + pressure / 400)
    : 0;

  // 골문 근처에서 각이 확실히 열려 있으면 무조건 슛 — 골키퍼 뒤로 몰고 가는 현상 방지
  const inShootingBox = shot.distToGoal < 12 && shot.angleOpen > 0.30;
  if (inShootingBox && (shot.clearShot || pressure < 70)) {
    const intent = { type: 'SHOOT', pressure };
    mem.debugIntent = { type: 'SHOOT', target: shot.goalCenter.clone() };
    mem.lastIntent = intent;
    return intent;
  }

  // ── 전방 빈 공간 탐색: Cone이 비었으면 드리블 강제 전환 (Decision Override) ──────
  // 패스 점수 계산을 건너뛰고 즉시 DRIBBLE 상태로 강제 전환한다.
  // 조건: ±30° 부채꼴(반경 rClear) 안에 수비수 0명 + 슈팅 박스 밖 + 고압박 아님(<65)
  const rClearVal = computeRClear(player);
  if (hasClearPath(player, opponentTeam, attackDir, rClearVal) &&
      !inShootingBox && !(canShootNow && shot.clearShot) && pressure < 65) {
    const overrideGoal   = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
    const overrideTarget = pickDribbleTarget(player, team, opponentTeam, overrideGoal);
    mem.debugIntent = { type: 'DRIBBLE', target: overrideTarget.clone() };
    mem.lastIntent  = { type: 'MOVE', target: overrideTarget, sprint: true, pressure };
    return mem.lastIntent;
  }

  // ── 볼 보유 최소 시간 (Retention Timer) — 탁구 패스 FSM ─────
  // tMin(1.0~1.5s)이 지나야 패스 허용. P_CRITICAL 이상이면 즉시 긴급 패스 가능.
  const P_CRITICAL = 70;
  const canPass = mem.possessionTimer >= (mem.tMin ?? 1.0) || pressure >= P_CRITICAL;

  // ── Stage 3: 패스 판단 ─────────────────────────────────────
  // 패스는 ① 열린 수신자+높은 스코어(품질 패스) ② 스루패스 ③ 고압박으로 불가피할 때만 우선
  const passOptions = evaluatePassOptions(player, team, opponentTeam);
  const bestOption = passOptions.length > 0
    ? passOptions.reduce((a, b) => (b.score > a.score ? b : a))
    : null;
  const passQuality = bestOption ? bestOption.score : 0;
  const passIsQuality = bestOption && ((bestOption.open && passQuality > 55) || bestOption.type === 'THROUGH');
  const passForced = pressure > 60;
  // settleFactor: 볼을 잡은 직후에는 패스 가치를 크게 깎아 곧바로 되받아 차지 않게 한다
  // canPass: tMin 이전에는 패스 유틸리티 자체를 0으로 차단 (긴급 상황 제외)
  const passUtility = bestOption && canPass
    ? clamp01(passQuality / 260) * (passForced ? 1.5 : passIsQuality ? 0.85 : 0.14) *
      (pressure > 50 ? 1.3 : 1) * (passForced ? 1 : 0.25 + settleFactor * 0.75)
    : 0;

  // ── Stage 4: 드리블 판단 ───────────────────────────────────
  const dribble = evaluateDribble(player, team, opponentTeam, pressure);

  // ── Pressure Threshold 기반 강제 행동 ──────────────────────────
  // 이기적 성향(드리블 스탯↑ + 창의성↑ + 판단력↓)이면 더 오래 드리블을 고집한다.
  const dribStat = player.attributes.dribbling / 100;
  const decStat = (player.attributes.decisionMaking ?? 70) / 100;
  const selfishness = Math.max(0, dribStat * 0.6 + (mem.creativity - 0.5) * 0.4 - decStat * 0.3);
  const DRIBBLE_THRESHOLD = 20 + Math.round(selfishness * 15);   // 20~27.5
  const PASS_FORCE_THRESHOLD = 65 + Math.round(selfishness * 20); // 65~77

  if (pressure < DRIBBLE_THRESHOLD && dribble.noOpponentAhead && !canShootNow) {
    const intent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    mem.debugIntent = { type: 'DRIBBLE', target: dribble.target.clone() };
    mem.lastIntent = intent;
    return intent;
  }

  if (pressure >= PASS_FORCE_THRESHOLD && bestOption && !inShootingBox && !canShootNow && settleFactor > 0.3 && canPass) {
    const safeOptions = passOptions.filter(o => o.open && o.score > 20);
    const safeBest = safeOptions.length > 0
      ? safeOptions.reduce((a, b) => b.score > a.score ? b : a)
      : bestOption;
    const isThrough = safeBest.type === 'THROUGH' && safeBest.futurePos;
    const intent = {
      type: 'PASS',
      targetPlayer: safeBest.player,
      targetPos: isThrough ? safeBest.futurePos : null,
      lofted: isThrough || safeBest.distance > 25,
      pressure,
    };
    mem.lastIntent = intent;
    mem.debugIntent = { type: 'PASS', target: (isThrough ? safeBest.futurePos : safeBest.player.position).clone() };
    return intent;
  }

  // ── Cross check: 측면 깊은 지역에서는 각도가 없으므로 박스로 크로스 ──────
  {
    const opGX = attackDir === 1 ? Pitch.LENGTH : 0;
    const distGL = Math.abs(player.position.x - opGX);
    // 측면 판정: 윙어는 자기 쪽 측면, 그 외에는 좌우 어느 쪽이든 터치라인 근처
    const onFlank = player.role === 'LM'
      ? player.position.y < Pitch.WIDTH * 0.30
      : player.role === 'RM'
        ? player.position.y > Pitch.WIDTH * 0.70
        : player.position.y < Pitch.WIDTH * 0.24 || player.position.y > Pitch.WIDTH * 0.76;
    if (onFlank && distGL < Pitch.PENALTY_BOX_LENGTH + 10 && !canShootNow && canPass) {
      const [gTopY, gBottomY] = Pitch.goalYRange();
      const crossX = attackDir === 1 ? Pitch.LENGTH - 9 : 9;
      const crossTarget = new Vector2D(crossX, (gTopY + gBottomY) / 2);
      const receivers = team.players.filter((p) =>
        p !== player && p.role !== 'GK' &&
        Math.abs(p.position.x - opGX) < Pitch.PENALTY_BOX_LENGTH + 4
      );
      if (receivers.length > 0) {
        const recv = receivers.reduce((a, b) =>
          a.position.sub(crossTarget).length() < b.position.sub(crossTarget).length() ? a : b
        );
        const intent = { type: 'PASS', targetPlayer: recv, targetPos: crossTarget, lofted: true, pressure };
        mem.lastIntent = intent;
        mem.debugIntent = { type: 'CROSS', target: crossTarget.clone() };
        return intent;
      }
    }
  }

  // ── 파이널 서드 예외 로직 (상대 페널티 박스 근처) ──────────
  const opponentGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const distToOpponentGoal = Math.abs(player.position.x - opponentGoalX);
  const isInFinalThird = distToOpponentGoal < Pitch.PENALTY_BOX_LENGTH + 5.5;

  let effectiveShootUtility = shootUtility;
  let effectivePassUtility = passUtility;
  let effectiveDribbleUtility = dribble.utility;
  let effectiveBestOption = bestOption;

  if (isInFinalThird) {
    // 슈팅/드리블 확률 부스트; 단 슈팅 하한선도 거리에 비례시켜 장거리 남발을 막는다
    // 하한선은 "페널티 박스 안 + 막는 사람이 없는 확실한 찬스"에만 적용한다.
    // 박스 밖에서 수비수를 앞에 두고 무리하게 때리는 슛을 줄인다.
    const floor = canShootNow && shot.clearShot && shot.distToGoal < Pitch.PENALTY_BOX_LENGTH
      ? 0.4 * rangeFactor
      : 0;
    effectiveShootUtility = Math.max(shootUtility, floor) * 1.8;
    effectiveDribbleUtility = dribble.utility * 2.2;
    // 패스는 전진/측면(백패스 금지) + 단거리만 허용
    const finalThirdOptions = passOptions.filter(
      (o) => o.forwardProgress >= -4 && o.distance < 22
    );
    effectiveBestOption = finalThirdOptions.length > 0
      ? finalThirdOptions.reduce((a, b) => (a.distance < b.distance ? a : b))
      : null;
    effectivePassUtility = effectiveBestOption ? passUtility * 0.3 : 0;
  }

  // ── Stage 5: 유틸리티 가중 랜덤 결정 + decisionMaking 노이즈 ──
  const dm = (player.attributes.decisionMaking ?? 70) / 100;
  const addNoise = (u) => Math.max(0, u + (Math.random() - 0.5) * (1 - dm) * 0.4);

  // 슛이 불가능한 상황(사거리 밖·각도 없음)에서는 판단 노이즈로도 슛이 나오지 않게 한다.
  // (노이즈만으로 슛이 선택되면 하프라인 부근에서 뜬금없이 장거리 슛을 때린다)
  const noisedShoot = canShootNow ? addNoise(effectiveShootUtility) : 0;
  const noisedPass = addNoise(effectivePassUtility);
  const noisedDribble = addNoise(effectiveDribbleUtility);
  const total = noisedShoot + noisedPass + noisedDribble;
  const roll = Math.random() * total;

  let intent;
  if (roll < noisedShoot) {
    intent = { type: 'SHOOT', pressure };
    mem.debugIntent = { type: 'SHOOT', target: shot.goalCenter.clone() };
  } else if (roll < noisedShoot + noisedPass && effectiveBestOption) {
    const isThrough = effectiveBestOption.type === 'THROUGH' && effectiveBestOption.futurePos;
    intent = {
      type: 'PASS',
      targetPlayer: effectiveBestOption.player,
      targetPos: isThrough ? effectiveBestOption.futurePos : null,
      lofted: isThrough || effectiveBestOption.distance > 25,
      pressure,
    };
    const debugTarget = isThrough
      ? effectiveBestOption.futurePos.clone()
      : effectiveBestOption.player.position.clone();
    mem.debugIntent = { type: 'PASS', target: debugTarget };
  } else if (noisedDribble > 0.05) {
    intent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    mem.debugIntent = { type: 'DRIBBLE', target: dribble.target.clone() };
  } else if (effectiveBestOption) {
    intent = { type: 'PASS', targetPlayer: effectiveBestOption.player, lofted: effectiveBestOption.distance > 25, pressure };
    mem.debugIntent = { type: 'PASS', target: effectiveBestOption.player.position.clone() };
  } else if (pressure === 0) {
    intent = { type: 'MOVE', target: player.position.clone(), sprint: false, speedFactor: 0.2 };
    mem.debugIntent = null;
  } else {
    intent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    mem.debugIntent = { type: 'DRIBBLE', target: dribble.target.clone() };
  }

  mem.lastIntent = intent;
  return intent;
}

function pickDribbleTarget(player, team, opponentTeam, goalPos) {
  const attackDirEarly = team.attackingDirection;
  const goalLineX = attackDirEarly === 1 ? Pitch.LENGTH : 0;
  const distToGoalLine = Math.abs(player.position.x - goalLineX);

  const aimPos = distToGoalLine < BYLINE_REDIRECT_DIST
    ? new Vector2D(goalLineX - attackDirEarly * Pitch.PENALTY_SPOT_DIST, Pitch.WIDTH / 2)
    : goalPos;

  // ── 드리블 회피 벡터 (Avoidance Dribble) ────────────────────
  // V_dribble = w1 * û_goal + w2 * V_avoid
  // V_avoid: 반경 내 수비수들의 역제곱 반발력 합산 (멀수록 약해짐)
  const AVOID_RADIUS = 9;
  let avoidVec = Vector2D.zero();
  let nearestDist = Infinity;
  let nearestOpp = null;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const toOpp = o.position.sub(player.position);
    const d = toOpp.length();
    if (d < nearestDist) { nearestDist = d; nearestOpp = o; }
    if (d < 0.5 || d > AVOID_RADIUS) continue;
    // 반발: 수비수 반대 방향으로 1/d² 비례 힘
    avoidVec = avoidVec.add(toOpp.normalize().scale(-1 / (d * d)));
  }
  const avoidMag = avoidVec.length();
  const avoidNorm = avoidMag > 1e-6 ? avoidVec.scale(1 / avoidMag) : Vector2D.zero();

  const goalDir = aimPos.sub(player.position).length() > 0.5
    ? aimPos.sub(player.position).normalize()
    : new Vector2D(-attackDirEarly, 0);

  // 수비수 밀집도에 따라 회피 비중(w2) 조절 (최대 0.75)
  const w1 = 0.65;
  const w2 = Math.min(0.75, avoidMag * 1.8);
  let steer = (avoidMag > 0.05)
    ? goalDir.scale(w1).add(avoidNorm.scale(w2)).normalize()
    : goalDir;

  const isWinger = player.role === 'LM' || player.role === 'RM';
  const centerY = Pitch.WIDTH / 2;
  const wingY = player.role === 'LM' ? Pitch.WIDTH * 0.1 : Pitch.WIDTH * 0.9;
  const pressFront = nearestOpp && nearestDist < 8;

  if (isWinger && pressFront) {
    if (Math.random() < 0.4) {
      steer = goalDir.scale(0.5).add(new Vector2D(0, centerY - player.position.y).normalize().scale(0.5)).normalize();
    } else {
      steer = goalDir.scale(w1).add(avoidNorm.scale(0.35)).normalize();
    }
  } else if (isWinger) {
    const isOnFlank = player.role === 'LM'
      ? player.position.y < Pitch.WIDTH * 0.35
      : player.position.y > Pitch.WIDTH * 0.65;
    if (isOnFlank && distToGoalLine >= BYLINE_REDIRECT_DIST) {
      const forwardDir = new Vector2D(team.attackingDirection, 0);
      const keepFlank = new Vector2D(0, Math.sign(wingY - player.position.y));
      steer = forwardDir.scale(0.82).add(keepFlank.scale(0.18)).normalize();
    } else if (isOnFlank) {
      steer = goalDir;
    } else {
      const sideDir = new Vector2D(0, Math.sign(wingY - player.position.y));
      steer = goalDir.scale(0.65).add(sideDir.scale(0.35)).normalize();
    }
  } else if (pressFront && Math.random() < 0.25) {
    // 페이크 무브: 가끔 측면으로 방향 전환해 수비수를 따돌린다
    const lateral = new Vector2D(-goalDir.y, goalDir.x).scale(Math.random() < 0.5 ? 1 : -1);
    steer = goalDir.scale(0.35).add(lateral.scale(0.5)).add(avoidNorm.scale(0.25)).normalize();
  }

  const dribbleDist = nearestOpp && nearestDist < 4
    ? 6 + Math.random() * 4
    : 10 + Math.random() * 10;
  let target = Pitch.clampInside(player.position.add(steer.scale(dribbleDist)), 1.5);

  // 상대 골라인 근처로는 몰고 가지 않는다 (골키퍼 뒤로 드리블해 나가는 현상 방지)
  const attackDir = team.attackingDirection;
  const opponentGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const limitX = opponentGoalX - attackDir * MIN_DRIBBLE_DIST_FROM_GOAL_LINE;
  const clampedX = attackDir === 1 ? Math.min(target.x, limitX) : Math.max(target.x, limitX);
  if (clampedX !== target.x) {
    // X를 잘라내는 대신 골문 중앙 쪽으로 방향을 틀어 슛 각도를 확보한다
    target = new Vector2D(clampedX, target.y * 0.55 + (Pitch.WIDTH / 2) * 0.45);
  }
  return target;
}

function decideDefensiveOffBall(ctx) {
  const { player, team, opponentTeam, ball } = ctx;
  const mem = player.brainMemory;
  const distToBall = player.position.sub(ball.position).length();
  const ownGoalX = team.attackingDirection === 1 ? 0 : Pitch.LENGTH;

  // Stage 2: 1차/2차 압박 선수 선정 (전술 압박 수치가 높으면 2명)
  const pressers = findPressers(team.outfieldPlayers, ball, team.tactics.pressing > 0.65 ? 2 : 1);

  if (pressers.includes(player)) {
    // 접근 각도: 공이 아니라 "공 → 우리 골대 사이" 경로를 막는 궤적으로 접근
    const pressTarget = pressers[0] === player
      ? computePresserTarget(ball, team, 0.18)
      : computeCutoffTarget(ball, team);
    const sprint = distToBall > 5;
    mem.defendBehavior = 'PRESSING';
    mem.markTarget = null;
    mem.pressTarget = pressTarget.clone();
    return moveIntent(pressTarget, sprint);
  }

  // Stage 1+3: 수비 블록(포메이션 후퇴/간격 축소) + 대인 마크/커버 섀도우
  const baseTarget = computeSupportPosition({ player, team, ball, inPossession: false });
  const defensive = computeDefensiveTarget({
    player, team, opponentTeam, ball, baseTarget,
  });
  mem.defendBehavior = defensive.behavior;
  mem.markTarget = defensive.markTarget;
  mem.pressTarget = null;

  const threatLevel = clamp01(1 - Math.abs(ball.position.x - ownGoalX) / 45);
  const dist = player.position.sub(defensive.target).length();
  const sf = dist > 12 ? 0.75 + threatLevel * 0.25 : 0.5 + threatLevel * 0.3;
  return moveIntent(defensive.target, false, sf);
}

function decideGoalkeeper(ctx) {
  const { player, team, ball, dt } = ctx;
  const mem = player.brainMemory;
  const ownGoalSide = team.attackingDirection === 1 ? 'left' : 'right';
  const goalX = ownGoalSide === 'left' ? 0 : Pitch.LENGTH;
  const [topY, bottomY] = Pitch.goalYRange();
  const centerY = (topY + bottomY) / 2;
  const outward = ownGoalSide === 'left' ? 1 : -1;

  if (player.hasBall) {
    mem.gkHoldTimer = (mem.gkHoldTimer ?? 0) + dt;
    if (mem.gkHoldTimer > 1.1) {
      mem.gkHoldTimer = 0;
      return decideGkDistribution(ctx);
    }
    return { type: 'HOLD' };
  }

  const distToGoalLine = Math.abs(ball.position.x - goalX);
  const distToBall = player.position.sub(ball.position).length();

  // 루즈볼 수집: 가까울 때만 (1v1 상황이 아니면 골대를 비우지 않는다)
  if (!ball.owner && distToBall < 6 && distToGoalLine < 14) {
    return moveIntent(ball.position.clone(), true);
  }

  if (ball.isShot && ball.velocity.x !== 0) {
    const timeToLine = (goalX - ball.position.x) / ball.velocity.x;
    if (timeToLine > 0 && timeToLine < 2.5) {
      const predictedY = ball.position.y + ball.velocity.y * timeToLine;
      const clampedY = Math.max(topY - 4, Math.min(bottomY + 4, predictedY));
      return moveIntent(new Vector2D(goalX + outward * 1.0, clampedY), true);
    }
  }

  // GK 포지셔닝: 골대 근처에서만 움직인다. 너무 멀리 나가지 않는다.
  let targetY = centerY + (ball.position.y - centerY) * 0.55;
  targetY = Math.max(topY - 4, Math.min(bottomY + 4, targetY));
  let depth = 2.0;
  if (distToGoalLine < 18) depth = 2.0 + (18 - distToGoalLine) * 0.12;
  // 최대 전진 거리 제한 (골대를 비우지 않음)
  depth = Math.min(depth, 5.5);
  const targetX = goalX + outward * depth;

  return moveIntent(new Vector2D(targetX, targetY));
}

function decideGkDistribution(ctx) {
  const { player, team, opponentTeam } = ctx;
  let best = null;
  let bestScore = -Infinity;
  for (const t of team.outfieldPlayers) {
    const pressure = opponentTeam.players.filter((o) => o.position.sub(t.position).length() < 5).length;
    const forwardness = (t.position.x - player.position.x) * team.attackingDirection;
    const score = -pressure * 10 + forwardness * 0.3;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return { type: 'PASS', targetPlayer: best ?? team.outfieldPlayers[0], lofted: true };
}
