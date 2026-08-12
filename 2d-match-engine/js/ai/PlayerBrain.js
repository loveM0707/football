import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { computeSupportPosition, findBestPresser } from './OffTheBallMovement.js';

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

function goalAngleOpenness(fromPos, goalSide) {
  const [topY, bottomY] = Pitch.goalYRange();
  const goalX = goalSide === 'left' ? 0 : Pitch.LENGTH;
  const toTop = new Vector2D(goalX - fromPos.x, topY - fromPos.y);
  const toBottom = new Vector2D(goalX - fromPos.x, bottomY - fromPos.y);
  return Math.abs(toTop.angle() - toBottom.angle());
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

export function decidePlayerIntent(ctx) {
  const { player, team, ball } = ctx;

  if (player.role === 'GK') return decideGoalkeeper(ctx);
  if (player.hasBall) return decideBallCarrier(ctx);

  if (ball.passTargetPlayer === player && !ball.owner) {
    const distToBall = player.position.sub(ball.position).length();
    if (distToBall > 1.5) {
      return moveIntent(ball.position.clone(), true);
    }
  }

  if (!ball.owner) {
    const distToBall = player.position.sub(ball.position).length();
    const closestTeammate = findClosestToBall(team.players, ball);
    if ((closestTeammate === player || distToBall < 5.0) && distToBall < 30) {
      return moveIntent(ball.position.clone(), true);
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

function decideBallCarrier(ctx) {
  const { player, team, opponentTeam, dt } = ctx;
  const mem = player.brainMemory;

  if (mem.controlTimer > 0) {
    mem.controlTimer -= dt;
    return { type: 'MOVE', target: player.position.clone(), sprint: false };
  }

  if (mem.decisionCooldown > 0) {
    mem.decisionCooldown -= dt;
    if (mem.lastIntent) return mem.lastIntent;
  }
  mem.decisionCooldown = 0.22 + Math.random() * 0.28;

  const attackDir = team.attackingDirection;
  const opponentGoalSide = attackDir === 1 ? 'right' : 'left';
  const goalPos = Pitch.goalCenter(opponentGoalSide);
  const distToGoal = player.position.sub(goalPos).length();
  const pressure = opponentTeam.players.filter(
    (o) => o.position.sub(player.position).length() < 3
  ).length;

  // 클리어링: 수비수가 자기 진영 깊숙한 곳에서 압박을 받으면 걷어낸다
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const distFromOwnGoal = Math.abs(player.position.x - ownGoalX);
  const isDefender = player.role === 'CB' || player.role === 'LB' || player.role === 'RB';
  if (isDefender && distFromOwnGoal < 25 && pressure >= 1) {
    mem.lastIntent = { type: 'CLEAR' };
    return mem.lastIntent;
  }

  // 전방에 상대가 없는지 확인 (드리블/슛 판단용)
  const noOpponentAhead = !hasOpponentAhead(player, opponentTeam, attackDir, 20);

  const angleOpen = goalAngleOpenness(player.position, opponentGoalSide);
  const inPenaltyArea = distToGoal < 16.5;

  // 1v1 슛 판단
  const gkGoalX = opponentGoalSide === 'right' ? Pitch.LENGTH : 0;
  const hasInterceptor = opponentTeam.players.some((o) => {
    if (o.role === 'GK') return false;
    const { dist: perpDist, t } = segmentPointInfo(
      o.position, player.position, new Vector2D(gkGoalX, player.position.y)
    );
    return perpDist < 4.5 && t > 0.08 && t < 0.98;
  });
  const clearOnGoal = !hasInterceptor && inPenaltyArea;

  // 빈 공간 드리블: 자기진영~상대 중원까지 전방에 아무도 없으면 드리블
  const inDribbleZone = distFromOwnGoal < Pitch.LENGTH * 0.65 && !inPenaltyArea;
  const clearSpaceAhead = inDribbleZone && noOpponentAhead;

  const rangeFactor = clamp01((24 - distToGoal) / 18);
  const shooterQuality = 0.6 + (player.attributes.shooting / 100) * 0.6;
  const roleFactor = player.role === 'ST' ? 1.15 : isDefender ? 0.45 : 0.85;
  const creativeBonus = (mem.creativity - 0.5) * 0.2;

  const baseShootProb = clamp01(
    (rangeFactor * rangeFactor * shooterQuality * roleFactor * (0.75 + angleOpen * 0.6) +
      creativeBonus * rangeFactor) * 0.12
  );
  const shootProb = clearOnGoal ? clamp01(0.3 + rangeFactor * 0.5) : baseShootProb;

  const canShoot = angleOpen > 0.07 && distToGoal < 30;
  const canShootNow = canShoot && (clearOnGoal || pressure < 2);

  let intent;
  if (canShootNow && Math.random() < shootProb) {
    intent = { type: 'SHOOT' };
  } else {
    intent = decidePassOrDribble(player, team, opponentTeam, goalPos, pressure, mem, inPenaltyArea, clearSpaceAhead);
  }

  mem.lastIntent = intent;
  return intent;
}

function decidePassOrDribble(player, team, opponentTeam, goalPos, pressure, mem, inPenaltyArea, clearSpaceAhead = false) {
  // 0순위: 앞에 공간이 크게 열려 있으면 → 즉시 드리블 돌파 (확률 85%)
  if (clearSpaceAhead && pressure === 0) {
    if (Math.random() < 0.85) {
      mem.holdTimer = 0;
      return { type: 'MOVE', target: pickDribbleTarget(player, team, opponentTeam, goalPos), sprint: true };
    }
  }

  const options = collectPassOptions(player, team, opponentTeam);
  const forwardOpen = options.filter((o) => o.forwardProgress > 4 && o.open);

  if (forwardOpen.length > 0) {
    const bestForward = forwardOpen.reduce((a, b) => (b.score > a.score ? b : a));
    const creativeHold = (mem.creativity - 0.5) * 0.25;
    // 빈 공간이면 드리블 선호, 아니면 패스 선호
    const passChance = clearSpaceAhead ? 0.4 : clamp01(0.85 - creativeHold);
    if (Math.random() < passChance) {
      return { type: 'PASS', targetPlayer: bestForward.player, lofted: bestForward.distance > 25 };
    }
    return { type: 'MOVE', target: pickDribbleTarget(player, team, opponentTeam, goalPos), sprint: true };
  }

  if (pressure === 0) {
    mem.holdTimer = (mem.holdTimer ?? 0) + 0.1;
    if (mem.holdTimer < 0.6 && Math.random() < 0.35) {
      return { type: 'MOVE', target: player.position.clone(), sprint: false, speedFactor: 0.2 };
    }
    return { type: 'MOVE', target: pickDribbleTarget(player, team, opponentTeam, goalPos), sprint: true };
  }
  mem.holdTimer = 0;

  const safeOptions = options.filter((o) => o.open);
  if (safeOptions.length > 0) {
    const best = safeOptions.reduce((a, b) => (b.score > a.score ? b : a));
    const backpassProb = clamp01(0.35 + pressure * 0.25 - (inPenaltyArea ? 0.3 : 0));
    if (best.forwardProgress > 4 || Math.random() < backpassProb) {
      return { type: 'PASS', targetPlayer: best.player, lofted: best.distance > 25 };
    }
  }

  return { type: 'MOVE', target: pickDribbleTarget(player, team, opponentTeam, goalPos), sprint: true };
}

function collectPassOptions(player, team, opponentTeam) {
  const attackDir = team.attackingDirection;
  const goalPos = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
  const isWinger = player.role === 'LM' || player.role === 'RM';
  const wingY = player.role === 'LM' ? Pitch.WIDTH * 0.15 : Pitch.WIDTH * 0.85;
  const options = [];

  for (const teammate of team.players) {
    if (teammate === player) continue;
    if (teammate.role === 'GK') continue;
    const dist = teammate.position.sub(player.position).length();
    if (dist > 45 || dist < 3) continue;

    const forwardProgress = (teammate.position.x - player.position.x) * attackDir;

    const nearReceiver = opponentTeam.players.filter(
      (o) => o.role !== 'GK' && o.position.sub(teammate.position).length() < 6
    ).length;
    const blocked = isPassingLaneBlocked(player.position, teammate.position, opponentTeam.players);
    const open = nearReceiver === 0 && !blocked;

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
      forwardProgress * 2.0 +
      progressToGoal * 2.0 +
      midfieldBonus +
      attackerBonus +
      wingBonus -
      nearReceiver * 8 -
      (blocked ? 15 : 0) -
      dist * 0.1 +
      team.tactics.directnessBias * forwardProgress * 0.4;

    options.push({ player: teammate, score, distance: dist, forwardProgress, open });
  }
  return options;
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
  const presser = findBestPresser(team.outfieldPlayers, ball);
  const distToBall = player.position.sub(ball.position).length();

  // 1차 견제자
  if (player === presser) {
    if (distToBall < team.tactics.pressingTriggerDistance) {
      const sprint = distToBall > 5;
      return moveIntent(ball.position.clone(), sprint);
    }
    return moveIntent(ball.position.clone(), true);
  }

  // 2차 견제자: 볼 근처 두 번째로 가까운 선수 (1~2명 견제)
  const secondPresser = findSecondPresser(team.outfieldPlayers, ball, presser);
  if (player === secondPresser && distToBall < 12) {
    // 볼 소유자와 골대 사이 길목을 차단하는 위치
    const ownGoalX = team.attackingDirection === 1 ? 0 : Pitch.LENGTH;
    const cutoffTarget = Vector2D.lerp(ball.position, new Vector2D(ownGoalX, Pitch.WIDTH / 2), 0.25);
    return moveIntent(cutoffTarget, distToBall > 8);
  }

  let target = computeSupportPosition({ player, team, ball, inPossession: false });

  // 가까운 상대 마킹
  let nearOpp = null;
  let nearDist = Infinity;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const d = o.position.sub(player.basePosition).length();
    if (d < nearDist) { nearDist = d; nearOpp = o; }
  }
  if (nearOpp && nearDist < 14) {
    const ownGoalX = team.attackingDirection === 1 ? 0 : Pitch.LENGTH;
    const dangerZone = clamp01(1 - Math.abs(nearOpp.position.x - ownGoalX) / 30);
    const markTightness = 0.22 + dangerZone * 0.4;
    const laneSpot = Vector2D.lerp(ball.position, nearOpp.position, 0.65);
    target = Vector2D.lerp(target, laneSpot, markTightness);
  }

  const ownGoalX = team.attackingDirection === 1 ? 0 : Pitch.LENGTH;
  const threatLevel = clamp01(1 - Math.abs(ball.position.x - ownGoalX) / 45);
  const dist = player.position.sub(target).length();
  const sf = dist > 12 ? 0.75 + threatLevel * 0.25 : 0.5 + threatLevel * 0.3;
  return moveIntent(target, false, sf);
}

function findSecondPresser(players, ball, firstPresser) {
  let best = null;
  let bestDist = Infinity;
  for (const p of players) {
    if (p.role === 'GK' || p === firstPresser) continue;
    const d = p.position.sub(ball.position).length();
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
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
