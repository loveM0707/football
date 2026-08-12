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
    if (distToIntercept > 1.5) {
      return moveIntent(intercept, true);
    }
  }

  if (!ball.owner) {
    const distToBall = player.position.sub(ball.position).length();
    const closestTeammate = findClosestToBall(team.players, ball);
    if ((closestTeammate === player || distToBall < 5.0) && distToBall < 30) {
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
// 소유 선수 반경 PRESS_RADIUS(10m ≒ 100px) 안의 상대 수비수를 스캔한다.
//   - 수비수가 가까울수록, 수비수의 진행 방향이 공을 향할수록 점수가 높다.
//   - 이동 중이면 velocity 방향, 정지 상태면 facingAngle을 진행 방향으로 사용한다.
// ═══════════════════════════════════════════════════════════════
const PRESS_RADIUS = 10; // 미터 (~100픽셀)

function computePressureScore(player, opponentTeam) {
  let raw = 0;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const toBall = player.position.sub(o.position);
    const dist = toBall.length();
    if (dist > PRESS_RADIUS) continue;

    // 거리 기여: 가까울수록 높음 (0~1)
    const distFactor = 1 - dist / PRESS_RADIUS;

    // 방향 기여: 수비수가 공을 향해 움직일수록 높음 (0~1)
    let heading = o.velocity;
    if (heading.length() < 0.3) heading = Vector2D.fromAngle(o.facingAngle);
    const directionFactor = Math.max(0, heading.normalize().dot(toBall.normalize()));

    raw += distFactor * (0.6 + 0.4 * directionFactor);
  }
  // 지수 감쇠로 0~100 정규화 (선수 2~3명이 밀착하면 ~80 이상)
  return Math.round((1 - Math.exp(-raw * 0.55)) * 100);
}

// ═══════════════════════════════════════════════════════════════
// Stage 2: 슈팅 판단
//
//  - 유효 슈팅 사거리(28m) 이내인지 확인
//  - 골대 양 기둥을 잇는 삼각 시야(Cone)의 각도와, 골대 방향 레이 위/주변의
//    차단 수비수 수를 Raycasting으로 계산해 슈팅 유틸리티(0~1)를 산출한다.
// ═══════════════════════════════════════════════════════════════
const SHOOT_RANGE = 28;

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

  const rangeFactor = clamp01((SHOOT_RANGE - distToGoal) / 20);
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

    const typeBase = type === 'THROUGH' ? 55 : type === 'FORWARD' ? 35 : 18;

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

    options.push({ player: teammate, score, distance: dist, forwardProgress, open, type });
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
  const creativityBonus = (player.brainMemory.creativity - 0.5) * 0.35;
  let utility = noOpponentAhead ? 0.85 + creativityBonus : 0.1;
  utility -= pressure / 250;

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

  if (mem.controlTimer > 0) {
    mem.controlTimer -= dt;
    mem.debugIntent = null;
    return { type: 'MOVE', target: player.position.clone(), sprint: false };
  }

  if (mem.decisionCooldown > 0) {
    mem.decisionCooldown -= dt;
    if (mem.lastIntent) return mem.lastIntent;
  }
  mem.decisionCooldown = 0.22 + Math.random() * 0.28;

  const attackDir = team.attackingDirection;

  // ── Stage 1: 압박 수치 계산 ────────────────────────────────
  const pressure = computePressureScore(player, opponentTeam);
  mem.pressureScore = pressure;

  // 클리어링: 수비수가 자기 진영 깊숙한 곳에서 압박을 받으면 걷어낸다
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const distFromOwnGoal = Math.abs(player.position.x - ownGoalX);
  const isDefender = player.role === 'CB' || player.role === 'LB' || player.role === 'RB';
  if (isDefender && distFromOwnGoal < 25 && pressure >= 25) {
    mem.lastIntent = { type: 'CLEAR', pressure };
    mem.debugIntent = null;
    return mem.lastIntent;
  }

  // ── Stage 2: 슈팅 판단 ─────────────────────────────────────
  const shot = evaluateShotOpportunity(player, opponentTeam, attackDir);
  const canShootNow = shot.distToGoal < SHOOT_RANGE && shot.angleOpen > 0.07 && (shot.clearShot || pressure < 60);
  const rangeFactor = clamp01((SHOOT_RANGE - shot.distToGoal) / 18);
  const creativeBonus = (mem.creativity - 0.5) * 0.2;
  const baseShootProb = clamp01(
    (rangeFactor * rangeFactor * (0.6 + (player.attributes.shooting / 100) * 0.6) *
      (player.role === 'ST' ? 1.15 : isDefender ? 0.45 : 0.85) * (0.75 + shot.angleOpen * 0.6) +
      creativeBonus * rangeFactor) * 0.12
  );
  const shootUtility = canShootNow ? (shot.clearShot ? clamp01(0.3 + rangeFactor * 0.5) : baseShootProb) * (1 + pressure / 400) : 0;

  // ── Stage 3: 패스 판단 ─────────────────────────────────────
  const passOptions = evaluatePassOptions(player, team, opponentTeam);
  const bestOption = passOptions.length > 0
    ? passOptions.reduce((a, b) => (b.score > a.score ? b : a))
    : null;
  const passUtility = bestOption
    ? clamp01(0.28 + bestOption.score / 260) * (pressure > 55 ? 1.35 : 1)
    : 0;

  // ── Stage 4: 드리블 판단 ───────────────────────────────────
  const dribble = evaluateDribble(player, team, opponentTeam, pressure);

  // ── Force-dribble shortcut: 전방 15m 이내에 수비수 없으면 드리블 강제 ──
  if (dribble.noOpponentAhead && pressure < 30) {
    const intent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    mem.debugIntent = { type: 'DRIBBLE', target: dribble.target.clone() };
    mem.lastIntent = intent;
    return intent;
  }

  // ── Stage 5: 유틸리티 가중 랜덤 결정 ───────────────────────
  let intent;
  const total = shootUtility + passUtility + dribble.utility;
  const roll = Math.random() * total;

  if (roll < shootUtility) {
    intent = { type: 'SHOOT', pressure };
    mem.debugIntent = { type: 'SHOOT', target: shot.goalCenter.clone() };
  } else if (roll < shootUtility + passUtility && bestOption) {
    intent = { type: 'PASS', targetPlayer: bestOption.player, lofted: bestOption.distance > 25, pressure };
    mem.debugIntent = { type: 'PASS', target: bestOption.player.position.clone() };
  } else if (dribble.utility > 0.05) {
    intent = { type: 'MOVE', target: dribble.target, sprint: true, pressure };
    mem.debugIntent = { type: 'DRIBBLE', target: dribble.target.clone() };
  } else if (bestOption) {
    intent = { type: 'PASS', targetPlayer: bestOption.player, lofted: bestOption.distance > 25, pressure };
    mem.debugIntent = { type: 'PASS', target: bestOption.player.position.clone() };
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
  const goalDir = goalPos.sub(player.position).normalize();
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
    const sideDir = new Vector2D(0, Math.sign(wingY - player.position.y));
    steer = goalDir.scale(0.65).add(sideDir.scale(0.35)).normalize();
  }

  const dribbleDist = nearestOpp && nearestDist < 4
    ? 6 + Math.random() * 4
    : 10 + Math.random() * 10;
  return Pitch.clampInside(player.position.add(steer.scale(dribbleDist)), 1.5);
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
