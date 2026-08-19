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
  GK: 0.02, CB: 0.05, LB: 0.06, RB: 0.06,
  CM: 0.35, LM: 0.30, RM: 0.30, ST: 0.22,
};
// ── 볼 사이드 Y 쏠림 가중치 (W_SHIFT): 수비 시 블록 전체 쏠림 강화
const W_SHIFT_DEF = 0.45;   // 수비: Y_center = 0.5 + (Y_ball - 0.5) × 0.45
const W_SHIFT_ATK = 0.35;   // 공격: 쏠림 약하게
// ── 반대편 좁히기 계수 (K_TUCK): ΔY에 비례해 파사이드 선수를 볼 쪽으로 당김
const K_TUCK_DEF  = 0.22;   // 수비: 강하게 좁힘
const K_TUCK_ATK  = 0.10;   // 공격: 약하게 좁힘
// 포지션별 X축 이동 한계 [min, max] (정규화 좌표)
// 공격수(LM/RM/ST) 최대값 상향: 더 높은 위치에서 침투 가능
// CB 최대값 0.55: 높은 수비 라인(하프라인-5m ≈ 0.45) + 공격적 멘탈리티 보정까지 수용
const X_LIMITS = {
  GK: [0.02, 0.08], CB: [0.04, 0.55], LB: [0.04, 0.78], RB: [0.04, 0.78],
  CM: [0.15, 0.72], LM: [0.12, 0.88], RM: [0.12, 0.88], ST: [0.25, 0.95],
};

// ═══════════════════════════════════════════════════════════════
//  3단계 설정 — 공수 상태별 간격 조절 (Phase Adjustment)
// ═══════════════════════════════════════════════════════════════
// 공격 시 전진량
// LB/RB 전진량 증가(0.26→0.32): 오버래핑 강화
// CB 전진량 증가(0.12→0.16): 높은 수비라인에서 빌드업 참여
const ATK_PUSH = {
  GK: 0.00, CB: 0.16, LB: 0.32, RB: 0.32,
  CM: 0.14, LM: 0.20, RM: 0.20, ST: 0.28,
};
// 공격 시 폭(Y) 확장 배율
const ATK_WIDTH = {
  GK: 1.0, CB: 1.0, LB: 1.22, RB: 1.22,
  CM: 1.05, LM: 1.25, RM: 1.25, ST: 1.05,
};
// 수비 시 폭(Y) 압축 배율 — 간격 좁히기(Compactness): 중앙 밀집으로 상대 중앙 패스 차단
const DEF_WIDTH = {
  GK: 1.0, CB: 0.82, LB: 0.74, RB: 0.74,
  CM: 0.80, LM: 0.70, RM: 0.70, ST: 0.92,
};

// ═══════════════════════════════════════════════════════════════
//  4단계 설정 — 선수 간 역제곱 척력 (Inverse-Square Repulsion)
// ═══════════════════════════════════════════════════════════════
const MIN_SEPARATION = 4.0;
const REPULSION_K = 6.0;
const REPULSION_RADIUS = 10.0;

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

/**
 * 수비 시 역할별 라인 목표(정규화 X, 0=자기 골문 ~ 1=상대 골문).
 * 수비 라인 높이(깊음~높음)와 볼 위치, 팀 멘탈리티를 함께 반영한다.
 * FormationPositioning과 PlayerMovementController 양쪽에서 공유한다.
 *
 * 볼이 상대 진영(ballNX >= 0.5)일 때의 목표 라인:
 *   깊음(0): CB 0.16(페널티박스 근처) / CM 0.29 / LM·RM 0.34 / ST 0.40(하프라인-10m)
 *   높음(1): CB 0.45(하프라인-5m)     / CM 0.55 / LM·RM 0.66 / ST 0.75(상대 최종라인-5m)
 * 볼이 우리 진영(ballNX < 0.5)에 들어올수록 블록 전체가 골문 쪽으로 내려선다.
 */
export function defensiveLineNX(role, team, ballNX) {
  const lh = team.tactics?.defensiveLineHeight ?? 0.5;
  let nx;
  if (role === 'CB' || role === 'LB' || role === 'RB') {
    nx = 0.16 + lh * 0.29;
  } else if (role === 'CM') {
    nx = 0.29 + lh * 0.26;
  } else if (role === 'LM' || role === 'RM') {
    nx = 0.34 + lh * 0.32;
  } else {
    nx = 0.40 + lh * 0.35; // ST
  }

  // 볼이 우리 진영에 가까울수록 후퇴 (높은 라인도 골문 근처에서는 컴팩트해진다)
  const retreatMax = 0.10 + lh * 0.22; // 0.10(깊음) ~ 0.32(높음)
  nx -= Math.max(0, (0.5 - ballNX) * 2) * retreatMax;

  // 팀 전술(수비적~공격적)도 라인 높이에 반영
  nx += team.tactics?.mentalityDefenceAdjust ?? 0;

  // 팀 전술 '수비적': 공격수도 수비 시 하프라인을 넘지 않고 내려선다
  if (!(team.tactics?.keepStrikerHigh ?? true)) {
    nx = Math.min(nx, 0.46);
  }
  return nx;
}

/**
 * 공격 시 역할별 라인 목표(정규화 X, 0=자기 골문 ~ 1=상대 골문).
 * 수비 라인과 대칭되는 "팀 공격 블록" — 볼 진행·팀 멘탈리티·수비 라인 높이에
 * 따라 전 라인이 하나의 블록처럼 함께 전진한다.
 *
 * 볼이 하프라인(ballNX=0.5)일 때 목표 라인:
 *   균형/중간라인: CB 0.22 / LB·RB 0.38 / CM 0.46 / LM·RM 0.52 / ST 0.58
 *   공격적/높음:   CB~0.46(한도) / LB·RB 0.46(한도) / CM 0.65 / LM·RM 0.71 / ST 0.77
 * 수비수(CB/LB/RB)는 defenderAdvanceLimit(수비 라인 높이 기반)를 넘지 않아,
 * 라인 높이 지시가 공격 진입 깊이까지 자연스럽게 전달된다.
 */
export function attackLineNX(role, team, ballNX) {
  const mentality = team.tactics?.mentalityAttackPush ?? 0;   // ±0.13
  const lh        = team.tactics?.defensiveLineHeight ?? 0.5;

  // 팀 공격 블록 기준선 — 볼이 전진할수록·공격적일수록·라인 높을수록 앞으로
  const blockBase = 0.24 + ballNX * 0.40 + mentality * 1.0 + (lh - 0.5) * 0.08;

  // 역할별 블록 내 상대 오프셋 (기준선 대비)
  const OFFSET = {
    GK: -0.40, CB: -0.20, LB: -0.04, RB: -0.04,
    CM: 0.04, LM: 0.10, RM: 0.10, ST: 0.16,
  };
  // 역할별 안전 상한 — 볼이 낮아도 한 선수가 지나치게 앞서지 않는다
  const MAX_SAFE = {
    GK: 0.12, CB: 0.55, LB: 0.72, RB: 0.72,
    CM: 0.80, LM: 0.88, RM: 0.88, ST: 0.92,
  };

  let nx = blockBase + (OFFSET[role] ?? 0);
  nx = clamp(nx, 0.02, MAX_SAFE[role] ?? 0.90);

  // 수비 라인 높이가 공격 진입 깊이의 상한을 정한다 (수비수 한정)
  if (role === 'CB' || role === 'LB' || role === 'RB') {
    nx = Math.min(nx, team.tactics?.defenderAdvanceLimit ?? 0.52);
  }
  return nx;
}

function teamLengthTarget(team) {
  if (team._teamLength === undefined) {
    team._teamLength = 36 + Math.random() * 8; // 36~44m에서 출발 (40m 중심)
  }
  // 전술에 따른 목표 길이 조정: 공격적 = 길게(벌림), 수비적 = 짧게(컴팩트)
  // 수비라인 높음 = 길게(벌림), 낮음 = 짧게(컴팩트)
  const mentality = team.tactics?.mentalityAttackPush ?? 0; // -0.5(수비적) ~ +0.5(공격적)
  const mentalityAdj = mentality * 4; // ±2m
  const lineHeight = team.tactics?.defensiveLineHeight ?? 0.5;
  const lineAdj = (lineHeight - 0.5) * 4; // ±2m (높음=+2m, 깊음=-2m)
  const targetLen = 40 + mentalityAdj + lineAdj;
  team._teamLength = clamp(team._teamLength + (targetLen - team._teamLength) * 0.02, 34, 50);
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
  // 수비 라인 높이가 클램프 하한에 묻히지 않도록, 라인 목표는 방어 구간에서
  // 항상 xMin보다 위에 서도록 defensiveLineNX가 보장한다 (dynXMin = xMin).
  let dynXMin = xMin;
  if (inPossession) {
    // 공격: X 전진 + Y 너비 확장
    const push         = ATK_PUSH[role] ?? 0.10;
    const widthMul     = (ATK_WIDTH[role] ?? 1.0) * (team.tactics?.widthMultiplier ?? 1.0);
    // 팀 전술: 공격적이면 전 라인이 크게 전진하고, 수비적이면 뒤에 남는다.
    // 전방 선수(ST/LM/RM)일수록 전술의 영향을 더 크게 받는다.
    const roleAtkGain = (role === 'ST' || role === 'LM' || role === 'RM') ? 1.35
      : (role === 'CM') ? 1.0
      : 0.7;
    const mentalityPush = (team.tactics?.mentalityAttackPush ?? 0) * roleAtkGain;
    nx += push + mentalityPush;
    ny  = 0.5 + (ny - 0.5) * widthMul;

    // 수비 라인 지시: 공격 시 수비수(CB/LB/RB)가 넘어갈 수 있는 상한.
    // 깊음이면 하프라인 아래에 잔류하고, 높음이면 하프라인까지 전진한다.
    if (role === 'CB' || role === 'LB' || role === 'RB') {
      const advLimit = team.tactics?.defenderAdvanceLimit ?? 0.5;
      nx = Math.min(nx, advLimit);
    }
  } else {
    // 수비: 수비 라인 높이가 라인 위치의 1차 요인이다.
    // 라인 목표(정규화 좌표, 0=자기 골문 ~ 1=상대 골문):
    //   깊음(0): 최종라인 페널티박스(~0.16) / 미드 10~15m 앞(~0.29) / 공격라인 하프라인-10m(~0.40)
    //   높음(1): 최종라인 하프라인-5m(~0.45) / 미드 그 사이(~0.55) / 공격라인 상대 최종라인-5m(~0.75)
    nx = defensiveLineNX(role, team, ballNX);
    // 수비 시 폭도 지시를 따른다 (좁음이면 중앙 밀집, 넓음이면 측면까지 커버)
    ny  = 0.5 + (ny - 0.5) * (DEF_WIDTH[role] ?? 0.90) *
          (team.tactics?.defensiveWidthMultiplier ?? 1.0);
    dynXMin = xMin;
  }
  nx = clamp(nx, dynXMin, xMax);
  ny = clamp(ny, 0.04, 0.96);

  // ── STEP 3: 쉬프팅 (Shifting) ────────────────────────────────
  // X: 볼 X 위치 방향으로 개별 보간 (SHIFT_X per role)
  // 수비 시에는 라인 목표가 이미 볼 위치를 반영하고 있으므로 볼 추적을 절반으로
  // 줄인다 — 깊은 수비 라인 팀이 상대 진영의 볼을 따라 미드·공격 라인까지
  // 올라붙는 것을 방지한다.
  const shiftW = (SHIFT_X[role] ?? 0.20) * (inPossession ? 1.0 : 0.35);
  nx = nx + (ballNX - nx) * shiftW;

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

  // ── 비상 후퇴 (Emergency Drop): 골키퍼 펀칭 직후 ─────────────
  // 골키퍼가 슛을 쳐내면 세컨볼·리바운드 위험이 최고조에 달한다. 전 라인이
  // 골문 쪽으로 일제히 내려와 골키퍼를 보호하고 폭도 좁혀 중앙을 메운다.
  // 후퇴량은 앞선일수록 크다(ST가 가장 많이 내려온다).
  if (role !== 'GK' && (team.emergencyDropTimer ?? 0) > 0) {
    const EMERGENCY_DROP = {
      CB: 0.04, LB: 0.08, RB: 0.08, CM: 0.20, LM: 0.24, RM: 0.24, ST: 0.32,
    };
    nx -= EMERGENCY_DROP[role] ?? 0.20;
    // 폭 압축: 중앙으로 모여 골문 앞을 메운다
    ny = 0.5 + (ny - 0.5) * 0.62;
  }

  // 최종 클램프
  nx = clamp(nx, dynXMin, xMax);
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
