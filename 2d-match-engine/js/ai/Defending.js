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

// ═══════════════════════════════════════════════════════════════
// 수비 라인 정렬 (Defensive Line Alignment)
//
// 같은 라인(CB, LB, RB)의 X좌표 분산(σx)을 최소화한다.
// 공의 X좌표를 기준으로 수비 라인 목표 X를 산출하고, 개별 선수의 X를
// 라인 평균 X 쪽으로 보정하여 일직선 수비를 유지한다.
// ═══════════════════════════════════════════════════════════════
const DEF_LINE_ROLES = new Set(['CB', 'LB', 'RB']);

export function alignDefensiveLine(targetX, player, team, ball) {
  if (!DEF_LINE_ROLES.has(player.role)) return targetX;

  const linemates = team.players.filter(p => DEF_LINE_ROLES.has(p.role) && p !== player);
  if (linemates.length === 0) return targetX;

  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const ballDistFromGoal = Math.abs(ball.position.x - ownGoalX);
  const baseLineX = ownGoalX + attackDir * Math.min(ballDistFromGoal * 0.65, 35);

  const lineXs = linemates.map(p => p.position.x);
  lineXs.push(targetX);
  const avgX = lineXs.reduce((s, x) => s + x, 0) / lineXs.length;

  // σx를 줄이기 위해 라인 평균 X로 보정 (강도 0.55)
  const aligned = targetX + (avgX - targetX) * 0.55;
  // 볼 기반 라인 깊이에도 끌어당기기 (강도 0.25)
  return aligned + (baseLineX - aligned) * 0.25;
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
    let blockTarget = baseTarget;
    const alignedX = alignDefensiveLine(blockTarget.x, player, team, ball);
    if (alignedX !== blockTarget.x) {
      blockTarget = new Vector2D(alignedX, blockTarget.y);
    }
    return { target: blockTarget, markTarget: null, behavior: 'BLOCK' };
  }

  // ── 커버 섀도우 (최우선 가중치) ──────────────────────────────
  // 공을 가진 상대(carrier)와 마크 대상(opp)을 잇는 직선 위에 서서
  // 패스 경로를 물리적으로 차단한다.
  if (carrier && carrier.team !== team) {
    const threatening = markCandidates
      .map(({ opp, d }) => {
        const danger = clamp01(1 - Math.abs(opp.position.x - ownGoalX) / 40);
        return { opp, d, danger };
      })
      .sort((a, b) => b.danger - a.danger);

    for (const cand of threatening) {
      const ray = cand.opp.position.sub(carrier.position);
      const len = ray.length();
      if (len < 1e-3) continue;

      // carrier→opp 직선 위, opp에서 carrier 쪽으로 30% 지점에 서서 패스를 차단
      const shadowT = Math.max(0.3, 1 - 3.0 / len);
      const cover = carrier.position.add(ray.scale(shadowT));

      const coveredByTeammate = team.outfieldPlayers.some(
        (t2) => t2 !== player && segmentDistance(t2.position, carrier.position, cand.opp.position).dist < 1.6
      );
      if (coveredByTeammate) continue;

      if (player.position.sub(cover).length() < 15) {
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

  let markTarget = Pitch.clampInside(Vector2D.lerp(baseTarget, goalSide, tightness), 1.2);
  // 수비 라인 정렬: CB/LB/RB는 X좌표를 라인 평균으로 보정
  const alignedX = alignDefensiveLine(markTarget.x, player, team, ball);
  if (alignedX !== markTarget.x) {
    markTarget = new Vector2D(alignedX, markTarget.y);
  }

  return {
    target: markTarget,
    markTarget: mark.opp,
    behavior: 'MARKING',
  };
}