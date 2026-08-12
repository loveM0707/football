import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ═══════════════════════════════════════════════════════════════
// 상대 소유 시(Out of Possession) 수비 알고리즘
//
// Stage 2: 압박 선수(Presser) 선정 — 공에서 가장 가까운 수비수 1~2명
// Stage 3: 대인 마크(Marking) + 커버 섀도우(Cover Shadow) 목표 계산
// Stage 1(수비 블록/간격 축소)은 FormationPositioning의 DEF 파이프라인이 담당
// ═══════════════════════════════════════════════════════════════

/** 공과 가장 가까운 수비수 maxCount명(골키퍼 제외)을 반환한다 */
export function findPressers(defendingPlayers, ball, maxCount = 1) {
  return defendingPlayers
    .filter((p) => p.role !== 'GK')
    .map((p) => ({ p, d: p.position.sub(ball.position).length() }))
    .sort((a, b) => a.d - b.d)
    .slice(0, maxCount)
    .map((e) => e.p);
}

/**
 * 1차 압박 접근 지점 (Approach Angle)
 * 무작정 공을 향하는 대신, 상대 선수와 우리 골대 사이 경로를 막는 궤적으로 접근한다.
 * 공에서 우리 골대 방향으로 18% 지점을 타겟으로 삼아, 전진 경로를 차단하면서 밀고 들어간다.
 */
export function computePresserTarget(ball, team, depth = 0.18) {
  const ownGoal = ownGoalCenter(team);
  return Vector2D.lerp(ball.position, ownGoal, depth);
}

/** 2차 압박 선수의 길목 차단 위치 (공보다 골대에 더 가까운 지점) */
export function computeCutoffTarget(ball, team) {
  return computePresserTarget(ball, team, 0.3);
}

/** 우리 진영 방향 벡터/목표 (attackingDirection 1 = 오른쪽 공격 → 왼쪽 골문) */
function ownGoalCenter(team) {
  return Pitch.goalCenter(team.attackingDirection === 1 ? 'left' : 'right');
}

/** 점 p와 선분 a→b 사이의 거리/투영 계수 */
function segmentDistance(p, a, b) {
  const ab = b.sub(a);
  const lenSq = ab.lengthSq();
  let t = lenSq > 1e-6 ? p.sub(a).dot(ab) / lenSq : 0;
  t = clamp01(t);
  const proj = a.add(ab.scale(t));
  return { dist: p.sub(proj).length(), t };
}

/**
 * Stage 3: DEFENDING 상태 선수의 목표 좌표 계산
 *
 *  - 수비 반경(Zone) 내 상대 공격수를 자기 기본 위치 기준으로 찾는다
 *  - 최우선: 공 소유자 → 마크 대상의 패스 레이 위에 서는 커버 섀도우 위치
 *    (이미 팀원이 그 레이를 막고 있으면 제외)
 *  - 차선: 상대 공격수와 우리 골대 사이(Goal-side) 대인 마크 위치
 */
export function computeDefensiveTarget({ player, team, opponentTeam, ball, baseTarget }) {
  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const ownGoal = ownGoalCenter(team);
  const carrier = ball.owner;

  // 수비 반경 내 상대 공격수 스캔 (자기 기본 위치 기준 16m)
  const markCandidates = [];
  for (const o of opponentTeam.players) {
    if (o.role === 'GK' || o === carrier) continue;
    const d = o.position.sub(player.basePosition).length();
    if (d < 16) markCandidates.push({ opp: o, d });
  }
  markCandidates.sort((a, b) => a.d - b.d);

  if (markCandidates.length === 0) {
    return { target: baseTarget, markTarget: null, behavior: 'BLOCK' };
  }

  // ── 커버 섀도우 (최우선 가중치) ──────────────────────────────
  if (carrier && carrier.team !== team) {
    const threatening = markCandidates
      .map(({ opp, d }) => {
        const danger = clamp01(1 - Math.abs(opp.position.x - ownGoalX) / 40);
        return { opp, d, danger };
      })
      .sort((a, b) => b.danger - a.danger);

    for (const cand of threatening) {
      // carrier→opp 레이 위, opp에서 carrier 쪽으로 2.5m 떨어진 지점
      const ray = cand.opp.position.sub(carrier.position);
      const len = ray.length();
      if (len < 1e-3) continue;
      const cover = carrier.position.add(ray.scale(Math.max(0, len - 2.5) / len));

      // 이미 다른 팀원이 이 레이를 막고 있는지 확인
      const coveredByTeammate = team.outfieldPlayers.some(
        (t2) => t2 !== player && segmentDistance(t2.position, carrier.position, cand.opp.position).dist < 1.6
      );
      if (coveredByTeammate) continue;

      // 유효 반경 내일 때만 채택
      if (player.position.sub(cover).length() < 13) {
        return {
          target: Pitch.clampInside(cover, 1.2),
          markTarget: cand.opp,
          behavior: 'COVER_SHADOW',
        };
      }
    }
  }

  // ── 대인 마크: 상대 공격수와 우리 골대 사이(Goal-side) ──────
  const mark = markCandidates[0];
  const danger = clamp01(1 - Math.abs(mark.opp.position.x - ownGoalX) / 40);
  const toOwnGoal = ownGoal.sub(mark.opp.position).normalize();
  const goalSide = mark.opp.position.add(toOwnGoal.scale(3.0 + danger * 2.5));
  const tightness = 0.35 + danger * 0.4;

  return {
    target: Pitch.clampInside(Vector2D.lerp(baseTarget, goalSide, tightness), 1.2),
    markTarget: mark.opp,
    behavior: 'MARKING',
  };
}