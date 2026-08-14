import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { computeFormationTarget, clampTeamLength } from './FormationPositioning.js';
import { computeOffBallAttack } from './OffBallAttack.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

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

    // 침투 런/오버래핑 런은 포메이션 구속 완전 해제 (Wa=0) — 라인 뒤·측면 공간으로 스프린트
    if (player.brainMemory.offBallBehavior === 'PENETRATING' ||
        player.brainMemory.offBallBehavior === 'OVERLAPPING') {
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

// ═══════════════════════════════════════════════════════════════
// 수비 서포트 (Defensive Support)
//
// 공격 서포트(OffBallAttack)와 분리된, 수비 전용 오프 더 볼 배치.
// 공 → 우리 골문 축(Goal Axis) 상의 "골 사이드" 깊이와 폭을 동시에 맞춰
// 수비 블록을 형성한다. 라인 정렬(computeDefensiveTarget)의 기준점(baseTarget)
// 으로 사용되어, 대인 마크·커버 섀도우보다 먼저 수비 자리를 잡는다.
// ═══════════════════════════════════════════════════════════════
const DEF_SUPPORT_COVER = {
  CB: 7, LB: 10, RB: 10, CM: 8, LM: 11, RM: 11, ST: 6,
};

export function computeDefensiveSupport({ player, team, opponentTeam, ball }) {
  const attackDir = team.attackingDirection;
  const ownGoal = Pitch.goalCenter(attackDir === 1 ? 'left' : 'right');
  const base = computeFormationTarget({
    player,
    team,
    ball,
    inPossession: false,
    teammates: team.players,
    opponents: opponentTeam ? opponentTeam.players : null,
  });

  // 공의 위치가 X_CLAMP 밖(골대 바로 옆)이면 축 계산이 어긋날 수 있어 안전 처리
  const goalLine = attackDir === 1 ? 0 : Pitch.LENGTH;
  const bx = Math.min(Math.max(ball.position.x, 2), Pitch.LENGTH - 2);
  const ballC = new Vector2D(bx, ball.position.y);

  const axis = ownGoal.sub(ballC);
  const axisLen = axis.length();
  if (axisLen < 1e-3) return Pitch.clampInside(base, 1.2);
  const axisDir = axis.normalize();

  // 역할별 골 사이드 커버 거리 — 볼이 우리 진영에 가까울수록(compact) 후퇴를 줄여 압축
  let coverDist = DEF_SUPPORT_COVER[player.role] ?? 8;
  coverDist += (Math.random() - 0.5) * 1.5;
  const ballDistFromGoal = Math.abs(ball.position.x - goalLine);
  const compact = clamp01(1 - ballDistFromGoal / 45); // 우리 골문 근처 → 1
  coverDist *= 0.65 + 0.55 * compact;

  const coverPoint = ballC.add(axisDir.scale(coverDist));

  // 폭(Width) 유지: 선수 기본 Y와 골-공 축 Y를 섞어 한 줄로 뭉치지 않게 한다
  const baseY = player.basePosition ? player.basePosition.y : Pitch.WIDTH / 2;
  const balanced = new Vector2D(coverPoint.x, coverPoint.y * 0.45 + baseY * 0.55);

  // 포메이션 앵커와 블렌드 — 안전성 유지 (CB는 더 보수적으로, ST는 반쯤만)
  const blend = player.role === 'CB' ? 0.75 : player.role === 'ST' ? 0.4 : 0.62;
  const target = Vector2D.lerp(base, balanced, blend);

  return Pitch.clampInside(target, 1.2);
}
