import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

const DEFENSIVE_BLEND = {
  GK: 0.05,
  LB: 0.85,  // 풀백은 더 뒤로
  CB: 0.95,  // 센터백은 가장 뒤로
  RB: 0.85,
  LM: 0.35,  // 윙어는 중원 유지
  CM: 0.25,  // 미드필더는 앞으로 (중원에서 압박)
  RM: 0.35,
  ST: 0.1,   // 스트라이커는 거의 앞으로
};

const FORWARD_RUN_FACTOR = {
  GK: 0,
  LB: 0.5,
  CB: 0.2,
  RB: 0.5,
  LM: 0.9,
  CM: 0.7,
  RM: 0.9,
  ST: 1.2,
};

// 공격 중일 때만 적용되는 약한 방어적 블렌드(기본 위치로의 풀이 약함)
const ATTACKING_BLEND = {
  GK: 0.05,
  LB: 0.3,
  CB: 0.2,
  RB: 0.3,
  LM: 0.1,
  CM: 0.15,
  RM: 0.1,
  ST: 0.05,
};

/**
 * 공을 갖지 않은 선수가 유지해야 할 목표 위치(진형 유지 + 볼 방향 셔플 + 공격/수비 시프트)를 계산한다.
 * GK는 GoalkeeperAI 쪽 로직에서 별도 처리하므로 이 함수는 호출되지 않는다.
 */
export function computeSupportPosition({ player, team, ball, inPossession }) {
  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const opponentGoalX = attackDir === 1 ? Pitch.LENGTH : 0;

  let target = player.basePosition.clone();

  // 패스 수신자 근처에 모여서 서포트: passTargetPlayer가 있으면 그 주변에서 대기
  if (ball.passTargetPlayer && ball.passTargetPlayer.team === team && inPossession) {
    const receiver = ball.passTargetPlayer;
    if (player !== receiver) {
      const toReceiver = receiver.position.sub(player.position);
      const distToReceiver = toReceiver.length();
      if (distToReceiver < 20 && distToReceiver > 2.5) {
        // 수신자 근처에서 서포트: 수신자를 중심으로 3~6m 거리에 위치
        const supportDist = 3.5 + Math.random() * 2.5;
        const angle = toReceiver.angle() + (Math.random() - 0.5) * 1.0;
        target = receiver.position.add(Vector2D.fromAngle(angle).scale(supportDist));
      }
    }
  }

  // 1. 팀 전체가 볼 쪽으로 셔플(압축)되어 좁은 형태를 유지한다
  if (!ball.passTargetPlayer || player === ball.passTargetPlayer) {
    const shiftX = (ball.position.x - Pitch.LENGTH / 2) * 0.12;
    const shiftY = (ball.position.y - Pitch.WIDTH / 2) * 0.3;
    target = target.add(new Vector2D(shiftX, shiftY));
  }

  // 2. 팀 폭(width) 지침을 센터라인 기준으로 적용
  const widthMul = team.tactics.widthMultiplier;
  const centerY = Pitch.WIDTH / 2;
  target.y = centerY + (target.y - centerY) * widthMul;

  const role = player.role;

  if (inPossession) {
    const ballX = ball.position.x;
    const forwardDistance = FORWARD_RUN_FACTOR[role] ?? 0.3;
    const mentalityBonus = team.tactics.mentalityForwardBiasMeters;
    const ballInOpponentsHalf = (ballX - Pitch.LENGTH / 2) * attackDir > -5;
    const mem = player.brainMemory;

    let advanceTarget;
    if (role === 'ST' && ballInOpponentsHalf) {
      // ST: 기본 페널티 에어리어 엣지, 가끔 니어포스트/파포스트 방향으로 런 변화
      if (!mem.runVariant || Math.random() < 0.008) {
        mem.runVariant = Math.random(); // 0~1 값으로 런 패턴 결정
      }
      advanceTarget = opponentGoalX - attackDir * (14 + mem.runVariant * 10);
      // 런 변형에 따라 Y 축 위치도 조정 (중앙/측면 파고들기)
      target.y = target.y * (1 - 0.3) + (centerY + (mem.runVariant - 0.5) * 14) * 0.3;
    } else if ((role === 'LM' || role === 'RM') && ballInOpponentsHalf) {
      // 윙어: 사이드라인 돌파 또는 중앙 컷인 중 선택
      if (!mem.runVariant || Math.random() < 0.01) {
        mem.runVariant = Math.random();
      }
      const cutIn = mem.runVariant < 0.4; // 40% 확률로 중앙 컷인
      advanceTarget = opponentGoalX - attackDir * (cutIn ? 18 : 24);
      if (cutIn) {
        target.y = target.y * 0.6 + centerY * 0.4; // 중앙으로 이동
      }
    } else {
      advanceTarget = ballX + attackDir * (8 + forwardDistance * 15);
    }

    const blendFactor = 0.65;
    target.x = target.x * (1 - blendFactor) + advanceTarget * blendFactor;
    target.x += mentalityBonus;

    const maxForward = opponentGoalX - attackDir * 8;
    if ((target.x - ownGoalX) * attackDir > (maxForward - ownGoalX) * attackDir) {
      target.x = maxForward;
    }
  } else {
    const lineHeight = team.tactics.defensiveLineHeight;
    const lineDepth = 16 + lineHeight * 34; // 자기 골문에서부터 수비라인까지 거리(m)
    const desiredLineX = ownGoalX + attackDir * lineDepth;

    // 개인별 defensiveness: 높을수록 더 뒤로 물러남
    const defensiveness = player.brainMemory?.defensiveness ?? 0.5;
    const personalizedBlend = (DEFENSIVE_BLEND[role] ?? 0.4) + (defensiveness - 0.5) * 0.2;
    const blend = Math.min(0.95, Math.max(0.05, personalizedBlend));
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
