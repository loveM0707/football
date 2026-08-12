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

/** 수비 라인(백 4 등)을 구성하는 역할 */
const DEF_LINE_ROLES = ['LB', 'CB', 'RB'];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Stage 3.5: 수비 라인 평탄화 — X축 분산 σ_x 최소화
 *
 * 4백 등 수비 라인은 공의 X 좌표에 따라 함께 전후 이동하되, 수비수들 간의 X축
 * 좌표 분산이 최소화되도록 서로의 위치를 보정해 "일자 수비 라인"을 유지한다.
 * 대인 마크(위험 선수 밀착)가 강할수록 개인 포지션을 유지하고, 존 아웃(Zonal)
 * 상태일수록 라인 X로 수렴한다.
 *
 * @param {number} markStrength 0 = 존(라인 수렴) ~ 1 = 대인 마크(개인 포지션)
 */
export function alignDefensiveLine({ player, team, ball, target, markStrength = 0 }) {
  if (!DEF_LINE_ROLES.includes(player.role)) return target;

  const linePlayers = team.outfieldPlayers.filter((p) => DEF_LINE_ROLES.includes(p.role));
  if (linePlayers.length < 2) return target;

  const attackDir = team.attackingDirection;
  const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
  const ballDistFromGoal = Math.abs(ball.position.x - ownGoalX);

  // 공이 골문 가까이 → 라인 하강(수비 압축), 공이 멀면 → defensiveLineHeight에 따라 상승
  const baseLineX = ownGoalX + attackDir * clamp(20 + ballDistFromGoal * 0.28, 22, 44);
  const lineHeightAdj = ((team.tactics?.defensiveLineHeight ?? 0.5) - 0.5) * 16;
  const lineX = baseLineX + attackDir * lineHeightAdj;

  // 선수별 고정 지터(0.5~2.5m): 완벽한 레이저 라인은 아니되 σ_x는 작게 유지
  if (player._lineOffset === undefined) {
    player._lineOffset = (Math.random() - 0.5) * 2.2;
  }
  const alignedX = lineX + player._lineOffset;

  const blend = clamp01(1 - markStrength);
  return new Vector2D(target.x * (1 - blend) + alignedX * blend, target.y);
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
      // carrier→opp 직선(패스 경로) 위에 서서 물리적으로 차단한다.
      // 위험 선수일수록 더 바짝(공 쪽에 가깝게) 서서 전진 패스를 끊는다.
      const ray = cand.opp.position.sub(carrier.position);
      const len = ray.length();
      if (len < 1e-3) continue;
      const coverDistFromAttacker = 1.8 + cand.danger * 1.4; // 1.8~3.2m
      const cover = carrier.position.add(ray.scale(Math.max(0, len - coverDistFromAttacker) / len));

      // 이미 다른 팀원이 이 레이를 막고 있으면 중복 커버를 피한다
      const coveredByTeammate = team.outfieldPlayers.some(
        (t2) => t2 !== player && segmentDistance(t2.position, carrier.position, cand.opp.position).dist < 1.6
      );
      if (coveredByTeammate) continue;

      // 유효 반경 내일 때만 채택 (수비 라인 안쪽으로 지나치게 당겨지지 않게)
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

  return {
    target: Pitch.clampInside(Vector2D.lerp(baseTarget, goalSide, tightness), 1.2),
    markTarget: mark.opp,
    behavior: 'MARKING',
  };
}