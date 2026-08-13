import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { computeFormationTarget, clampTeamLength } from './FormationPositioning.js';
import { computeOffBallAttack } from './OffBallAttack.js';

export function computeSupportPosition({ player, team, ball, inPossession, opponentTeam = null }) {
  // 5단계 포메이션 파이프라인으로 기본 위치 산출
  let target = computeFormationTarget({
    player,
    team,
    ball,
    inPossession,
    teammates: team.players,
    opponents: opponentTeam ? opponentTeam.players : null,
  });

  // 공격 시: 오프 더 볼 공격 움직임 + 동적 가중치 혼합 (Dynamic Weight Blending)
  if (inPossession) {
    const pAnchor   = target.clone(); // 포메이션 복귀 좌표 (순수 대형 위치)
    const pTactical = computeOffBallAttack({ player, team, opponentTeam, ball, baseTarget: pAnchor });

    // 역할별 포메이션 가중치 Wa: CB는 대형 유지, MF·FW는 전술 이동 최대화
    const role = player.role;
    let Wa;
    if      (role === 'GK')                    Wa = 1.00;
    else if (role === 'CB')                    Wa = 0.80;
    else if (role === 'LB' || role === 'RB')   Wa = 0.55;
    else if (role === 'CM')                    Wa = 0.30;
    else                                       Wa = 0.20; // LM, RM, ST

    // 침투 런은 포메이션 구속 완전 해제 (Wa=0) — 라인 뒤 공간으로 스프린트
    if (player.brainMemory.offBallBehavior === 'PENETRATING') {
      return Pitch.clampInside(pTactical, 1.2);
    }

    // P_target = Wa·P_anchor + Wt·P_tactical  (Wt = 1 - Wa)
    target = Vector2D.lerp(pAnchor, pTactical, 1.0 - Wa);
    target = clampTeamLength(target, player, team);
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
