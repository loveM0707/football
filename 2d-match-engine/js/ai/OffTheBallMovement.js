import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { computeFormationTarget } from './FormationPositioning.js';
import { computeOffBallAttack } from './OffBallAttack.js';

export function computeSupportPosition({ player, team, ball, inPossession, opponentTeam = null }) {
  // 5단계 포메이션 파이프라인으로 기본 위치 산출
  let target = computeFormationTarget({
    player,
    team,
    ball,
    inPossession,
    teammates: team.players,
  });

  // 공격 시: 6단계 오프 더 볼 공격 움직임 알고리즘 적용
  if (inPossession) {
    target = computeOffBallAttack({ player, team, opponentTeam, ball, baseTarget: target });
    return Pitch.clampInside(target, 1.2);
  }

  if (opponentTeam) {
    target = _applyMarkerEvasion(target, player, team, opponentTeam);
  }

  return Pitch.clampInside(target, 1.2);
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
