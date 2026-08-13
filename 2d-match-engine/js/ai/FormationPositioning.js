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
  GK: 0.00, CB: 0.05, LB: 0.05, RB: 0.05,
  CM: 0.03, LM: 0.03, RM: 0.03, ST: -0.12,
};
// 수비 시 폭(Y) 압축 배율 — 간격 좁히기(Compactness): 중앙 밀집으로 상대 중앙 패스 차단
const DEF_WIDTH = {
  GK: 1.0, CB: 0.82, LB: 0.74, RB: 0.74,
  CM: 0.80, LM: 0.70, RM: 0.70, ST: 0.92,
};

// ═══════════════════════════════════════════════════════════════
//  4단계 설정 — 선수 간 역제곱 척력 (Inverse-Square Repulsion)
// ═══════════════════════════════════════════════════════════════
const MIN_SEPARATION = 3.0;
const REPULSION_K = 4.5;
const REPULSION_RADIUS = 8.0;

// ═══════════════════════════════════════════════════════════════
//  4.5단계 설정 — 팀 종적 간격 (Team Length / Compactness)
// ═══════════════════════════════════════════════════════════════
// 최후방 수비 라인과 최전방 공격 라인 사이 거리를 35~65m로 유지한다.
// 공격진(ST/LM/RM)은 전방 한계를 적용하지 않아 수비 블록이 깊어도 고위치를 유지한다.
// 팀마다 목표치가 다르고 경기 중 조금씩 흔들려야 기계적으로 보이지 않는다.
const TEAM_LENGTH_MIN = 35;
const TEAM_LENGTH_MAX = 65;

// 전방 한계 미적용 포지션: ST·LM·RM은 수비 라인 위치에 관계없이 전진 위치를 유지한다
const FRONT_EXEMPT_ROLES = new Set(['ST', 'LM', 'RM']);

function teamLengthTarget(team) {
  if (team._teamLength === undefined) {
    team._teamLength = 45 + Math.random() * 20; // 45~65m에서 출발
  }
  // 드물게 목표치를 다시 뽑아 라인 간격이 서서히 늘었다 줄었다 하게 만든다
  if (Math.random() < 0.0015) {
    team._teamLength = TEAM_LENGTH_MIN + Math.random() * (TEAM_LENGTH_MAX - TEAM_LENGTH_MIN);
  }
  return team._teamLength;
}

/** 선수별 고정 편차 — 같은 라인이라도 몇 미터씩 어긋나 일직선이 되지 않게 한다 */
function playerLengthJitter(player) {
  const mem = player.brainMemory;
  if (mem.lineJitter === undefined) mem.lineJitter = 0.86 + Math.random() * 0.28; // 0.86~1.14
  return mem.lineJitter;
}

/**
 * 팀의 종적 간격(최후방↔최전방)을 목표 범위 안으로 당긴다.
 * 앞선이 너무 나가면 끌어내리고, 그래도 늘어져 있으면 뒷선을 밀어 올린다.
 */
function applyTeamLength(meterX, player, team, teammates, attackDir) {
  const outfield = teammates.filter((p) => p.role !== 'GK');
  if (outfield.length < 2) return meterX;

  const xs = outfield.map((p) => p.position.x);
  const backX = attackDir === 1 ? Math.min(...xs) : Math.max(...xs);
  const frontX = attackDir === 1 ? Math.max(...xs) : Math.min(...xs);
  const len = teamLengthTarget(team) * playerLengthJitter(player);

  // ① 최후방 기준 len 이상 앞서 나가지 않는다 (공격진은 적용 제외 — 고위치 유지)
  if (!FRONT_EXEMPT_ROLES.has(player.role)) {
    const frontLimit = backX + attackDir * len;
    meterX = attackDir === 1 ? Math.min(meterX, frontLimit) : Math.max(meterX, frontLimit);
  }

  // ② 최전방 기준 len 이상 뒤처지지 않는다 (수비 라인 끌어올리기)
  const backLimit = frontX - attackDir * len;
  meterX = attackDir === 1 ? Math.max(meterX, backLimit) : Math.min(meterX, backLimit);

  return meterX;
}

// ═══════════════════════════════════════════════════════════════
//  5단계 파이프라인 실행
// ═══════════════════════════════════════════════════════════════

/**
 * 오프 더 볼 움직임까지 끝난 최종 목표에 팀 종적 간격 제한을 다시 적용한다.
 * (침투 런처럼 의도적으로 라인을 깨는 움직임은 호출부에서 제외한다)
 */
export function clampTeamLength(target, player, team) {
  if (player.role === 'GK') return target;
  const x = applyTeamLength(target.x, player, team, team.players, team.attackingDirection);
  return x === target.x ? target : new Vector2D(x, target.y);
}

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

    // 볼 사이드 쉬프트: 공이 측면에 있을 때 수비 블록 전체를 볼 쪽으로 추가 쏠림
    // 반대편 측면을 살짝 열어두더라도 공 주변 밀집도를 높인다 (GK 제외)
    if (role !== 'GK') {
      const ballSideShiftY = (ballNY - 0.5) * 0.12;
      ny += ballSideShiftY;
    }
  }

  // 한계 재적용
  nx = clamp(nx, xMin, xMax);
  ny = clamp(ny, 0.04, 0.96);

  // ── 정규화 → 미터 변환 ───────────────────────────────────
  let meterX = attackDir === 1 ? nx * Pitch.LENGTH : (1 - nx) * Pitch.LENGTH;
  const meterY = ny * Pitch.WIDTH;

  // ── 4.5단계: 팀 종적 간격(최후방↔최전방 30~50m) 유지 ─────
  if (role !== 'GK' && teammates) {
    meterX = applyTeamLength(meterX, player, team, teammates, attackDir);
  }

  let target = new Vector2D(meterX, meterY);

  // ── 4단계: 역제곱 척력 (F = k / r²) ─────────────────────
  if (teammates) {
    let repulsion = Vector2D.zero();
    for (const mate of teammates) {
      if (mate === player || mate.role === 'GK') continue;
      const diff = target.sub(mate.position);
      const r = diff.length();
      if (r < 0.3) {
        repulsion = repulsion.add(Vector2D.fromAngle(Math.random() * Math.PI * 2, 2));
      } else if (r < REPULSION_RADIUS) {
        const force = Math.min(REPULSION_K / (r * r), 3.0);
        repulsion = repulsion.add(diff.normalize().scale(force));
      }
    }
    target = target.add(repulsion);
  }

  // ── 5단계: 경기장 경계 클램프 ────────────────────────────
  // (부드러운 이동은 PhysicsEngine.movePlayer가 velocity 기반으로 처리)
  return Pitch.clampInside(target, 1.2);
}
