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
// ── 볼 사이드 Y 쏠림 가중치 (W_SHIFT): 수비 시 블록 전체 쏠림 강화
const W_SHIFT_DEF = 0.45;   // 수비: Y_center = 0.5 + (Y_ball - 0.5) × 0.45
const W_SHIFT_ATK = 0.35;   // 공격: 쏠림 약하게
// ── 반대편 좁히기 계수 (K_TUCK): ΔY에 비례해 파사이드 선수를 볼 쪽으로 당김
const K_TUCK_DEF  = 0.22;   // 수비: 강하게 좁힘
const K_TUCK_ATK  = 0.10;   // 공격: 약하게 좁힘
// ── X 블록 압축 (수비 시): 수비 라인(~0.12) 기준으로 전방 간격을 ScaleX배로 좁힘
const DEF_X_ANCHOR = 0.12;
const DEF_X_SCALE  = 0.70;
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
// 최후방 수비 라인과 최전방 공격 라인 사이 거리를 35~45m로 유지한다.
// 실제 축구에서 팀 컴팩트니스는 40m 내외로, 수비·공격 라인 간격이 좁아야 한다.
// 팀마다 목표치가 다르고 경기 중 조금씩 흔들려야 기계적으로 보이지 않는다.
const TEAM_LENGTH_MIN = 35;
const TEAM_LENGTH_MAX = 45;

// 전방 한계 미적용 포지션: ST·LM·RM은 수비 라인 위치에 관계없이 전진 위치를 유지한다
const FRONT_EXEMPT_ROLES = new Set(['ST', 'LM', 'RM']);

function teamLengthTarget(team) {
  if (team._teamLength === undefined) {
    team._teamLength = 36 + Math.random() * 8; // 36~44m에서 출발 (40m 중심)
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
 * 4단계 트랜스포메이션 파이프라인 — Anchor Position 산출
 *
 * STEP 1. Base Position      — normBase + NEUTRAL_ADVANCE
 * STEP 2. Scaling            — 공수 상태별 X 전진/후퇴, Y 너비 확장/압축, 수비 X블록 압축
 * STEP 3. Shifting           — 볼 X 보간(SHIFT_X) + 팀 블록 Y 무게 중심 이동(W_SHIFT)
 * STEP 4. Tucking-in         — 파사이드 선수 비대칭 좁히기 (ΔY 비례, K_TUCK)
 * → 이 P_anchor 위에 OffBallAttack의 P_tactical이 더해진다 (OffTheBallMovement에서 Lerp)
 */
export function computeFormationTarget({ player, team, ball, inPossession, teammates }) {
  const role      = player.role;
  const attackDir = team.attackingDirection;
  const normBase  = player.normalizedBase;

  if (!normBase) return player.basePosition.clone();

  // 볼 위치를 자기편 관점 정규화 좌표로 변환 (0=자기 골문, 1=상대 골문)
  const ballNX = attackDir === 1
    ? ball.position.x / Pitch.LENGTH
    : 1 - ball.position.x / Pitch.LENGTH;
  const ballNY = ball.position.y / Pitch.WIDTH;

  // ── STEP 1: 기초 정규화 좌표 (Base Position) ─────────────────
  let nx = normBase.x + (NEUTRAL_ADVANCE[role] ?? 0.04);
  let ny = normBase.y;

  // ── STEP 2: 블록 스케일링 (Scaling) ──────────────────────────
  const [xMin, xMax] = X_LIMITS[role] ?? [0.05, 0.85];
  if (inPossession) {
    // 공격: X 전진 + Y 너비 확장
    const push         = ATK_PUSH[role] ?? 0.10;
    const widthMul     = (ATK_WIDTH[role] ?? 1.0) * (team.tactics?.widthMultiplier ?? 1.0);
    const mentalityPush = { defensive: -0.04, balanced: 0.0, attacking: 0.05 }[
      team.tactics?.mentality
    ] ?? 0;
    nx += push + mentalityPush;
    ny  = 0.5 + (ny - 0.5) * widthMul;
  } else {
    // 수비: X 후퇴 + Y 압축 + X 블록 압축 (ScaleX)
    const pull    = DEF_PULL[role] ?? 0.02;
    const lineAdj = ((team.tactics?.defensiveLineHeight ?? 0.5) - 0.5) * 0.08;
    nx -= pull;
    nx += lineAdj;
    ny  = 0.5 + (ny - 0.5) * (DEF_WIDTH[role] ?? 0.90);

    // X 블록 압축: 수비 라인 앵커(~nx=0.12)를 기준으로 전방 간격을 ScaleX배로 좁힘
    // → CB는 거의 그대로, CM/LM은 중간, ST가 수비 블록 쪽으로 가장 많이 당겨짐
    if (role !== 'GK') {
      nx = DEF_X_ANCHOR + (nx - DEF_X_ANCHOR) * DEF_X_SCALE;
    }
  }
  nx = clamp(nx, xMin, xMax);
  ny = clamp(ny, 0.04, 0.96);

  // ── STEP 3: 쉬프팅 (Shifting) ────────────────────────────────
  // X: 볼 X 위치 방향으로 개별 보간 (SHIFT_X per role)
  nx = nx + (ballNX - nx) * (SHIFT_X[role] ?? 0.20);

  // Y: 팀 블록 전체를 볼 Y 쪽으로 이동 (W_SHIFT 균등 오프셋)
  // Y_center = 0.5 + (Y_ball − 0.5) × W_SHIFT
  // → 공이 터치라인(0 or 1)에 있어도 팀 중심은 0.275~0.725 이내로 제한됨
  if (role !== 'GK') {
    const wShift = role === 'CB'
      ? W_SHIFT_DEF * 0.55                              // CB는 쏠림 절반만
      : (inPossession ? W_SHIFT_ATK : W_SHIFT_DEF);
    ny += (ballNY - 0.5) * wShift;
  }

  // ── STEP 4: 반대편 좁히기 (Asymmetric Tucking-in) ─────────────
  // ΔY = |Y_base − Y_ball|, Y_target = Y_base + (Y_ball − Y_base) × (k_tuck × ΔY)
  // 볼에서 멀수록 ΔY가 크고 더 많이 당겨짐 — 볼 근처 선수는 거의 그대로 유지
  if (role !== 'GK') {
    const kTuck  = inPossession ? K_TUCK_ATK : K_TUCK_DEF;
    const deltaY = ny - ballNY;
    ny -= deltaY * kTuck * Math.abs(deltaY);
  }

  // 최종 클램프
  nx = clamp(nx, xMin, xMax);
  ny = clamp(ny, 0.04, 0.96);

  // ── 정규화 → 미터 변환 ───────────────────────────────────────
  let meterX = attackDir === 1 ? nx * Pitch.LENGTH : (1 - nx) * Pitch.LENGTH;
  const meterY = ny * Pitch.WIDTH;

  // ── 팀 종적 간격(최후방↔최전방) 유지 ─────────────────────────
  if (role !== 'GK' && teammates) {
    meterX = applyTeamLength(meterX, player, team, teammates, attackDir);
  }

  let target = new Vector2D(meterX, meterY);

  // ── 역제곱 척력 (F = k / r²) ──────────────────────────────────
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

  // ── 경기장 경계 클램프 ────────────────────────────────────────
  return Pitch.clampInside(target, 1.2);
}
