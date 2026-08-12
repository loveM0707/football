import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { computeSupportPosition } from './OffTheBallMovement.js';
import { findPressers, computePresserTarget, computeCutoffTarget, computeDefensiveTarget, alignDefensiveLine } from './Defending.js';

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

/** 선수 전방 일정 범위(원추형)에 상대가 있는지 확인 */
function hasOpponentAhead(player, opponentTeam, attackDir, range) {
  const playerX = player.position.x;
  const playerY = player.position.y;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const dx = (o.position.x - playerX) * attackDir;
    if (dx < 0 || dx > range) continue;
    const dy = Math.abs(o.position.y - playerY);
    if (dy < 6 + dx * 0.3) return true; // 전방 확장 원추
  }
  return false;
}

const BALL_FRICTION = 3.4;
/** 이 속도(m/s) 미만의 패스는 "느린 패스"로 보고 마중 움직임을 유도한다 */
const MEET_BALL_SPEED = 6.0;

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

/**
 * 마중 지점 (Active Reception 계획)
 *
 * 공이 느리게 굴러와 P_int까지 기다리면 공이 먼저 멈추거나 수비가 먼저 도착하는 경우,
 * 리시버는 교차점에서 기다리지 않고 공의 현재 위치(진행 방향의 짧은 미래 지점)를 향해
 * 역방향 가속으로 달려 나가 받는다.
 */
function computeMeetPoint(ball, player) {
  const speed = ball.velocity.length();
  if (speed < 0.8) return ball.position.clone();
  const dir = ball.velocity.normalize();
  const toPlayer = player.position.sub(ball.position);
  const lead = Math.min(Math.max(toPlayer.length() * 0.25, 0), 2.2); // 살짝 앞에서 트래핑
  return Pitch.clampInside(ball.position.add(dir.scale(lead)), 1.2);
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

    // 이미 교차점에 도착 → 제자리 트래핑 준비
    if (distToIntercept <= 1.2) {
      const toBall = ball.position.sub(player.position);
      if (toBall.length() > 0.3) {
        player.desiredFacingAngle = toBall.angle();
      }
      return { type: 'HOLD' };
    }

    // ── 능동적 수신(마중): 물리적 타이밍을 확인하고 기다리지 않고 달려 나간다 ──
    const ballSpeed = ball.velocity.length();
    const slowPass = ballSpeed < MEET_BALL_SPEED; // 느린 패스/멈춘 공
    let nearestOppDist = Infinity;
    if (ctx.opponentTeam) {
      for (const o of ctx.opponentTeam.players) {
        if (o.role === 'GK') continue;
        const d = o.position.sub(player.position).length();
        if (d < nearestOppDist) nearestOppDist = d;
      }
    }
    const receiverUnderPressure = nearestOppDist < 5;
    // 공이 내가 도달하기 전에 멈추면 P_int에서 기다리는 것이 헛걸음이 된다
    const ballStopTime = ballSpeed / BALL_FRICTION;
    const arriveTime = distToIntercept / Math.max(player.maxSpeed, 1e-6);
    const ballStopsEarly = ballSpeed > 0.5 && ballStopTime * 0.7 < arriveTime;

    if (slowPass || receiverUnderPressure || ballStopsEarly) {
      const meetPoint = computeMeetPoint(ball, player); // 공의 현재 위치로 마중
      return moveIntent(meetPoint, true);
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
// 물리 기반 역제곱 법칙: P = Σ w / d² 로 압박 점수를 산출한다.
// 소유 선수 반경 PRESS_RADIUS(12m) 안의 상대 수비수 각각에 대해
//   - 거리 d: 가까울수록 역제곱으로 압박이 기하급수적으로 커진다
//   - 가중치 w: 수비수가 공을 향해 달려올수록(진행 방향 정렬) 커진다
// 이동 중이면 velocity 방향, 정지 상태면 facingAngle을 진행 방향으로 사용한다.
// ═══════════════════════════════════════════════════════════════
const PRESS_RADIUS = 12; // 미터 (~120픽셀)
/** d=1m에서 압박 기여 1.0이 되는 가중치 상수 */
const PRESSURE_W = 4.0;
/** P(0~100) 산출을 위한 역제곱 합 → 지수 스케일 정규화 계수 */
const PRESSURE_EXP = 0.34;

function computePressureScore(player, opponentTeam) {
  let sum = 0;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const toBall = player.position.sub(o.position);
    const dist = Math.max(toBall.length(), 0.8);
    if (dist > PRESS_RADIUS) continue;

    // 진행 방향이 공을 향할수록 가중치 w 증가 (0.55~1.0)
    let heading = o.velocity;
    if (heading.length() < 0.3) heading = Vector2D.fromAngle(o.facingAngle);
    const directionFactor = Math.max(0, heading.normalize().dot(toBall.normalize()));
    const w = 0.55 + 0.45 * directionFactor;

    // 역제곱 법칙: 가까운 수비수가 압박을 폭발적으로 높인다
    sum += PRESSURE_W * w / (dist * dist);
  }
  // 지수 감쇠 정규화: 밀착 수비수 1명(d≈1.5m)이면 ~60, 2~3명이면 85+
  return Math.round((1 - Math.exp(-sum * PRESSURE_EXP)) * 100);
}

/**
 * 압박 임계값 기반 드리블/패스 결정
 *  Threshold(t)     : 이 값 미만의 압박이면 안전 → 드리블 우선
 *  Threshold(high)  : 이 값 이상의 압박이면 위험 → 패싱 레인을 스캔해 패스 우선
 *  앞 유틸리티 계산은 유지하되, 이 두 "경계 조건"을 의사결정 상단에서 강제한다.
 */
const PRESSURE_THRESHOLD_DRIBBLE = 32; // P < 32: 위협 없음 → 강제 드리블 후보
const PRESSURE_THRESHOLD_PASS = 52;    // P >= 52: 위험 → 강제 패스 후보

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

function evaluatePassOptions(player, team, opponentTeam) {
  const attackDir = team.attackingDirection;
  const goalPos = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
  const isWinger = player.role === 'LM' || player.role === 'RM';
  const wingY = player.role === 'LM' ? Pitch.WIDTH * 0.15 : Pitch.WIDTH * 0.85;
  const vision = (player.attributes.vision ?? player.attributes.positioning) / 100;
  const options = [];

  for (const teammate of team.players) {
    if (teammate === player || teammate.role === 'GK') continue;
    const dist = teammate.position.sub(player.position).length();
    if (dist > 45 || dist < 3) continue;

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

    const typeBase = type === 'THROUGH' ? 65 : type === 'FORWARD' ? 35 : 18;

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

    const score =
      typeBase +
      forwardProgress * 1.5 +
      progressToGoal * 2.0 +
      midfieldBonus +
      attackerBonus +
      wingBonus -
      nearReceiver * 8 -
      (blocked ? 15 : 0) -
      dist * 0.1 +
      team.tactics.directnessBias * forwardProgress * 0.4;

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

  const noOpponentAhead = !hasOpponentAhead(player, opponentTeam, team.attackingDirection, 15);
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

  // ── Stage 3: 패스 판단 ─────────────────────────────────────
  // 패스는 ① 열린 수신자+높은 스코어(품질 패스) ② 스루패스 ③ 고압박으로 불가피할 때만 우선
  const passOptions = evaluatePassOptions(player, team, opponentTeam);
  const bestOption = passOptions.length > 0
    ? passOptions.reduce((a, b) => (b.score > a.score ? b : a))
    : null;
  const passQuality = bestOption ? bestOption.score : 0;
  const passIsQuality = bestOption && ((bestOption.open && passQuality > 55) || bestOption.type === 'THROUGH');
  const passForced = pressure >= PRESSURE_THRESHOLD_PASS;
  // settleFactor: 볼을 잡은 직후에는 패스 가치를 크게 깎아 곧바로 되받아 차지 않게 한다
  const passUtility = bestOption
    ? clamp01(passQuality / 260) * (passForced ? 1.5 : passIsQuality ? 0.85 : 0.14) *
      (pressure > 50 ? 1.3 : 1) * (passForced ? 1 : 0.25 + settleFactor * 0.75)
    : 0;

  // ── Stage 4: 드리블 판단 ───────────────────────────────────
  const dribble = evaluateDribble(player, team, opponentTeam, pressure);

  // ── ②  P < Threshold(드리블) + 전방 공간 열림 → 강제 DRIBBLE ──
  // 전방 15m 이내에 수비수가 없으면 드리블을 강제한다. 단, 슛이 가능한 상황에서는
  // 골대 앞까지 몰고 가지 않는다 (골키퍼 뒤로 몰고 가는 버그 방지).
  if (pressure < PRESSURE_THRESHOLD_DRIBBLE && dribble.noOpponentAhead && !canShootNow) {
    const intent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    mem.debugIntent = { type: 'DRIBBLE', target: dribble.target.clone() };
    mem.lastIntent = intent;
    return intent;
  }

  // ── ①  P >= Threshold(패스) → 패싱 레인 스캔 강제 PASS ──────
  // 고압박 상황에서는 Raycasting으로 수비수에게 차단당하지 않는 동료를 찾아
  // 즉시 패스한다. 명확한 슛 찬스가 없다는 전제에서만 (박스 안 슛 강제는 위에서 처리).
  if (pressure >= PRESSURE_THRESHOLD_PASS && !(canShootNow && shot.clearShot)) {
    const safeLanes = passOptions.filter((o) => o.open);
    if (safeLanes.length > 0) {
      const lane = safeLanes.reduce((a, b) => (b.score > a.score ? b : a));
      const isThrough = lane.type === 'THROUGH' && lane.futurePos;
      const intent = {
        type: 'PASS',
        targetPlayer: lane.player,
        targetPos: isThrough ? lane.futurePos : null,
        lofted: isThrough || lane.distance > 25,
        pressure,
      };
      const debugTarget = isThrough ? lane.futurePos.clone() : lane.player.position.clone();
      mem.lastIntent = intent;
      mem.debugIntent = { type: 'PASS', target: debugTarget };
      return intent;
    }
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
    if (onFlank && distGL < Pitch.PENALTY_BOX_LENGTH + 10 && !canShootNow) {
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

  // 골라인에 가까우면 골문이 아니라 페널티 스팟 쪽을 향한다. 골문을 향해 계속
  // 전진하면 각도가 없는 상태로 골키퍼 옆·뒤까지 몰고 가게 된다.
  const aimPos = distToGoalLine < BYLINE_REDIRECT_DIST
    ? new Vector2D(goalLineX - attackDirEarly * Pitch.PENALTY_SPOT_DIST, Pitch.WIDTH / 2)
    : goalPos;

  const goalDir = aimPos.sub(player.position).length() > 0.5
    ? aimPos.sub(player.position).normalize()
    : new Vector2D(-attackDirEarly, 0);
  const isWinger = player.role === 'LM' || player.role === 'RM';
  const centerY = Pitch.WIDTH / 2;
  const wingY = player.role === 'LM' ? Pitch.WIDTH * 0.1 : Pitch.WIDTH * 0.9;

  let nearestOpp = null;
  let nearestDist = Infinity;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const d = o.position.sub(player.position).length();
    if (d < nearestDist) { nearestDist = d; nearestOpp = o; }
  }

  let steer = goalDir;
  const pressFront = nearestOpp && nearestDist < 8;

  if (isWinger && pressFront) {
    if (Math.random() < 0.4) {
      steer = goalDir.scale(0.5).add(new Vector2D(0, centerY - player.position.y).normalize().scale(0.5)).normalize();
    } else {
      const away = player.position.sub(nearestOpp.position).normalize();
      steer = goalDir.scale(0.7).add(away.scale(0.3)).normalize();
    }
  } else if (pressFront) {
    const away = player.position.sub(nearestOpp.position).normalize();
    steer = goalDir.scale(0.6).add(away.scale(0.6)).normalize();
    if (Math.random() < 0.25) {
      const lateral = new Vector2D(-goalDir.y, goalDir.x).scale(Math.random() < 0.5 ? 1 : -1);
      steer = goalDir.scale(0.35).add(lateral.scale(0.5)).add(away.scale(0.25)).normalize();
    }
  } else if (isWinger) {
    const isOnFlank = player.role === 'LM'
      ? player.position.y < Pitch.WIDTH * 0.35
      : player.position.y > Pitch.WIDTH * 0.65;
    if (isOnFlank && distToGoalLine >= BYLINE_REDIRECT_DIST) {
      // 측면에서는 전방으로 강하게 드리블(측면 유지). 단 골라인 부근에서는
      // 무조건 전진하면 엔드라인까지 몰고 가므로 goalDir(=페널티 스팟)로 전환한다.
      const forwardDir = new Vector2D(team.attackingDirection, 0);
      const keepFlank = new Vector2D(0, Math.sign(wingY - player.position.y));
      steer = forwardDir.scale(0.82).add(keepFlank.scale(0.18)).normalize();
    } else if (isOnFlank) {
      // 골라인 부근 측면: 중앙(페널티 스팟) 쪽으로 접어 들어간다
      steer = goalDir;
    } else {
      const sideDir = new Vector2D(0, Math.sign(wingY - player.position.y));
      steer = goalDir.scale(0.65).add(sideDir.scale(0.35)).normalize();
    }
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

  // Stage 3.5: 수비 라인 평탄화 (σ_x 최소화)
  // 커버 섀도우는 패스 경로상에 서야 하므로 개인 포지션을 유지하고,
  // 존(블록)/느슨한 마크 상태일수록 공통 라인 X로 수렴한다.
  const markStrength =
    defensive.behavior === 'COVER_SHADOW' ? 1 :
    defensive.behavior === 'MARKING' ? 0.55 : 0;
  const target = alignDefensiveLine({
    player, team, ball,
    target: defensive.target,
    markStrength,
  });

  const threatLevel = clamp01(1 - Math.abs(ball.position.x - ownGoalX) / 45);
  const dist = player.position.sub(target).length();
  const sf = dist > 12 ? 0.75 + threatLevel * 0.25 : 0.5 + threatLevel * 0.3;
  return moveIntent(target, false, sf);
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
