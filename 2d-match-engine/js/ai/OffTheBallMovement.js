import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

const DEFENSIVE_BLEND = {
  GK: 0.05,
  LB: 0.75,
  CB: 0.85,
  RB: 0.75,
  LM: 0.4,
  CM: 0.35,
  RM: 0.4,
  ST: 0.15,
};

const FORWARD_RUN_FACTOR = {
  GK: 0,
  LB: 0.3,
  CB: 0.05,
  RB: 0.3,
  LM: 0.7,
  CM: 0.5,
  RM: 0.7,
  ST: 1,
};

/**
 * 같은 편 선수들과의 간격을 유지하도록 목표 위치를 밀어내는 벡터를 계산한다.
 * 포메이션의 기본 골격은 그대로 두되, 선수들이 서로 뭉치거나 겹치지 않게 한다.
 */
export function separateFromTeammates(player, team, radius = 4.5) {
  let sep = Vector2D.zero();
  for (const t of team.players) {
    if (t === player) continue;
    const delta = player.position.sub(t.position);
    const dist = delta.length();
    if (dist < radius && dist > 1e-6) {
      sep = sep.add(delta.normalize().scale((radius - dist) / radius));
    }
  }
  return sep.scale(5);
}

/**
 * 공을 갖지 않은 선수가 유지해야 할 목표 위치(진형 유지 + 볼 방향 셔플 + 공격/수비 시프트)를 계산한다.
 * GK는 GoalkeeperAI 쪽 로직에서 별도 처리하므로 이 함수는 호출되지 않는다.
 */
export function computeSupportPosition({ player, team, ball, inPossession }) {
  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const centerY = Pitch.WIDTH / 2;

  let target = player.basePosition.clone();

  // 1. 팀 전체가 볼 쪽으로 셔플(압축)되어 좁은 형태를 유지한다
  const shiftX = (ball.position.x - Pitch.LENGTH / 2) * 0.12;
  const shiftY = (ball.position.y - centerY) * 0.25;
  target = target.add(new Vector2D(shiftX, shiftY));

  // 2. 팀 폭(width) 지침을 센터라인 기준으로 적용
  const widthMul = team.tactics.widthMultiplier;
  target.y = centerY + (target.y - centerY) * widthMul;

  const role = player.role;

  if (inPossession) {
    const forwardBias = team.tactics.mentalityForwardBiasMeters;
    const progress = clamp01(((ball.position.x - ownGoalX) * attackDir) / Pitch.LENGTH);
    const runBias = (FORWARD_RUN_FACTOR[role] ?? 0.3) * progress * 12;
    target.x += attackDir * (forwardBias + runBias);
  } else {
    // 수비 시: 볼의 위치에 따라 팀 블록 전체가 전후좌우로 움직이는 "포지션 압박" 형태를 만든다.
    // 볼을 직접 쫓는 선수는 압박자(1명)뿐이며, 나머지는 각자의 포지션을 지키며 형태를 유지한다.
    const ballProgress = clamp01(((ball.position.x - ownGoalX) * attackDir) / Pitch.LENGTH);

    // 1) 수비 라인: 볼이 자기 진영에 깊을수록 내려가고, 볼이 전진하면 함께 올라간다(라인 푸시)
    const lineHeight = team.tactics.defensiveLineHeight;
    const lineDepth = (16 + lineHeight * 34) * (0.6 + ballProgress * 0.8);
    const desiredLineX = ownGoalX + attackDir * lineDepth;
    const blend = DEFENSIVE_BLEND[role] ?? 0.4;
    target.x = target.x * (1 - blend) + desiredLineX * blend;

    // 2) 측면 슬라이드: 팀 전체가 볼의 y 위치 쪽으로 이동해 공격을 옆으로 몰아낸다
    target.y += (ball.position.y - centerY) * 0.45;

    // 3) 자기 진영에서는 폭을 좁혀 중앙으로 수렴하고, 볼이 전진하면 원래 폭을 되찾는다
    const compact = 0.55 + ballProgress * 0.6;
    target.y = centerY + (target.y - centerY) * compact;

    // 4) 볼이 자기 골문 가까이에 있으면 각 라인이 볼 쪽으로 살짝 압착한다(포지션 압박)
    const closeToOwnGoal = clamp01(1 - Math.abs(ball.position.x - ownGoalX) / 26);
    if (role !== 'ST') {
      target = Vector2D.lerp(target, ball.position, closeToOwnGoal * 0.1);
    }
  }

  // 3. 같은 편 선수와의 간격 유지(포메이션 유지 + 겹침 방지)
  target = target.add(separateFromTeammates(player, team));

  return Pitch.clampInside(target, 1.2);
}

/**
 * 압박할 수비수를 고를 때 사용: 볼과의 거리 + 볼보다 앞선(전방) 위치를 가중해
 * 뒷선이 우르르 나오지 않도록 가장 앞선 수비 자원이 압박하게 한다.
 */
export function findBestPresser(defendingPlayers, ball, team) {
  let best = null;
  let bestScore = Infinity;
  const attackDir = team.attackingDirection;
  for (const p of defendingPlayers) {
    if (p.role === 'GK') continue;
    const dist = p.position.sub(ball.position).length();
    const forwardness = Math.max(0, (p.position.x - ball.position.x) * attackDir);
    const score = dist - forwardness * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 두 번째 수비수(커버)를 고를 때 사용: 볼을 직접 쫓지 않고, 볼과 자기 골문 사이에서
 * 패스 길목을 차단해 2선 수비를 만들 선수를 찾는다.
 */
export function findBestCover(defendingPlayers, ball, ownGoalX, excludePlayer = null) {
  let best = null;
  let bestScore = Infinity;
  const ballGoalDist = Math.abs(ball.position.x - ownGoalX);
  for (const p of defendingPlayers) {
    if (p === excludePlayer) continue;
    if (p.role === 'GK') continue;
    const dist = p.position.sub(ball.position).length();
    const goalDist = Math.abs(p.position.x - ownGoalX);
    const onGoalSide = goalDist < ballGoalDist; // 볼보다 골문에 가까운(볼 뒤의) 선수 우선
    const score = dist - (onGoalSide ? 8 : 0) + goalDist * 0.04;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}
