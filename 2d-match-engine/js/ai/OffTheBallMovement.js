import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { computeFormationTarget } from './FormationPositioning.js';

export function computeSupportPosition({ player, team, ball, inPossession, opponentTeam = null }) {
  // 5단계 포메이션 파이프라인으로 기본 위치 산출
  let target = computeFormationTarget({
    player,
    team,
    ball,
    inPossession,
    teammates: team.players,
  });

  // 전술적 오버레이 적용
  if (inPossession) {
    target = _applyAttackOverlays(target, player, team, ball, opponentTeam);
  }

  if (opponentTeam) {
    target = _applyMarkerEvasion(target, player, team, opponentTeam);
  }

  return Pitch.clampInside(target, 1.2);
}

function _applyAttackOverlays(target, player, team, ball, opponentTeam) {
  const role = player.role;
  const mem = player.brainMemory;
  const attackDir = team.attackingDirection;
  const opponentGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const centerY = Pitch.WIDTH / 2;
  const ballInOpponentsHalf = (ball.position.x - Pitch.LENGTH / 2) * attackDir > -5;

  // 패스 수신자 근처에서 서포트
  if (ball.passTargetPlayer && ball.passTargetPlayer.team === team && player !== ball.passTargetPlayer) {
    const receiver = ball.passTargetPlayer;
    const distToReceiver = receiver.position.sub(player.position).length();
    if (distToReceiver < 20 && distToReceiver > 2.5) {
      const supportDist = 3.5 + Math.random() * 2.5;
      const angle = receiver.position.sub(player.position).angle() + (Math.random() - 0.5) * 0.8;
      const supportTarget = receiver.position.add(Vector2D.fromAngle(angle).scale(supportDist));
      target = Vector2D.lerp(target, supportTarget, 0.35);
    }
  }

  // ST 전방 침투 변형
  if (role === 'ST' && ballInOpponentsHalf) {
    if (!mem.runVariant || Math.random() < 0.006) mem.runVariant = Math.random();
    const depth = 14 + mem.runVariant * 10;
    const runTarget = new Vector2D(
      opponentGoalX - attackDir * depth,
      target.y * 0.7 + (centerY + (mem.runVariant - 0.5) * 14) * 0.3
    );
    target = Vector2D.lerp(target, runTarget, 0.4);
  }

  // LM/RM 윙 포지셔닝
  if ((role === 'LM' || role === 'RM') && ballInOpponentsHalf) {
    if (!mem.runVariant || Math.random() < 0.006) mem.runVariant = Math.random();
    const cutIn = mem.runVariant < 0.35;
    const wingPos = role === 'LM' ? Pitch.WIDTH * 0.08 : Pitch.WIDTH * 0.92;

    const wingTarget = new Vector2D(
      opponentGoalX - attackDir * (cutIn ? 16 : 22),
      cutIn ? target.y * 0.5 + centerY * 0.5 : target.y * 0.2 + wingPos * 0.8
    );
    target = Vector2D.lerp(target, wingTarget, 0.35);
  }

  return target;
}

function _applyMarkerEvasion(target, player, team, opponentTeam) {
  let marker = null;
  let markerDist = Infinity;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const d = o.position.sub(player.position).length();
    if (d < markerDist) { markerDist = d; marker = o; }
  }
  if (marker && markerDist < 5) {
    const away = player.position.sub(marker.position).normalize();
    const escape = away.scale(3.0).add(new Vector2D(team.attackingDirection * 2.5, 0));
    target = target.add(escape);
  }
  return target;
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
