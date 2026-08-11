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
 * 공을 갖지 않은 선수가 유지해야 할 목표 위치(진형 유지 + 볼 방향 셔플 + 공격/수비 시프트)를 계산한다.
 * GK는 GoalkeeperAI 쪽 로직에서 별도 처리하므로 이 함수는 호출되지 않는다.
 */
export function computeSupportPosition({ player, team, ball, inPossession }) {
  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;

  let target = player.basePosition.clone();

  // 1. 팀 전체가 볼 쪽으로 셔플(압축)되어 좁은 형태를 유지한다
  const shiftX = (ball.position.x - Pitch.LENGTH / 2) * 0.12;
  const shiftY = (ball.position.y - Pitch.WIDTH / 2) * 0.3;
  target = target.add(new Vector2D(shiftX, shiftY));

  // 2. 팀 폭(width) 지침을 센터라인 기준으로 적용
  const widthMul = team.tactics.widthMultiplier;
  const centerY = Pitch.WIDTH / 2;
  target.y = centerY + (target.y - centerY) * widthMul;

  const role = player.role;

  if (inPossession) {
    const forwardBias = team.tactics.mentalityForwardBiasMeters;
    const progress = clamp01(((ball.position.x - ownGoalX) * attackDir) / Pitch.LENGTH);
    const runBias = (FORWARD_RUN_FACTOR[role] ?? 0.3) * progress * 12;
    target.x += attackDir * (forwardBias + runBias);
  } else {
    const lineHeight = team.tactics.defensiveLineHeight;
    const lineDepth = 16 + lineHeight * 34; // 자기 골문에서부터 수비라인까지 거리(m)
    const desiredLineX = ownGoalX + attackDir * lineDepth;
    const blend = DEFENSIVE_BLEND[role] ?? 0.4;
    target.x = target.x * (1 - blend) + desiredLineX * blend;
  }

  return Pitch.clampInside(target, 1.2);
}

/** 압박할 수비수를 고를 때 사용: 볼과의 거리 + 정면 여부를 가중해 가장 적합한 압박 후보를 찾는다 */
export function findBestPresser(defendingPlayers, ball) {
  let best = null;
  let bestScore = Infinity;
  for (const p of defendingPlayers) {
    if (p.role === 'GK') continue;
    const dist = p.position.sub(ball.position).length();
    if (dist < bestScore) {
      bestScore = dist;
      best = p;
    }
  }
  return best;
}
