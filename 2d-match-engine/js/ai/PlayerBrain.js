import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { computeSupportPosition, findBestPresser } from './OffTheBallMovement.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function moveIntent(target, sprint = false) {
  return { type: 'MOVE', target, sprint };
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

/**
 * 개별 선수의 매 틱 의사결정 진입점. 순수 함수에 가깝게 설계되어 있어(부작용 없음),
 * 실제 패스/슛/이동 실행은 ActionExecutor가 담당하고 여기서는 "의도(intent)"만 반환한다.
 */
export function decidePlayerIntent(ctx) {
  const { player, team, ball } = ctx;

  if (player.role === 'GK') return decideGoalkeeper(ctx);
  if (player.hasBall) return decideBallCarrier(ctx);

  // 실제 소유 또는 우리 팀이 마지막으로 찬 공(패스 이동 중)도 우리 팀 점유로 인식
  const teamHasBall = (ball.owner && ball.owner.team === team) ||
                      (!ball.owner && ball.lastTouchedTeam === team);
  const opponentHasBall = (ball.owner && ball.owner.team !== team) ||
                          (!ball.owner && ball.lastTouchedTeam && ball.lastTouchedTeam !== team);

  if (teamHasBall) {
    return moveIntent(computeSupportPosition({ player, team, ball, inPossession: true }));
  }

  if (opponentHasBall) {
    return decideDefensiveOffBall(ctx);
  }

  // 완전한 루즈볼: 팀에서 가장 가까운 한 명만 쫓아가고 나머지는 진형 유지
  const closestTeammate = findClosestToBall(team.players, ball);
  const distToBall = player.position.sub(ball.position).length();
  if (closestTeammate === player && distToBall < 32) {
    return moveIntent(ball.position.clone(), true);
  }
  return moveIntent(computeSupportPosition({ player, team, ball, inPossession: false }));
}

function findClosestToBall(players, ball) {
  let best = null;
  let bestDist = Infinity;
  for (const p of players) {
    const d = p.position.sub(ball.position).length();
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function decideBallCarrier(ctx) {
  const { player, team, opponentTeam, dt } = ctx;
  const mem = player.brainMemory;

  // 방금 공을 잡았다면 탁구공처럼 곧장 처내지 않고 잠깐 잡아두며 주위를 살핀다
  if (mem.controlTimer > 0) {
    mem.controlTimer -= dt;
    return { type: 'MOVE', target: player.position.clone(), sprint: false };
  }

  if (mem.decisionCooldown > 0) {
    mem.decisionCooldown -= dt;
    if (mem.lastIntent) return mem.lastIntent;
  }
  mem.decisionCooldown = 0.22 + Math.random() * 0.28;

  const opponentGoalSide = team.attackingDirection === 1 ? 'right' : 'left';
  const goalPos = Pitch.goalCenter(opponentGoalSide);
  const distToGoal = player.position.sub(goalPos).length();
  const pressure = opponentTeam.players.filter(
    (o) => o.position.sub(player.position).length() < 3
  ).length;

  // 슛 사거리를 현실적으로 확대 (28~40m). 스트라이커는 페널티 에어리어 밖에서도 슈팅 가능
  const shootRange = 28 + (player.attributes.shooting / 100) * 12;
  const angleOpen = goalAngleOpenness(player.position, opponentGoalSide);
  const canShoot = distToGoal < shootRange && angleOpen > 0.07 && pressure < 2;

  let intent;
  if (canShoot && Math.random() < 0.55 + angleOpen * 0.3) {
    intent = { type: 'SHOOT' };
  } else {
    const passOption = pickBestPassOption(player, team, opponentTeam);
    // 전진 패스가 10m 이상이어야 적극적으로 패스 (그보다 짧으면 드리블 선호)
    const hasGoodForwardPass = passOption && passOption.forwardProgress > 10;
    const passProbability = hasGoodForwardPass
      ? clamp01(0.65 + pressure * 0.1)
      : clamp01(pressure * 0.25); // 압박이 강할 때만 짧은 패스 허용
    if (passOption && Math.random() < passProbability) {
      intent = { type: 'PASS', targetPlayer: passOption.player, lofted: passOption.distance > 28 };
    } else {
      // 드리블: 골대 방향으로 적극 전진
      intent = { type: 'MOVE', target: pickDribbleTarget(player, team, opponentTeam, goalPos), sprint: true };
    }
  }

  mem.lastIntent = intent;
  return intent;
}

function pickBestPassOption(player, team, opponentTeam) {
  const attackDir = team.attackingDirection;
  const goalPos = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
  let best = null;

  for (const teammate of team.players) {
    if (teammate === player) continue;
    const dist = teammate.position.sub(player.position).length();
    if (dist > 45) continue;

    const forwardProgress = (teammate.position.x - player.position.x) * attackDir;

    // 앞으로 전진하지 않는 패스는 매우 강한 페널티
    const backpassPenalty = forwardProgress < 3 ? 25 + Math.abs(forwardProgress) * 3 : 0;

    const nearReceiver = opponentTeam.players.filter(
      (o) => o.position.sub(teammate.position).length() < 4
    ).length;
    const blocked = isPassingLaneBlocked(player.position, teammate.position, opponentTeam.players);

    // 공격수/측면 공격수로의 패스를 강력하게 선호
    const isAttacker = teammate.role === 'ST' || teammate.role === 'LM' || teammate.role === 'RM';
    const attackerBonus = isAttacker ? 10 : 0;

    // 미드필더도 전진 공격을 좋아함
    const isMidfield = teammate.role === 'CM';
    const midfieldBonus = isMidfield && forwardProgress > 5 ? 5 : 0;

    // 상대 골에 더 가까운 수신자를 선호
    const receiverDistToGoal = teammate.position.sub(goalPos).length();
    const senderDistToGoal = player.position.sub(goalPos).length();
    const progressToGoal = Math.max(0, senderDistToGoal - receiverDistToGoal);

    let score =
      forwardProgress * 2.0 +
      progressToGoal * 2.0 +
      midfieldBonus +
      attackerBonus -
      backpassPenalty -
      nearReceiver * 8 -
      (blocked ? 15 : 0) -
      dist * 0.1 +
      team.tactics.directnessBias * forwardProgress * 0.4;

    if (!best || score > best.score) {
      best = { player: teammate, score, distance: dist, forwardProgress };
    }
  }
  return best;
}

function pickDribbleTarget(player, team, opponentTeam, goalPos) {
  const goalDir = goalPos.sub(player.position).normalize();
  let nearestOpp = null;
  let nearestDist = Infinity;
  for (const o of opponentTeam.players) {
    const d = o.position.sub(player.position).length();
    if (d < nearestDist) {
      nearestDist = d;
      nearestOpp = o;
    }
  }

  let steer = goalDir;
  if (nearestOpp && nearestDist < 8) {
    const away = player.position.sub(nearestOpp.position).normalize();
    steer = goalDir.scale(0.65).add(away.scale(0.55)).normalize();
  }
  // 드리블 거리를 20m로 늘려서 골대 방향으로 더 공격적으로 전진
  return Pitch.clampInside(player.position.add(steer.scale(20)), 1.5);
}

function decideDefensiveOffBall(ctx) {
  const { player, team, opponentTeam, ball } = ctx;
  const presser = findBestPresser(team.outfieldPlayers, ball);
  const distToBall = player.position.sub(ball.position).length();

  if (player === presser && distToBall < team.tactics.pressingTriggerDistance) {
    return moveIntent(ball.position.clone(), true);
  }

  let target = computeSupportPosition({ player, team, ball, inPossession: false });

  let nearOpp = null;
  let nearDist = Infinity;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const d = o.position.sub(player.basePosition).length();
    if (d < nearDist) {
      nearDist = d;
      nearOpp = o;
    }
  }
  if (nearOpp && nearDist < 14) {
    const ownGoalX = team.attackingDirection === 1 ? 0 : Pitch.LENGTH;
    const dangerZone = clamp01(1 - Math.abs(nearOpp.position.x - ownGoalX) / 30); // 자기 박스에 가까울수록 밀착
    const markTightness = 0.22 + dangerZone * 0.4;
    // 상대 선수에게 딱 붙기보다, 볼과 상대 사이의 패스 길목 쪽으로 서서 차단을 노린다
    const laneSpot = Vector2D.lerp(ball.position, nearOpp.position, 0.65);
    target = Vector2D.lerp(target, laneSpot, markTightness);
  }

  return moveIntent(target);
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

  if (!ball.owner && distToBall < 9 && distToGoalLine < 16) {
    return moveIntent(ball.position.clone(), true);
  }

  // 슈팅이 감지되면 궤적을 예측해 골라인상의 예상 지점으로 즉시 반응한다(선방 시도)
  if (ball.isShot && ball.velocity.x !== 0) {
    const timeToLine = (goalX - ball.position.x) / ball.velocity.x;
    if (timeToLine > 0 && timeToLine < 2.5) {
      const predictedY = ball.position.y + ball.velocity.y * timeToLine;
      const clampedY = Math.max(topY - 4, Math.min(bottomY + 4, predictedY));
      return moveIntent(new Vector2D(goalX + outward * 1.0, clampedY), true);
    }
  }

  let targetY = centerY + (ball.position.y - centerY) * 0.65;
  targetY = Math.max(topY - 6, Math.min(bottomY + 6, targetY));
  let depth = 2.5;
  if (distToGoalLine < 20) depth = 2.5 + (20 - distToGoalLine) * 0.15;
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
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return { type: 'PASS', targetPlayer: best ?? team.outfieldPlayers[0], lofted: true };
}
