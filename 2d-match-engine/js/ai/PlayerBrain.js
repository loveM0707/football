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

/**
 * 개별 선수의 매 틱 의사결정 진입점. 순수 함수에 가깝게 설계되어 있어(부작용 없음),
 * 실제 패스/슛/이동 실행은 ActionExecutor가 담당하고 여기서는 "의도(intent)"만 반환한다.
 */
export function decidePlayerIntent(ctx) {
  const { player, team, ball } = ctx;

  if (player.role === 'GK') return decideGoalkeeper(ctx);
  if (player.hasBall) return decideBallCarrier(ctx);

  // 패스 수신자: 공이 날아오고 있고 자신이 수신자라면 공을 받으러 스프린트
  if (ball.passTargetPlayer === player && !ball.owner) {
    const distToBall = player.position.sub(ball.position).length();
    if (distToBall > 1.5) {
      return moveIntent(ball.position.clone(), true);
    }
  }

  // 루즈볼(소유자 없음): 가까운 선수들이 적극적으로 쫓는다 - 팀 상관없이 공을 따라가는 게 우선
  if (!ball.owner) {
    const distToBall = player.position.sub(ball.position).length();
    const closestTeammate = findClosestToBall(team.players, ball);
    // 가장 가까운 팀원이거나, 5m 이내이면 적극 공 추격
    if ((closestTeammate === player || distToBall < 5.0) && distToBall < 30) {
      return moveIntent(ball.position.clone(), true);
    }
    // 나머지는 볼 쪽을 바라보며 서포트 포지션 유지 (속도 변화 적용)
    const inPossession = ball.lastTouchedTeam === team;
    const supportPos = computeSupportPosition({ player, team, ball, inPossession });
    const dist = player.position.sub(supportPos).length();
    const sf = dist > 14 ? 0.85 : dist > 5 ? 0.65 : 0.45;
    return moveIntent(supportPos, false, sf);
  }

  // 소유자 있는 경우
  if (ball.owner.team === team) {
    // 우리 팀 점유 → 서포트 포지션 (마크를 벗어나며 패스 각을 만든다)
    const supportPos = computeSupportPosition({
      player, team, ball, inPossession: true, opponentTeam: ctx.opponentTeam,
    });
    const dist = player.position.sub(supportPos).length();
    const sf = dist > 14 ? 0.85 : dist > 5 ? 0.65 : 0.45;
    return moveIntent(supportPos, false, sf);
  }

  return decideDefensiveOffBall(ctx);
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

  // 슈팅 판단은 고정 사거리 경계가 아니라 "골대에 가까울수록 높아지는 확률"로 결정한다.
  // 같은 지점에서도 매번 다른 선택이 나오고, 특정 거리선에 슛이 몰리지 않는다.
  const angleOpen = goalAngleOpenness(player.position, opponentGoalSide);
  const inPenaltyArea = distToGoal < 16.5;

  // 거리 기반 기본 슈팅 성향: 6m에서 거의 1.0 → 24m 부근에서 0으로 부드럽게 감소
  const rangeFactor = clamp01((24 - distToGoal) / 18);
  const shooterQuality = 0.6 + (player.attributes.shooting / 100) * 0.6;
  // 스트라이커는 조금 더 과감하게, 수비수는 소극적으로
  const roleFactor = player.role === 'ST' ? 1.15 : player.role === 'CB' || player.role === 'LB' || player.role === 'RB' ? 0.45 : 0.85;
  const creativeBonus = (mem.creativity - 0.5) * 0.2;

  // 0.12 계수: 결정 주기(약 0.2~0.5초)마다 판정하므로, 이 값이 크면 골문 근처에서
  // 무조건 즉시 슛이 나가 슛 수가 비현실적으로 많아진다.
  const shootProb = clamp01(
    (rangeFactor * rangeFactor * shooterQuality * roleFactor * (0.75 + angleOpen * 0.6) +
      creativeBonus * rangeFactor) * 0.12
  );

  const canShoot = angleOpen > 0.07 && pressure < 2 && distToGoal < 30;

  let intent;
  if (canShoot && Math.random() < shootProb) {
    intent = { type: 'SHOOT' };
  } else {
    intent = decidePassOrDribble(player, team, opponentTeam, goalPos, pressure, mem, inPenaltyArea);
  }

  mem.lastIntent = intent;
  return intent;
}

/**
 * 패스는 "전방에 열린 동료가 있을 때"만 나간다. 없으면 드리블하거나 잠시 공을 잡고 버티며
 * 동료가 전방으로 침투할 시간을 준다. 그래도 길이 열리지 않으면 낮은 확률로 백패스를 허용한다.
 */
function decidePassOrDribble(player, team, opponentTeam, goalPos, pressure, mem, inPenaltyArea) {
  const options = collectPassOptions(player, team, opponentTeam);
  const forwardOpen = options.filter((o) => o.forwardProgress > 4 && o.open);

  // 1순위: 전방에 상대가 없는 열린 동료 → 바로 패스
  if (forwardOpen.length > 0) {
    const bestForward = forwardOpen.reduce((a, b) => (b.score > a.score ? b : a));
    const creativeHold = (mem.creativity - 0.5) * 0.25; // 창의적인 선수는 가끔 직접 몰고 간다
    if (Math.random() < clamp01(0.85 - creativeHold)) {
      return { type: 'PASS', targetPlayer: bestForward.player, lofted: bestForward.distance > 28 };
    }
    return { type: 'MOVE', target: pickDribbleTarget(player, team, opponentTeam, goalPos), sprint: true };
  }

  // 2순위: 전방이 막혔다 → 압박이 약하면 드리블로 직접 전진
  if (pressure === 0) {
    mem.holdTimer = (mem.holdTimer ?? 0) + 0.1;
    // 가끔은 제자리에서 공을 잡고 동료의 침투를 기다린다(하이트 유지)
    if (mem.holdTimer < 0.6 && Math.random() < 0.35) {
      return { type: 'MOVE', target: player.position.clone(), sprint: false, speedFactor: 0.2 };
    }
    return { type: 'MOVE', target: pickDribbleTarget(player, team, opponentTeam, goalPos), sprint: true };
  }
  mem.holdTimer = 0;

  // 3순위: 압박을 받는 상태 → 옆/뒤라도 열린 동료가 있으면 안전하게 내준다
  const safeOptions = options.filter((o) => o.open);
  if (safeOptions.length > 0) {
    const best = safeOptions.reduce((a, b) => (b.score > a.score ? b : a));
    // 백패스는 압박이 강할수록, 그리고 위험지역이 아닐수록 허용 확률이 오른다
    const backpassProb = clamp01(0.35 + pressure * 0.25 - (inPenaltyArea ? 0.3 : 0));
    if (best.forwardProgress > 4 || Math.random() < backpassProb) {
      return { type: 'PASS', targetPlayer: best.player, lofted: best.distance > 28 };
    }
  }

  // 마지막: 아무 길도 없으면 압박을 피해 드리블 돌파
  return { type: 'MOVE', target: pickDribbleTarget(player, team, opponentTeam, goalPos), sprint: true };
}

/**
 * 모든 패스 후보를 평가해 배열로 반환한다. 각 후보의 `open`은 "수신자 주변에 상대가 없고
 * 패스 길목도 막히지 않았는가"를 뜻하며, 패스 여부 판단의 1차 조건으로 쓰인다.
 */
function collectPassOptions(player, team, opponentTeam) {
  const attackDir = team.attackingDirection;
  const goalPos = Pitch.goalCenter(attackDir === 1 ? 'right' : 'left');
  const isWinger = player.role === 'LM' || player.role === 'RM';
  const wingY = player.role === 'LM' ? Pitch.WIDTH * 0.15 : Pitch.WIDTH * 0.85;
  const options = [];

  for (const teammate of team.players) {
    if (teammate === player) continue;
    if (teammate.role === 'GK') continue; // 골키퍼 백패스는 별도 상황에서만
    const dist = teammate.position.sub(player.position).length();
    if (dist > 45 || dist < 3) continue;

    const forwardProgress = (teammate.position.x - player.position.x) * attackDir;

    // 수신자 주변 상대 수 — 6m 이내에 아무도 없어야 "열린" 동료로 본다
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
  const wingY = player.role === 'LM' ? Pitch.WIDTH * 0.15 : Pitch.WIDTH * 0.85;

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
  const pressFront = nearestOpp && nearestDist < 8;

  if (isWinger && pressFront) {
    // 윙어, 수비 압박 있음: 40% 확률로 중앙으로 드리블, 60%는 측면 유지
    if (Math.random() < 0.4) {
      steer = goalDir.scale(0.5).add(new Vector2D(0, centerY - player.position.y).normalize().scale(0.5)).normalize();
    } else {
      // 측면 유지: 골라인 방향 + 약간의 위험 회피
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
    // 윙어, 여유있음: 측면 라인 따라 진행
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

  if (player === presser) {
    if (distToBall < team.tactics.pressingTriggerDistance) {
      // 공 소지자에게 가까울 때(5m 이내)는 조킹(jockeying): 속도를 줄여 균형 유지
      const sprint = distToBall > 5;
      return moveIntent(ball.position.clone(), sprint);
    }
    // 멀면 스프린트로 접근
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
    const dangerZone = clamp01(1 - Math.abs(nearOpp.position.x - ownGoalX) / 30);
    const markTightness = 0.22 + dangerZone * 0.4;
    const laneSpot = Vector2D.lerp(ball.position, nearOpp.position, 0.65);
    target = Vector2D.lerp(target, laneSpot, markTightness);
  }

  // 위험 지역일수록 빠르게 복귀, 위험하지 않은 상황에서는 여유롭게 포지셔닝
  const ownGoalX = team.attackingDirection === 1 ? 0 : Pitch.LENGTH;
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
