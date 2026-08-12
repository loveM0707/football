import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * 수비 시 각 역할이 수비 라인 대비 얼마나 뒤로 물러나는지.
 * CB가 가장 뒤(1.0), ST는 거의 앞에 남는다(0.08).
 */
const DEFENSIVE_DEPTH = {
  GK: 0.05,
  CB: 1.0,
  LB: 0.92,
  RB: 0.92,
  CM: 0.65,
  LM: 0.45,
  RM: 0.45,
  ST: 0.08,
};

/**
 * 공격 시 공 기준으로 얼마나 전방으로 침투하는가.
 */
const FORWARD_RUN_FACTOR = {
  GK: 0,
  CB: 0.15,
  LB: 0.45,
  RB: 0.45,
  CM: 0.6,
  LM: 0.85,
  RM: 0.85,
  ST: 1.2,
};

export function computeSupportPosition({ player, team, ball, inPossession, opponentTeam = null }) {
  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const opponentGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const centerY = Pitch.WIDTH / 2;
  const role = player.role;

  if (inPossession) {
    return _attackingPosition(player, team, ball, attackDir, ownGoalX, opponentGoalX, centerY, opponentTeam);
  }
  return _defendingPosition(player, team, ball, attackDir, ownGoalX, centerY, opponentTeam);
}

function _attackingPosition(player, team, ball, attackDir, ownGoalX, opponentGoalX, centerY, opponentTeam) {
  const role = player.role;
  const mem = player.brainMemory;
  const ballX = ball.position.x;
  const ballInOpponentsHalf = (ballX - Pitch.LENGTH / 2) * attackDir > -5;
  let target = player.basePosition.clone();

  // 패스 수신자 근처에서 서포트
  if (ball.passTargetPlayer && ball.passTargetPlayer.team === team && player !== ball.passTargetPlayer) {
    const receiver = ball.passTargetPlayer;
    const distToReceiver = receiver.position.sub(player.position).length();
    if (distToReceiver < 20 && distToReceiver > 2.5) {
      const supportDist = 3.5 + Math.random() * 2.5;
      const angle = receiver.position.sub(player.position).angle() + (Math.random() - 0.5) * 0.8;
      target = receiver.position.add(Vector2D.fromAngle(angle).scale(supportDist));
    }
  }

  // 공 위치에 따라 좌우 셔플 (팀 압축)
  const shiftX = (ball.position.x - Pitch.LENGTH / 2) * 0.08;
  const shiftY = (ball.position.y - centerY) * 0.18;
  target = target.add(new Vector2D(shiftX, shiftY));

  // 팀 폭(width) 전술
  const widthMul = team.tactics.widthMultiplier;
  target.y = centerY + (target.y - centerY) * widthMul;

  // 역할별 전진 위치
  const forwardFactor = FORWARD_RUN_FACTOR[role] ?? 0.3;
  const mentalityBonus = team.tactics.mentalityForwardBiasMeters;

  if (role === 'ST' && ballInOpponentsHalf) {
    if (!mem.runVariant || Math.random() < 0.006) mem.runVariant = Math.random();
    const depth = 14 + mem.runVariant * 10;
    target.x = opponentGoalX - attackDir * depth;
    target.y = target.y * 0.7 + (centerY + (mem.runVariant - 0.5) * 14) * 0.3;
  } else if ((role === 'LM' || role === 'RM') && ballInOpponentsHalf) {
    if (!mem.runVariant || Math.random() < 0.006) mem.runVariant = Math.random();
    const cutIn = mem.runVariant < 0.35;
    const wingPos = role === 'LM' ? Pitch.WIDTH * 0.08 : Pitch.WIDTH * 0.92;

    target.x = opponentGoalX - attackDir * (cutIn ? 16 : 22);
    target.y = cutIn
      ? target.y * 0.5 + centerY * 0.5
      : target.y * 0.2 + wingPos * 0.8; // 측면 더 넓게
  } else if (role === 'CB' || role === 'LB' || role === 'RB') {
    // 수비수: 공격 시에도 지나치게 올라가지 않음 - 역습 대비
    const maxAdvance = ownGoalX + attackDir * 42; // 하프라인 근처까지만
    const advanceTarget = ballX + attackDir * (5 + forwardFactor * 8);
    target.x = target.x * 0.4 + advanceTarget * 0.6;
    // 수비수 전진 제한
    if ((target.x - ownGoalX) * attackDir > (maxAdvance - ownGoalX) * attackDir) {
      target.x = maxAdvance;
    }
  } else {
    // CM 등: 중원 서포트
    const advanceTarget = ballX + attackDir * (8 + forwardFactor * 15);
    target.x = target.x * 0.35 + advanceTarget * 0.65;
  }

  target.x += mentalityBonus;

  // 마크 이탈: 상대에게 마크당하면 빈 공간으로
  if (opponentTeam) {
    let marker = null;
    let markerDist = Infinity;
    for (const o of opponentTeam.players) {
      if (o.role === 'GK') continue;
      const d = o.position.sub(player.position).length();
      if (d < markerDist) { markerDist = d; marker = o; }
    }
    if (marker && markerDist < 5) {
      const away = player.position.sub(marker.position).normalize();
      const escape = away.scale(3.5).add(new Vector2D(attackDir * 3, 0));
      target = target.add(escape);
    }
  }

  // 최전방 제한
  const maxForward = opponentGoalX - attackDir * 8;
  if ((target.x - ownGoalX) * attackDir > (maxForward - ownGoalX) * attackDir) {
    target.x = maxForward;
  }

  return Pitch.clampInside(target, 1.2);
}

function _defendingPosition(player, team, ball, attackDir, ownGoalX, centerY, opponentTeam) {
  const role = player.role;

  // 기본 수비 라인 계산 - 자기 골문에서부터의 거리
  const lineHeight = team.tactics.defensiveLineHeight;
  const lineDepth = 16 + lineHeight * 34;
  const desiredLineX = ownGoalX + attackDir * lineDepth;

  let target = player.basePosition.clone();

  // ST: 역습을 위해 최전방에 남는다 (position1.jpeg 흰팀 ST 참조)
  if (role === 'ST') {
    const stayForwardX = ownGoalX + attackDir * 70; // 상대 진영 3분의1 지점
    target.x = stayForwardX;
    // 볼 방향으로 약간 치우침
    target.y = target.y * 0.7 + ball.position.y * 0.3;
    return Pitch.clampInside(target, 1.2);
  }

  // 수비수(CB/LB/RB): 오프사이드 라인 형성 — 볼과 수비라인 중 더 뒤쪽에 정렬
  if (role === 'CB' || role === 'LB' || role === 'RB') {
    const ballLineX = ball.position.x - attackDir * 5; // 볼보다 5m 뒤
    // 수비 라인과 볼 라인 중 자기 골문에 더 가까운 쪽
    const lineX = ((ballLineX - ownGoalX) * attackDir < (desiredLineX - ownGoalX) * attackDir)
      ? ballLineX : desiredLineX;
    target.x = lineX;

    // 수비 블록: 볼 쪽으로 좌우 압축
    const compressY = (ball.position.y - centerY) * 0.25;
    target.y = target.y + compressY;

    return Pitch.clampInside(target, 1.2);
  }

  // LM/RM: 볼 사이드 쪽 미드필더는 볼 쪽으로 압축
  if (role === 'LM' || role === 'RM') {
    const midLineX = ownGoalX + attackDir * (lineDepth + 8);
    target.x = target.x * 0.3 + midLineX * 0.7;
    const compressY = (ball.position.y - centerY) * 0.3;
    target.y = target.y + compressY;
    return Pitch.clampInside(target, 1.2);
  }

  // CM: 수비수와 공격수 사이 중원 유지
  const cmLineX = ownGoalX + attackDir * (lineDepth + 10);
  target.x = target.x * 0.3 + cmLineX * 0.7;
  const compressY = (ball.position.y - centerY) * 0.25;
  target.y = target.y + compressY;

  return Pitch.clampInside(target, 1.2);
}

export function findBestPresser(defendingPlayers, ball) {
  let best = null;
  let bestDist = Infinity;
  for (const p of defendingPlayers) {
    if (p.role === 'GK') continue;
    const dist = p.position.sub(ball.position).length();
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}
