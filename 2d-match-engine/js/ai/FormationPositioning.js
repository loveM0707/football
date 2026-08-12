import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ═══════════════════════════════════════════════════════════════
//  1단계 설정 — 활성 플레이 전진량 (Neutral Advance)
// ═══════════════════════════════════════════════════════════════
// 킥오프 포메이션 좌표에서 실제 플레이 기본 좌표로 전진하는 양
const NEUTRAL_ADVANCE = {
  GK: 0.00, CB: 0.05, LB: 0.06, RB: 0.06,
  CM: 0.06, LM: 0.06, RM: 0.06, ST: 0.05,
};

// ═══════════════════════════════════════════════════════════════
//  2단계 설정 — 팀 무게 중심 이동 (Block Shift)
// ═══════════════════════════════════════════════════════════════
// 볼 위치를 향한 보간(Lerp) 가중치 (0=고정, 1=완전 추적)
const SHIFT_X = {
  GK: 0.02, CB: 0.25, LB: 0.28, RB: 0.28,
  CM: 0.35, LM: 0.30, RM: 0.30, ST: 0.22,
};
const SHIFT_Y = {
  GK: 0.05, CB: 0.18, LB: 0.12, RB: 0.12,
  CM: 0.22, LM: 0.15, RM: 0.15, ST: 0.12,
};
// 포지션별 X축 이동 한계 [min, max] (정규화 좌표)
const X_LIMITS = {
  GK: [0.02, 0.08], CB: [0.10, 0.45], LB: [0.10, 0.55], RB: [0.10, 0.55],
  CM: [0.15, 0.68], LM: [0.12, 0.82], RM: [0.12, 0.82], ST: [0.25, 0.92],
};

// ═══════════════════════════════════════════════════════════════
//  3단계 설정 — 공수 상태별 간격 조절 (Phase Adjustment)
// ═══════════════════════════════════════════════════════════════
// 공격 시 전진량
const ATK_PUSH = {
  GK: 0.00, CB: 0.12, LB: 0.16, RB: 0.16,
  CM: 0.14, LM: 0.18, RM: 0.18, ST: 0.26,
};
// 공격 시 폭(Y) 확장 배율
const ATK_WIDTH = {
  GK: 1.0, CB: 1.0, LB: 1.12, RB: 1.12,
  CM: 1.05, LM: 1.25, RM: 1.25, ST: 1.05,
};
// 수비 시 후퇴량 (음수 = 오히려 전진, ST의 역습 대기용)
const DEF_PULL = {
  GK: 0.00, CB: 0.02, LB: 0.02, RB: 0.02,
  CM: 0.01, LM: 0.01, RM: 0.01, ST: -0.12,
};
// 수비 시 폭(Y) 압축 배율
const DEF_WIDTH = {
  GK: 1.0, CB: 0.88, LB: 0.82, RB: 0.82,
  CM: 0.86, LM: 0.80, RM: 0.80, ST: 1.0,
};

// ═══════════════════════════════════════════════════════════════
//  4단계 설정 — 선수 간 최소 유지 거리 (Separation)
// ═══════════════════════════════════════════════════════════════
const MIN_SEPARATION = 3.0; // 미터 (~30px)

// ═══════════════════════════════════════════════════════════════
//  5단계 파이프라인 실행
// ═══════════════════════════════════════════════════════════════

/**
 * 5단계 포메이션 포지셔닝 파이프라인
 *
 * 1단계: 기초 정규화 좌표 (Base Normalized Position)
 * 2단계: 팀 무게 중심 이동 (Block Shifting) — 볼 위치 기반 보간
 * 3단계: 공수 상태별 간격 조절 (Phase Adjustment) — 공격 확장 / 수비 압축
 * 4단계: 선수 간 밀어내기 (Repulsion) — Boids 분리 원리
 * 5단계: 미터 변환 + 경기장 경계 클램프 + 부드러운 이동 (PhysicsEngine 위임)
 */
export function computeFormationTarget({ player, team, ball, inPossession, teammates }) {
  const role = player.role;
  const attackDir = team.attackingDirection;
  const normBase = player.normalizedBase;

  if (!normBase) return player.basePosition.clone();

  // ── 1단계: 기초 정규화 좌표 ──────────────────────────────
  let nx = normBase.x + (NEUTRAL_ADVANCE[role] ?? 0.04);
  let ny = normBase.y;

  // 볼 위치를 자기편 관점 정규화 좌표로 변환 (0=자기 골문, 1=상대 골문)
  const ballNX = attackDir === 1
    ? ball.position.x / Pitch.LENGTH
    : 1 - ball.position.x / Pitch.LENGTH;
  const ballNY = ball.position.y / Pitch.WIDTH;

  // ── 2단계: 팀 무게 중심 이동 ─────────────────────────────
  // 자기 기본 위치에서 볼 위치를 향해 보간(Lerp)
  const xFactor = SHIFT_X[role] ?? 0.20;
  const yFactor = SHIFT_Y[role] ?? 0.15;

  nx = nx + (ballNX - nx) * xFactor;
  ny = ny + (ballNY - ny) * yFactor;

  // 포지션별 X 이동 한계 적용
  const [xMin, xMax] = X_LIMITS[role] ?? [0.05, 0.85];
  nx = clamp(nx, xMin, xMax);
  ny = clamp(ny, 0.04, 0.96);

  // ── 3단계: 공수 상태별 간격 조절 ─────────────────────────
  if (inPossession) {
    const push = ATK_PUSH[role] ?? 0.10;
    const widthMul = (ATK_WIDTH[role] ?? 1.0) * (team.tactics?.widthMultiplier ?? 1.0);
    const mentalityPush = { defensive: -0.04, balanced: 0.0, attacking: 0.05 }[
      team.tactics?.mentality
    ] ?? 0;

    nx += push + mentalityPush;
    ny = 0.5 + (ny - 0.5) * widthMul;
  } else {
    const pull = DEF_PULL[role] ?? 0.02;
    const widthMul = DEF_WIDTH[role] ?? 0.90;
    const lineAdj = ((team.tactics?.defensiveLineHeight ?? 0.5) - 0.5) * 0.08;

    nx -= pull;
    nx += lineAdj;
    ny = 0.5 + (ny - 0.5) * widthMul;
  }

  // 한계 재적용
  nx = clamp(nx, xMin, xMax);
  ny = clamp(ny, 0.04, 0.96);

  // ── 정규화 → 미터 변환 ───────────────────────────────────
  const meterX = attackDir === 1 ? nx * Pitch.LENGTH : (1 - nx) * Pitch.LENGTH;
  const meterY = ny * Pitch.WIDTH;
  let target = new Vector2D(meterX, meterY);

  // ── 4단계: 선수 간 밀어내기 (Separation) ─────────────────
  if (teammates) {
    let repulsion = Vector2D.zero();
    for (const mate of teammates) {
      if (mate === player || mate.role === 'GK') continue;
      const diff = target.sub(mate.position);
      const dist = diff.length();
      if (dist > 0.01 && dist < MIN_SEPARATION) {
        const force = (MIN_SEPARATION - dist) / MIN_SEPARATION;
        repulsion = repulsion.add(diff.normalize().scale(force * 1.5));
      }
    }
    target = target.add(repulsion);
  }

  // ── 5단계: 경기장 경계 클램프 ────────────────────────────
  // (부드러운 이동은 PhysicsEngine.movePlayer가 velocity 기반으로 처리)
  return Pitch.clampInside(target, 1.2);
}
