/**
 * PlayerMovementController — 신규 선수 이동 제어기
 *
 * 기존 PlayerBrain.js + OffTheBallMovement.js 이동 로직을 교체하기 위한
 * 독립 모듈. 문제 발생 시 MatchSimulator의 USE_NEW_MOVEMENT 플래그를
 * false로 되돌리면 기존 로직으로 즉시 복귀 가능하다.
 *
 * 설계 계층(위 → 아래):
 *   경기 상태 → 팀 전술 상태 → 선수 역할 → 전술 목표 → 조향 목표
 *   → 가속도 → 속도 → 위치 (위치는 PhysicsEngine.movePlayer가 담당)
 */

import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import {
  selectPressers, MAX_TETHER,
  computePresserTarget, computeCutoffTarget, computeContainTarget,
  computeCoveringShift, isBreakawayDrive, computeBreakawayCover,
  shouldPress, computeDefensiveTarget,
} from './Defending.js';
import { computeDefensiveSupport } from './OffTheBallMovement.js';
import { defensiveLineNX } from './FormationPositioning.js';

// ═══════════════════════════════════════════════════
// 1단계: 기초 물리 — ARRIVE 조향 상수
// ═══════════════════════════════════════════════════

/** ARRIVE 감속 시작 반경 (m) — 이 거리 이내에서 목표까지 비례 감속 */
const SLOWING_RADIUS = 8.0;
/** ARRIVE 감속 시작 반경 (m) — 압박·마킹처럼 빠른 도달이 필요한 경우 */
const SLOWING_RADIUS_PRESS = 3.0;
/** 목표 도달 직전 최소 이동 속도 (m/s) — 미세 진동 방지용 하한 */
const MIN_MOVE_SPEED = 0.35;

// ═══════════════════════════════════════════════════
// 2단계: 전술 의사결정 간격
// ═══════════════════════════════════════════════════

/** 팀 역할 재배정 최소 주기 (초) */
const DECISION_INTERVAL_MIN = 0.12;
/** 팀 역할 재배정 최대 주기 (초) */
const DECISION_INTERVAL_MAX = 0.28;

// ═══════════════════════════════════════════════════
// 3단계: 팀 셰이프 — 역할별 볼 영향도
// 높을수록 볼 위치에 따라 자리를 많이 이동한다
// ═══════════════════════════════════════════════════
const BALL_SHIFT_W = {
  GK: 0.04, CB: 0.09, LB: 0.15, RB: 0.15,
  CM: 0.40, LM: 0.34, RM: 0.34, ST: 0.28,
};

// ═══════════════════════════════════════════════════
// 4단계: 포메이션 앵커 — 공수 상태별 X 이동량·Y 폭 배율
// ═══════════════════════════════════════════════════

/** 공격 시 전진량 (정규화 좌표) */
const ATK_PUSH = { GK: 0, CB: 0.07, LB: 0.18, RB: 0.18, CM: 0.12, LM: 0.16, RM: 0.16, ST: 0.20 };
/** 공격 시 폭(Y) 확장 배율 */
const ATK_WIDTH = { GK: 1.0, CB: 1.0, LB: 1.18, RB: 1.18, CM: 1.02, LM: 1.22, RM: 1.22, ST: 1.04 };
/** 수비 시 폭(Y) 압축 배율 */
const DEF_WIDTH = { GK: 1.0, CB: 0.84, LB: 0.76, RB: 0.76, CM: 0.82, LM: 0.70, RM: 0.70, ST: 0.92 };
/**
 * X축 이동 한계 [최소, 최대] (정규화) — 공격/수비 별도 적용
 * 공격 시 전방 선수가 상대 진영 깊이 진입할 수 있도록 상한을 높게 유지한다.
 */
const X_LIMITS_DEF = {
  GK: [0.01, 0.08], CB: [0.03, 0.50], LB: [0.03, 0.72], RB: [0.03, 0.72],
  CM: [0.10, 0.72], LM: [0.08, 0.88], RM: [0.08, 0.88], ST: [0.20, 0.95],
};
const X_LIMITS_ATK = {
  GK: [0.01, 0.10], CB: [0.05, 0.58], LB: [0.05, 0.82], RB: [0.05, 0.82],
  CM: [0.15, 0.82], LM: [0.12, 0.95], RM: [0.12, 0.95], ST: [0.35, 0.97],
};

// 볼 물리 상수 (PhysicsEngine과 동기화)
const BALL_MU = 2.6;

// ═══════════════════════════════════════════════════════
// 공간 탐지 그리드 — 10×7 셀, 5~10 Hz 업데이트
// ═══════════════════════════════════════════════════════
const GRID_COLS = 10;
const GRID_ROWS = 7;
const GRID_UPDATE_INTERVAL = 0.15; // 초 (약 6~7 Hz)

// 이동 모드 상수
const MODE_SUPPORT      = 'SUPPORT';        // 포메이션 앵커 + 패스 삼각형
const MODE_CHECK        = 'CHECK_TO_BALL';  // 볼 쪽으로 내려와 받기
const MODE_RUN_BEHIND   = 'RUN_BEHIND';     // 수비 라인 뒤 침투
const MODE_RUN_BETWEEN  = 'RUN_BETWEEN';    // 수비 사이 빈 공간 침투
const MODE_RUN_WIDE     = 'RUN_WIDE';       // 측면 폭 확보
const MODE_OVERLAP      = 'OVERLAP';        // 오버래핑 런 (측면 바깥)
const MODE_UNDERLAP     = 'UNDERLAP';       // 언더래핑 런 (측면 안쪽 하프스페이스)
const MODE_BOX_ENTRY    = 'BOX_ENTRY';      // 박스 진입
const MODE_RECOVER      = 'RECOVER';        // 수비 복귀
const MODE_THIRD_MAN    = 'THIRD_MAN_RUN';  // 서드맨 런 (A→B 패스 후 C가 위치)
const MODE_PASS_MOVE    = 'PASS_AND_MOVE';  // 패스 후 즉시 이동
const MODE_WEAK_SIDE    = 'WEAK_SIDE';      // 약측 공간 점유

// 이동 커밋 지속 시간 (초) — 러너가 방향을 바꾸지 않는 최소 시간
const COMMIT_MIN = 1.2;
const COMMIT_MAX = 2.4;

// 공간 예약 반경(m) — 이 반경 안에 다른 선수가 예약하면 겹치지 않는다
const RESERVATION_RADIUS = 5.0;
// 공간 예약 만료 시간(초)
const RESERVATION_TTL = 2.5;

// 패스 수신 FSM 상태
const RCV_APPROACH = 'RECEIVE_APPROACH'; // 예측 교차점으로 달려가는 단계
const RCV_BRAKE    = 'RECEIVE_BRAKE';    // 도달 직전 감속 단계
const RCV_CONTROL  = 'RECEIVE_CONTROL';  // 볼 제어 대기 단계

// 히스테리시스: 예측 교차점이 이 거리 이상 바뀌어야 목표를 갱신한다 (m)
const INTERCEPT_HYSTERESIS = 2.0;
// 브레이킹 판정 반경: 예측 교차점까지 이 거리 이하면 감속 시작 (m)
const BRAKE_RADIUS = 3.5;

// ─────────────────────────────────────────────────────
// 유틸 함수
// ─────────────────────────────────────────────────────

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function clamp01(v) { return clamp(v, 0, 1); }

/**
 * ARRIVE 조향: 목표까지 부드럽게 도달하는 희망 속도 벡터 계산.
 * slowingRadius 이내에서 거리에 비례해 속도를 낮춰 목표 지점에
 * 자연스럽게 멈춘다 (기존 단순 방향×속도 대비 과주행·진동 방지).
 */
function arriveVelocity(position, target, topSpeed, slowingRadius = SLOWING_RADIUS) {
  const toTarget = target.sub(position);
  const dist = toTarget.length();
  if (dist < 0.18) return Vector2D.zero();

  const dir = toTarget.normalize();
  let spd = topSpeed;
  if (dist < slowingRadius) {
    spd = Math.max(MIN_MOVE_SPEED, topSpeed * (dist / slowingRadius));
  }
  return dir.scale(spd);
}

/**
 * 시간 t 에서의 지상볼 위치를 예측한다 (선형 감속 모델).
 * pos(t) = p0 + v0*t - 0.5*BALL_MU*t²  (단, 볼이 정지한 이후는 최종 위치 고정)
 */
function predictBallPosition(ball, t) {
  const spd = ball.velocity.length();
  if (spd < 0.01) return ball.position.clone();
  const dir = ball.velocity.normalize();
  const tStop = spd / BALL_MU;
  const tClamped = Math.min(t, tStop);
  const d = spd * tClamped - 0.5 * BALL_MU * tClamped * tClamped;
  return ball.position.add(dir.scale(Math.max(0, d)));
}

/**
 * 수신자가 볼을 가로챌 수 있는 최적 시공간 교차점(위치, 시간)을 계산한다.
 * - 지상볼 한정. 공중볼은 현재 위치를 그대로 반환한다.
 * - 시간 샘플(0.05s 간격)마다 볼 예측 위치까지 선수 이동 거리와 비교.
 * - 도달 가능한 가장 이른 시각의 위치를 교차점으로 결정한다.
 * @returns {{ pos: Vector2D, ballETA: number, playerETA: number }}
 */
function findInterceptionPoint(ball, player) {
  const spd = ball.velocity.length();
  // 공중볼 또는 정지볼: 현재 위치로 달려간다
  if (spd < 0.5 || ball.height > 1.5) {
    const dist = player.position.sub(ball.position).length();
    const playerETA = dist / Math.max(player.maxSpeed, 0.1);
    return { pos: ball.position.clone(), ballETA: 0, playerETA };
  }

  const tStop = spd / BALL_MU;
  const step = 0.05;
  // 선수 최고 속도 (스프린트 기준)
  const pSpd = player.maxSpeed;

  for (let t = step; t <= Math.min(tStop + step, 6.0); t += step) {
    const ballPos = predictBallPosition(ball, t);
    const reachDist = pSpd * t;
    const toDist = player.position.sub(ballPos).length();
    if (toDist <= reachDist) {
      const playerETA = toDist / Math.max(pSpd, 0.1);
      return { pos: ballPos, ballETA: t, playerETA };
    }
  }

  // 도달 불가: 볼 최종 정지 위치
  const fd = (spd * spd) / (2 * BALL_MU);
  const finalPos = ball.position.add(ball.velocity.normalize().scale(fd));
  const dist = player.position.sub(finalPos).length();
  const playerETA = dist / Math.max(pSpd, 0.1);
  return { pos: finalPos, ballETA: tStop, playerETA };
}

/**
 * 지상볼 가로채기 지점 계산 (선형 감속 모델).
 * 선수가 도달 가능한 가장 이른 공 위치를 반환한다.
 */
function interceptPoint(ball, playerSpeed) {
  const spd = ball.velocity.length();
  if (spd < 0.5 || ball.height > 1.5) return ball.position.clone();

  const dir = ball.velocity.normalize();
  const tStop = spd / BALL_MU;
  for (let t = 0.05; t <= Math.min(tStop, 5.0); t += 0.05) {
    const d = Math.max(0, spd * t - 0.5 * BALL_MU * t * t);
    const pos = ball.position.add(dir.scale(d));
    if (ball.position.sub(pos).length() <= playerSpeed * t * 1.06) return pos;
  }
  // 공이 정지하는 최종 지점
  const fd = (spd * spd) / (2 * BALL_MU);
  return ball.position.add(dir.scale(fd));
}

/**
 * 팀의 자기 골문 중심 위치를 반환한다.
 */
function ownGoalCenter(team) {
  return Pitch.goalCenter(team.attackingDirection === 1 ? 'left' : 'right');
}

// ─────────────────────────────────────────────────────
// 팀 셰이프 중심 계산
// 수비 기준점(골문에서 공격 방향 22m) × (1−w) + 볼 위치 × w
// 소유 시 볼 가중치 높음(45%), 비소유 시 낮음(25%)
// ─────────────────────────────────────────────────────
function teamShapeCenter(team, ball, inPossession) {
  const dir = team.attackingDirection;
  const ownGoalX = dir === 1 ? 0 : Pitch.LENGTH;
  const defBaseX = ownGoalX + dir * 22;
  const w = inPossession ? 0.45 : 0.25;
  const cx = defBaseX * (1 - w) + ball.position.x * w;
  return new Vector2D(cx, Pitch.WIDTH / 2);
}

// ─────────────────────────────────────────────────────
// 선수 포메이션 앵커 계산
// 1) 정규화 기본 좌표 + 공수 상태별 스케일링
// 2) 볼 X/Y 방향 쉬프팅
// 3) 구역 클램프 → 미터 변환
// ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────
// 수비 라인 높이를 팀 블록 단위로 계산한다.
// FormationPositioning.defensiveLineNX와 동일한 라인 목표를 공유해,
// 복귀(RECOVER)·루즈볼 상황에서도 전술 패널의 깊음/균형/높음이 그대로
// 반영된 위치로 돌아간다.
// ─────────────────────────────────────────────────────
function formationAnchor(player, team, ball, inPossession) {
  const role = player.role;
  const dir = team.attackingDirection;
  const normBase = player.normalizedBase;
  if (!normBase) return player.basePosition ? player.basePosition.clone() : player.position.clone();

  const ballNX = dir === 1 ? ball.position.x / Pitch.LENGTH : 1 - ball.position.x / Pitch.LENGTH;
  const ballNY = ball.position.y / Pitch.WIDTH;

  let nx = normBase.x;
  let ny = normBase.y;

  if (inPossession) {
    nx += ATK_PUSH[role] ?? 0.08;
    ny = 0.5 + (ny - 0.5) * (ATK_WIDTH[role] ?? 1.0) * (team.tactics?.widthMultiplier ?? 1.0);
    // 수비수 전진 상한 (공격적 라인 높이 설정에 따라 더 전진 가능)
    if (role === 'CB' || role === 'LB' || role === 'RB') {
      nx = Math.min(nx, team.tactics?.defenderAdvanceLimit ?? 0.52);
    }
  } else {
    // 수비: FormationPositioning과 공유하는 라인 목표 (수비 라인 높이 + 볼 위치 기반)
    nx = defensiveLineNX(role, team, ballNX);
    ny = 0.5 + (ny - 0.5) * (DEF_WIDTH[role] ?? 0.90) * (team.tactics?.defensiveWidthMultiplier ?? 1.0);
  }

  // 볼 X 방향 보간 (볼이 앞에 있으면 선수도 따라 나온다)
  nx += (ballNX - nx) * (BALL_SHIFT_W[role] ?? 0.18);
  // 볼 Y 방향 쏠림 (GK 제외)
  if (role !== 'GK') {
    const wY = inPossession ? 0.30 : 0.42;
    ny += (ballNY - 0.5) * wY;
  }

  // 공수 상태별 X축 한계 적용 — 공격 시 전방 선수가 상대 진영 깊이 진입 가능
  const xLimits = inPossession ? X_LIMITS_ATK : X_LIMITS_DEF;
  const [xMin, xMax] = xLimits[role] ?? [0.05, 0.90];
  nx = clamp(nx, xMin, xMax);
  ny = clamp(ny, 0.04, 0.96);

  // 정규화 → 미터
  const mX = dir === 1 ? nx * Pitch.LENGTH : (1 - nx) * Pitch.LENGTH;
  const mY = ny * Pitch.WIDTH;
  return Pitch.clampInside(new Vector2D(mX, mY), 1.2);
}

// ─────────────────────────────────────────────────────
// 팀 종적 간격 제한 — 최후방↔최전방 거리를 35~45m 이내로 유지
// (기존 FormationPositioning의 clampTeamLength와 동일 로직)
// ─────────────────────────────────────────────────────
const FRONT_EXEMPT = new Set(['ST', 'LM', 'RM']);
const TEAM_LEN_MIN = 35;
const TEAM_LEN_MAX = 45;

function clampTeamLen(target, player, team) {
  if (player.role === 'GK') return target;
  const dir = team.attackingDirection;
  const outfield = team.players.filter(p => p.role !== 'GK');
  if (outfield.length < 2) return target;

  const xs = outfield.map(p => p.position.x);
  const backX = dir === 1 ? Math.min(...xs) : Math.max(...xs);
  const frontX = dir === 1 ? Math.max(...xs) : Math.min(...xs);

  if (!team._mc_len) team._mc_len = TEAM_LEN_MIN + Math.random() * (TEAM_LEN_MAX - TEAM_LEN_MIN);
  if (Math.random() < 0.002) team._mc_len = TEAM_LEN_MIN + Math.random() * (TEAM_LEN_MAX - TEAM_LEN_MIN);
  const len = team._mc_len;

  let mx = target.x;
  if (!FRONT_EXEMPT.has(player.role)) {
    const frontLimit = backX + dir * len;
    mx = dir === 1 ? Math.min(mx, frontLimit) : Math.max(mx, frontLimit);
  }
  const backLimit = frontX - dir * len;
  mx = dir === 1 ? Math.max(mx, backLimit) : Math.min(mx, backLimit);

  return mx === target.x ? target : new Vector2D(mx, target.y);
}

// ─────────────────────────────────────────────────────
// 공간 탐지 그리드
// 10×7 셀로 피치를 분할하고 각 셀의 "빈 공간" 점수를 계산한다.
// 점수 = 최근접 수비수까지 거리(m) − 최근접 동료까지 거리(m)×0.4
// 높을수록 수비가 없고 동료와 겹치지 않는 좋은 공간이다.
// ─────────────────────────────────────────────────────

/**
 * 피치 전체의 공간 점수 그리드를 계산한다.
 * @returns {Float32Array} GRID_COLS×GRID_ROWS 길이, 셀당 점수
 */
function buildSpaceGrid(team, opponentTeam) {
  const cw = Pitch.LENGTH / GRID_COLS;
  const rh = Pitch.WIDTH  / GRID_ROWS;
  const grid = new Float32Array(GRID_COLS * GRID_ROWS);

  const opponents = opponentTeam.players.filter(p => p.role !== 'GK');
  const teammates = team.players.filter(p => p.role !== 'GK');

  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const cx = (c + 0.5) * cw;
      const cy = (r + 0.5) * rh;

      // 최근접 수비수까지 거리
      let minOppDist = Infinity;
      for (const o of opponents) {
        const d = Math.hypot(o.position.x - cx, o.position.y - cy);
        if (d < minOppDist) minOppDist = d;
      }
      // 최근접 동료까지 거리 (겹침 페널티)
      let minMateDist = Infinity;
      for (const m of teammates) {
        const d = Math.hypot(m.position.x - cx, m.position.y - cy);
        if (d < minMateDist) minMateDist = d;
      }

      grid[r * GRID_COLS + c] = minOppDist - minMateDist * 0.4;
    }
  }
  return grid;
}

// ─────────────────────────────────────────────────────
// 공간 예약 시스템 (Phase 3/5)
//
// 팀 단위 예약 목록으로 복수 선수가 동일 공간으로 몰리는 것을 방지한다.
// team._reservations = [{ id, pos, radius, expiresAt }]
// ─────────────────────────────────────────────────────

function tickReservations(team, now) {
  if (!team._reservations) { team._reservations = []; return; }
  team._reservations = team._reservations.filter(r => r.expiresAt > now);
}

/** 이 선수의 목표 위치를 팀 예약 목록에 등록한다 */
function claimSpace(team, player, pos, now) {
  if (!team._reservations) team._reservations = [];
  // 이미 이 선수의 예약이 있으면 갱신
  const idx = team._reservations.findIndex(r => r.id === player.name);
  const entry = { id: player.name, pos, radius: RESERVATION_RADIUS, expiresAt: now + RESERVATION_TTL };
  if (idx >= 0) team._reservations[idx] = entry;
  else team._reservations.push(entry);
}

/**
 * 주어진 위치가 다른 선수의 예약 반경과 겹치는지 확인한다.
 * @returns {boolean} true이면 겹침 — 이 위치를 피해야 한다
 */
function isSpaceClaimed(team, player, pos) {
  if (!team._reservations) return false;
  for (const r of team._reservations) {
    if (r.id === player.name) continue;
    if (r.pos.sub(pos).length() < r.radius) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────
// 서드맨 런 감지 (Phase 4)
//
// A → B 패스가 비행 중일 때, 이 선수(C)가 수신자 B 근처 전방 공간으로
// 사전 진입하여 B가 즉시 C에게 릴리스할 수 있도록 준비한다.
// ─────────────────────────────────────────────────────

/**
 * 현재 볼이 동료 A→B로 비행 중이고 이 선수가 C일 때,
 * 서드맨 목표 위치를 반환한다. 조건 불만족 시 null 반환.
 */
function thirdManTarget(player, team, ball, grid) {
  // 볼이 비행 중이고 패스 대상이 우리팀 동료여야 한다
  if (!ball.passTargetPlayer) return null;
  if (ball.passTargetPlayer.team !== team) return null;
  // 이 선수는 패서도 수신자도 아니어야 한다
  if (ball.kicker === player) return null;
  if (ball.passTargetPlayer === player) return null;

  const receiver = ball.passTargetPlayer;
  const dir = team.attackingDirection;

  // 수신자 위치 기준 전방·대각 공간에서 빈 셀을 찾는다
  const recNX = dir === 1 ? receiver.position.x / Pitch.LENGTH
                           : 1 - receiver.position.x / Pitch.LENGTH;
  const spot = bestSpaceInZone(grid, team,
    clamp(recNX + 0.05, 0, 1),       // 수신자보다 약간 전방
    clamp(recNX + 0.30, 0, 1),
    0.1, 0.9
  );
  if (!spot) return null;

  // 빈 공간이 RESERVATION_RADIUS 이내에 예약된 경우 포기
  if (isSpaceClaimed(team, player, spot)) return null;

  return spot;
}

/**
 * 그리드에서 특정 X 구역(공격 방향 기준 normMin~normMax)의 최고 점수 셀 중심을 반환한다.
 * normMin/normMax: 0=우리골문, 1=상대골문 (정규화)
 */
function bestSpaceInZone(grid, team, normXMin, normXMax, normYMin = 0, normYMax = 1) {
  const dir = team.attackingDirection;
  const cw = Pitch.LENGTH / GRID_COLS;
  const rh = Pitch.WIDTH  / GRID_ROWS;

  let best = -Infinity;
  let bestPos = null;

  for (let c = 0; c < GRID_COLS; c++) {
    const meterX = (c + 0.5) * cw;
    // 정규화 X: dir=1이면 좌→우가 0→1
    const normX = dir === 1 ? meterX / Pitch.LENGTH : 1 - meterX / Pitch.LENGTH;
    if (normX < normXMin || normX > normXMax) continue;

    for (let r = 0; r < GRID_ROWS; r++) {
      const normY = (r + 0.5) / GRID_ROWS;
      if (normY < normYMin || normY > normYMax) continue;

      const score = grid[r * GRID_COLS + c];
      if (score > best) {
        best = score;
        bestPos = new Vector2D(meterX, (r + 0.5) * rh);
      }
    }
  }
  return bestPos;
}

// ─────────────────────────────────────────────────────
// 오프볼 이동 모드 선택
// 팀 상황·선수 역할·볼 위치를 종합하여 이동 모드를 결정한다.
// 이 함수는 _doAttackSupport에서 commitTimer가 만료될 때만 호출된다.
// ─────────────────────────────────────────────────────

/**
 * 수비 라인 깊이: 공격 방향 기준으로 상대 최후방 수비 라인 X 좌표를 반환한다.
 * @returns {number} 미터 단위 X
 */
function oppLastLineX(opponentTeam, dir) {
  const opp = opponentTeam.players.filter(p => p.role !== 'GK');
  if (!opp.length) return dir === 1 ? Pitch.LENGTH : 0;
  return dir === 1
    ? Math.max(...opp.map(p => p.position.x))
    : Math.min(...opp.map(p => p.position.x));
}

/**
 * 현재 상황에서 이 선수에게 가장 유리한 이동 모드를 반환한다.
 *
 * 우선순위:
 *   1. PASS_AND_MOVE  — 방금 패스한 선수: 즉시 이동
 *   2. THIRD_MAN_RUN  — 볼 비행 중 서드맨 기회 감지
 *   3. 역할·볼 위치 기반 모드
 */
// inPossession: 공격 지원 단계에서는 항상 true (수신자, 주자 모두 공격 모드)
// 비소유 전환은 selectOffBallMode 밖(_doDefense)에서 처리되므로
// 이 함수는 항상 "공격 소유 중" 맥락에서 호출된다.
// 그러나 볼 위치(ballNX)가 우리 진영 깊숙이에 있을 때 일부 역할은
// 수비 형태를 유지해야 하므로 볼 위치를 여전히 참고한다.
function selectOffBallMode(player, team, opponentTeam, ball, grid) {
  const role = player.role;
  const dir  = team.attackingDirection;

  // ── 우선순위 1: PASS_AND_MOVE — 방금 패스한 선수 ─────────────
  // ball.kicker가 이 선수이고 볼이 비행 중이면 패스 직후로 판정한다.
  // (패스 후 볼이 수신자에게 도달해도 잠시 유지: justPassedTimer로 관리)
  const justPassed = ball.kicker === player && !ball.owner;
  if (justPassed && role !== 'GK' && role !== 'CB') {
    return MODE_PASS_MOVE;
  }
  // justPassedTimer 연장 (caller가 설정한 경우)
  if ((player.brainMemory.justPassedTimer ?? 0) > 0 && role !== 'GK' && role !== 'CB') {
    return MODE_PASS_MOVE;
  }

  // ── 우선순위 2: THIRD_MAN_RUN — 볼 비행 중 서드맨 기회 ───────
  if (ball.passTargetPlayer && ball.passTargetPlayer.team === team &&
      ball.passTargetPlayer !== player && ball.kicker !== player) {
    const tmTarget = thirdManTarget(player, team, ball, grid);
    if (tmTarget) return MODE_THIRD_MAN;
  }

  // ── 볼 방향 기준 정규화 X ─────────────────────────────────────
  const ballNX = dir === 1
    ? ball.position.x / Pitch.LENGTH
    : 1 - ball.position.x / Pitch.LENGTH;

  // GK·CB: 항상 포메이션 서포트 (레스트 디펜스)
  if (role === 'GK' || role === 'CB') return MODE_SUPPORT;

  // 공격 소유 중이므로 전방 선수를 복귀시키지 않는다.
  // 볼이 우리 진영 극단(< 0.15)에 있을 때만 예외적으로 체크 이동 허용.
  // 이전 임계값(0.25)은 너무 넓어 ST/LM/RM이 상대 진영에 나가지 못했다.
  if (ballNX < 0.15) {
    if (role === 'ST') return MODE_CHECK;
    // LM/RM은 폭을 유지해 역습의 출구가 되도록 한다
    if (role === 'LM' || role === 'RM') return MODE_RUN_WIDE;
    return MODE_SUPPORT;
  }

  // 볼이 전방 3분의 1(> 0.67): 침투·박스 진입 기회
  if (ballNX > 0.67) {
    if (role === 'ST') return MODE_RUN_BEHIND;
    if (role === 'LM' || role === 'RM') return MODE_BOX_ENTRY;
    if (role === 'LB' || role === 'RB') {
      // 같은 쪽 풀백: OVERLAP / 반대쪽: UNDERLAP (하프스페이스 진입)
      const isSameSide = (role === 'LB' && ball.position.y < Pitch.WIDTH * 0.5) ||
                         (role === 'RB' && ball.position.y > Pitch.WIDTH * 0.5);
      return isSameSide ? MODE_OVERLAP : MODE_UNDERLAP;
    }
    if (role === 'CM') return MODE_RUN_BETWEEN;
  }

  // 볼이 중간 구역(0.45~0.67): 역할별 특화
  if (role === 'LM' || role === 'RM') {
    // 약측(볼과 반대편) 윙어: 약측 공간 점유
    const isWeakSide = (role === 'LM' && ball.position.y > Pitch.WIDTH * 0.6) ||
                       (role === 'RM' && ball.position.y < Pitch.WIDTH * 0.4);
    return isWeakSide ? MODE_WEAK_SIDE : MODE_RUN_WIDE;
  }
  if (role === 'ST') {
    const lineX = oppLastLineX(opponentTeam, dir);
    const gapToLine = dir === 1
      ? lineX - player.position.x
      : player.position.x - lineX;
    return gapToLine < 6 ? MODE_RUN_BEHIND : MODE_CHECK;
  }
  if (role === 'LB' || role === 'RB') {
    const isSameSide = (role === 'LB' && ball.position.y < Pitch.WIDTH * 0.5) ||
                       (role === 'RB' && ball.position.y > Pitch.WIDTH * 0.5);
    return isSameSide ? MODE_OVERLAP : MODE_SUPPORT;
  }
  if (role === 'CM') {
    // 그리드 중앙-전방에 빈 공간이 있으면 RUN_BETWEEN, 없으면 SUPPORT
    const bestSpot = bestSpaceInZone(grid, team, 0.45, 0.75, 0.2, 0.8);
    const spaceScore = bestSpot
      ? grid[Math.floor(bestSpot.y / (Pitch.WIDTH / GRID_ROWS)) * GRID_COLS +
             Math.floor(bestSpot.x / (Pitch.LENGTH / GRID_COLS))]
      : 0;
    return spaceScore > 5 ? MODE_RUN_BETWEEN : MODE_SUPPORT;
  }

  return MODE_SUPPORT;
}

// ─────────────────────────────────────────────────────
// 이동 모드별 목표 위치 계산
// ─────────────────────────────────────────────────────

/**
 * 선택된 이동 모드에 따라 목표 좌표를 계산하여 반환한다.
 */
function modeTarget(mode, player, team, opponentTeam, ball, grid) {
  const role = player.role;
  const dir  = team.attackingDirection;
  const anchor = formationAnchor(player, team, ball, true);

  switch (mode) {
    case MODE_RECOVER: {
      // 수비 복귀: 포메이션 앵커(비소유 상태 기준)로 신속 귀환
      return formationAnchor(player, team, ball, false);
    }

    case MODE_CHECK: {
      // 공 앞(5~8m)으로 내려와 받기 준비
      const checkX = ball.position.x - dir * clamp(5 + Math.random() * 3, 5, 8);
      const jitter = (Math.random() - 0.5) * 6;
      return Pitch.clampInside(new Vector2D(checkX, ball.position.y + jitter), 2);
    }

    case MODE_RUN_BEHIND: {
      // 수비 라인 뒤 공간으로 달린다 (라인 1.5m 뒤)
      const lineX = oppLastLineX(opponentTeam, dir);
      const runX  = dir === 1
        ? clamp(lineX + 1.5, Pitch.LENGTH * 0.5, Pitch.LENGTH - 4)
        : clamp(lineX - 1.5, 4, Pitch.LENGTH * 0.5);
      const runY  = clamp(anchor.y + (Math.random() - 0.5) * 12, 4, Pitch.WIDTH - 4);
      return new Vector2D(runX, runY);
    }

    case MODE_RUN_BETWEEN: {
      // 수비 라인 바로 앞 수비 간격 가장 넓은 공간
      const spot = bestSpaceInZone(grid, team, 0.45, 0.80, 0.15, 0.85);
      return spot ? Pitch.clampInside(spot, 2) : anchor;
    }

    case MODE_RUN_WIDE: {
      // 측면 극단 위치 — 볼이 전방이면 박스 가장자리
      const ballNX = dir === 1
        ? ball.position.x / Pitch.LENGTH
        : 1 - ball.position.x / Pitch.LENGTH;
      const sideY = role === 'LM' ? 3.5 : Pitch.WIDTH - 3.5;
      const wideX = ballNX > 0.6
        ? (dir === 1 ? Pitch.LENGTH - 12 : 12)
        : anchor.x;
      return Pitch.clampInside(new Vector2D(wideX, sideY), 1.5);
    }

    case MODE_OVERLAP: {
      // 볼 소유자보다 앞선 측면 위치 (측면 4m 안)
      const fwdX = ball.position.x + dir * clamp(6 + Math.random() * 4, 6, 10);
      const sideY = role === 'LB' ? 4.0 : Pitch.WIDTH - 4.0;
      const overX = dir === 1
        ? clamp(fwdX, Pitch.LENGTH * 0.3, Pitch.LENGTH - 5)
        : clamp(fwdX, 5, Pitch.LENGTH * 0.7);
      return Pitch.clampInside(new Vector2D(overX, sideY), 1.5);
    }

    case MODE_BOX_ENTRY: {
      // 박스 안(페널티 박스 가장자리)으로 진입
      const boxX = dir === 1
        ? Pitch.LENGTH - Pitch.PENALTY_BOX_LENGTH + 2
        : Pitch.PENALTY_BOX_LENGTH - 2;
      const entryY = role === 'LM'
        ? clamp(anchor.y, 4, Pitch.WIDTH * 0.45)
        : clamp(anchor.y, Pitch.WIDTH * 0.55, Pitch.WIDTH - 4);
      return Pitch.clampInside(new Vector2D(boxX, entryY), 1.5);
    }

    case MODE_UNDERLAP: {
      // 언더래핑: 풀백이 윙어 안쪽 하프스페이스(골문에서 15~20m 폭)로 진입
      // 윙어가 상대 수비를 외측으로 끌어당기는 동안 풀백이 안쪽 채널 공략
      const halfX = ball.position.x + dir * clamp(5 + Math.random() * 4, 5, 9);
      const clampedX = dir === 1
        ? clamp(halfX, Pitch.LENGTH * 0.35, Pitch.LENGTH - 5)
        : clamp(halfX, 5, Pitch.LENGTH * 0.65);
      // 하프스페이스 Y: 피치 폭의 약 25~40% 또는 60~75%
      const halfY = role === 'LB'
        ? clamp(anchor.y + 4, Pitch.WIDTH * 0.20, Pitch.WIDTH * 0.42)
        : clamp(anchor.y - 4, Pitch.WIDTH * 0.58, Pitch.WIDTH * 0.80);
      return Pitch.clampInside(new Vector2D(clampedX, halfY), 1.5);
    }

    case MODE_THIRD_MAN: {
      // 서드맨 런: A→B 패스 후 C가 B 전방 공간으로 선제 진입
      const tmPos = thirdManTarget(player, team, ball, grid);
      return tmPos ? Pitch.clampInside(tmPos, 2) : anchor;
    }

    case MODE_PASS_MOVE: {
      // 패스 후 이동: 패서가 즉시 전진 대각 방향으로 이동해 재수신 기회 창출
      // 볼 소유자(수신자) 기준 대각 전방 공간으로 7~10m 달린다
      const receiver = ball.passTargetPlayer ?? ball.owner;
      const baseX = receiver ? receiver.position.x : ball.position.x;
      const baseY = receiver ? receiver.position.y : ball.position.y;

      // 현재 선수 위치에서 볼(수신자) 반대편 대각으로 이동 → 원투패스 삼각형
      const yOffset = player.position.y < baseY ? -7 : 7;
      const fwdX = player.position.x + dir * 8;
      const moveX = dir === 1
        ? clamp(fwdX, Pitch.LENGTH * 0.25, Pitch.LENGTH - 5)
        : clamp(fwdX, 5, Pitch.LENGTH * 0.75);
      const moveY = clamp(player.position.y + yOffset, 3, Pitch.WIDTH - 3);
      return Pitch.clampInside(new Vector2D(moveX, moveY), 2);
    }

    case MODE_WEAK_SIDE: {
      // 약측 공간 점유: 볼과 반대편 측면을 넓히고 크로스 수신 대기
      const sideY = role === 'LM' ? 5.0 : Pitch.WIDTH - 5.0;
      // 박스 안이나 박스 가장자리로 이동 (크로스 수신 준비)
      const ballNX2 = dir === 1 ? ball.position.x / Pitch.LENGTH
                                 : 1 - ball.position.x / Pitch.LENGTH;
      const wsX = ballNX2 > 0.6
        ? (dir === 1 ? Pitch.LENGTH - 10 : 10)  // 박스 가장자리
        : anchor.x;
      return Pitch.clampInside(new Vector2D(wsX, sideY), 1.5);
    }

    case MODE_SUPPORT:
    default:
      return anchor;
  }
}

// ─────────────────────────────────────────────────────
// 공격 서포트 목표 위치 계산 (구버전 — 모드 시스템으로 대체됨)
// 역할별 공격 서포트 전략을 적용해 최적 위치를 반환한다
// ─────────────────────────────────────────────────────
function attackSupportTarget(player, team, opponentTeam, ball) {
  const role = player.role;
  const dir = team.attackingDirection;
  const anchor = formationAnchor(player, team, ball, true);

  // GK·CB: 안전판 역할 유지
  if (role === 'GK' || role === 'CB') return anchor;

  // 풀백(LB/RB): 볼이 같은 쪽에 있으면 오버래핑, 반대쪽이면 후방 커버
  if (role === 'LB' || role === 'RB') {
    const isNearSide = (role === 'LB' && ball.position.y < Pitch.WIDTH * 0.55) ||
                       (role === 'RB' && ball.position.y > Pitch.WIDTH * 0.45);
    if (isNearSide) {
      // 오버래핑: 볼 소유자보다 전진한 측면 위치
      const overlapX = clamp(
        ball.position.x + dir * 6,
        dir === 1 ? Pitch.LENGTH * 0.35 : 0,
        dir === 1 ? Pitch.LENGTH * 0.75 : Pitch.LENGTH * 0.65,
      );
      const sideY = role === 'LB' ? 6.0 : Pitch.WIDTH - 6.0;
      return Pitch.clampInside(new Vector2D(overlapX, sideY), 1.5);
    }
    return anchor;
  }

  // 윙어(LM/RM): 측면 폭 극대화 + 골문 쪽 박스 가장자리
  if (role === 'LM' || role === 'RM') {
    const yEdge = role === 'LM' ? 4.5 : Pitch.WIDTH - 4.5;
    // 볼이 전방에 있으면 박스 안으로 침투
    const ballFwdNX = dir === 1 ? ball.position.x / Pitch.LENGTH : 1 - ball.position.x / Pitch.LENGTH;
    if (ballFwdNX > 0.65) {
      // 박스 가장자리 + 하프스페이스 침투
      const penetrateX = dir === 1 ? Pitch.LENGTH - 14 : 14;
      return Pitch.clampInside(new Vector2D(penetrateX, yEdge), 1.5);
    }
    return Pitch.clampInside(new Vector2D(anchor.x, yEdge), 1.5);
  }

  // 스트라이커(ST): 상대 최후방 수비 라인 앞 깊이 확보
  if (role === 'ST') {
    const oppOutfield = opponentTeam.players.filter(p => p.role !== 'GK');
    const goalX = dir === 1 ? Pitch.LENGTH : 0;
    const lastDefX = oppOutfield.length > 0
      ? (dir === 1
          ? Math.max(...oppOutfield.map(p => p.position.x))
          : Math.min(...oppOutfield.map(p => p.position.x)))
      : goalX - dir * 12;
    // 수비 라인 바로 앞(온사이드 유지, 1.5m 여유)
    const depthX = dir === 1
      ? clamp(lastDefX - 1.5, Pitch.LENGTH * 0.45, Pitch.LENGTH - 8)
      : clamp(lastDefX + 1.5, 8, Pitch.LENGTH * 0.55);
    return Pitch.clampInside(new Vector2D(depthX, anchor.y), 1.5);
  }

  // CM: 패스 삼각형 지원 위치 (기본 앵커 사용)
  return anchor;
}

// ─────────────────────────────────────────────────────
// 골키퍼 이동 목표
// 볼 위치에 따라 각도 최소화 + 위험도에 따른 전진
// ─────────────────────────────────────────────────────
function gkTarget(gk, team, ball) {
  const dir = team.attackingDirection;
  const ownGoalX = dir === 1 ? 0 : Pitch.LENGTH;
  const [topY, botY] = Pitch.goalYRange();
  const centerY = (topY + botY) / 2;

  const ballDepth = Math.abs(ball.position.x - ownGoalX);
  const inDanger = ballDepth < 24;

  // Y: 볼 Y에 맞춰 골문 커버 (중심에서 최대 ±3m 이동)
  const gkY = clamp(centerY + (ball.position.y - centerY) * 0.38, topY - 0.5, botY + 0.5);

  // X: 위험 시 앞으로 나와 각도를 줄인다 (최대 4m 전진)
  const baseX = ownGoalX + dir * 5.5;
  let gkX = baseX;
  if (inDanger) {
    const advance = (1 - ballDepth / 24) * 4.0;
    gkX = ownGoalX + dir * (5.5 + advance);
  }
  // 공 소유 시: 배급 준비를 위해 약간 전진
  if (gk.hasBall) gkX = ownGoalX + dir * 7.5;

  return Pitch.clampInside(new Vector2D(gkX, gkY), 0.5);
}

// ─────────────────────────────────────────────────────
// 동료 간 겹침 방지 — 서포트 목표가 다른 동료 2m 이내면 밀어낸다
// ─────────────────────────────────────────────────────
function avoidTeammates(target, player, teammates, minGap = 3.5) {
  let result = target;
  for (const mate of teammates) {
    if (mate === player || mate.role === 'GK') continue;
    const diff = result.sub(mate.position);
    const d = diff.length();
    if (d < minGap && d > 0.01) {
      result = mate.position.add(diff.normalize().scale(minGap));
    } else if (d <= 0.01) {
      result = mate.position.add(Vector2D.fromAngle(Math.random() * Math.PI * 2).scale(minGap));
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════
// 메인 클래스
// ═══════════════════════════════════════════════════

export class PlayerMovementController {
  constructor() {
    /** 역할 재배정 대기 타이머 (초) */
    this._decisionTimer = 0;
  }

  // ──────────────────────────────────────────────
  // 팀 역할 배정 갱신 — MatchSimulator에서 매 틱 호출
  // ──────────────────────────────────────────────
  refreshRoles(team, opponentTeam, ball, dt) {
    this._decisionTimer = Math.max(0, this._decisionTimer - dt);
    if (this._decisionTimer <= 0) {
      this._decisionTimer = DECISION_INTERVAL_MIN +
        Math.random() * (DECISION_INTERVAL_MAX - DECISION_INTERVAL_MIN);
    }
  }

  // ──────────────────────────────────────────────
  // 단일 선수 이동 처리
  // player.desiredVelocity / player.desiredFacingAngle 을 직접 설정한다
  //
  // 이 메서드는 비소유(non-hasBall) 아웃필드 선수용이다.
  // GK와 볼 소유 선수는 기존 PlayerBrain이 계속 담당한다.
  // ──────────────────────────────────────────────
  update(player, team, opponentTeam, ball, dt) {
    // 스턴(태클 패배 멈칫) 처리
    const stun = player.brainMemory.stunTimer ?? 0;
    if (stun > 0) {
      player.brainMemory.stunTimer = Math.max(0, stun - dt);
      player.desiredVelocity = Vector2D.zero();
      return;
    }

    // GK 전용 처리 (볼 비소유 GK만 — hasBall인 GK는 기존 시스템 유지)
    if (player.role === 'GK') {
      const gt = gkTarget(player, team, ball);
      this._setVelocity(player, gt, 0.85, SLOWING_RADIUS);
      return;
    }

    // ── 패스 수신 대기 중 ───────────────────────────────
    if (ball.passTargetPlayer === player && !ball.owner) {
      // 수신 모드 진입 시 공격 오프볼 상태 초기화
      player.brainMemory.offBallMode = null;
      player.brainMemory.commitTimer = 0;
      this._receivePass(player, team, ball);
      return;
    }

    // ── 비수신 선수: 수신 FSM 상태 초기화 ──────────────
    if (player.brainMemory.receiveState) {
      player.brainMemory.receiveState  = null;
      player.brainMemory.receiveTarget = null;
    }

    // ── 점유 은혜 기간 타이머 갱신 ──────────────────────
    // 패스 비행 중(ball.owner == null)에도 직전 소유팀을 일정 시간 유지해
    // 팀 전체가 매 패스마다 수비 대형으로 급격히 내려앉는 것을 방지한다.
    if (!team._possGrace) team._possGrace = 0;
    if (ball.owner) {
      if (ball.owner.team === team) {
        team._possGrace = 1.5; // 점유 중: 1.5초 은혜 유지
      } else {
        team._possGrace = 0; // 상대팀 점유: 즉시 소멸
      }
    } else {
      team._possGrace = Math.max(0, team._possGrace - dt);
    }

    // 실제 소유 여부: ball.owner로 판정하되 은혜 기간 내에는 우리 팀 소유로 간주
    const inPossession = ball.owner
      ? ball.owner.team === team
      : team._possGrace > 0;

    if (!ball.owner && !inPossession) {
      // 상대팀 쪽 루즈볼 또는 은혜 기간 만료: 루즈볼 처리
      this._handleLooseBall(player, team, ball);
      return;
    }

    if (inPossession) {
      // ── 우리팀 소유 (또는 은혜 기간): 공격 서포트 포지셔닝 ─────────
      this._doAttackSupport(player, team, opponentTeam, ball, dt);
    } else {
      // ── 상대팀 소유: 수비 역할 수행 ─────────────────
      // 팀 예약 목록에서 이 선수 항목 제거 (수비 전환 시 공간 해제)
      if (team._reservations) {
        team._reservations = team._reservations.filter(r => r.id !== player.name);
      }
      this._doDefense(player, team, opponentTeam, ball, dt);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 패스 수신 처리 — 물리 기반 교차점 예측 + 수신 FSM
  //
  // FSM 상태 (player.brainMemory.receiveState):
  //   RECEIVE_APPROACH  : 예측 교차점을 향해 스프린트
  //   RECEIVE_BRAKE     : 교차점 근방 BRAKE_RADIUS 이내 → 감속 대기
  //   RECEIVE_CONTROL   : 볼 도달 직전 정지, 볼 방향으로 페이싱
  //
  // 교차점 히스테리시스: 재계산 결과가 기존 대비 INTERCEPT_HYSTERESIS(2m)
  // 이상 변할 때만 목표를 갱신하여 mid-run 진로 변경을 최소화한다.
  // ──────────────────────────────────────────────────────────────
  _receivePass(player, team, ball) {
    const mem = player.brainMemory;

    // 볼이 완전 정지하거나 소유자가 생기면 FSM 초기화
    const ballSpd = ball.velocity.length();
    if (ball.owner || ballSpd < 0.1) {
      mem.receiveState  = null;
      mem.receiveTarget = null;
      return;
    }

    // ── 교차점 계산 (매 프레임) ──────────────────────────────
    // 볼이 선수 쪽으로 날아오면(dot > 0.3) 볼 경로 직선 위에서
    // 선수 위치에 수직 투영한 가장 가까운 지점을 목표로 삼는다.
    // — 숏패스: 투영점 ≈ 선수 현재 위치 → 제자리에서 대기
    // — 롱패스(공중): 높이 무관하게 2D 경로 투영 → 선수 앞으로 달리지 않음
    // — 볼이 선수까지 도달 못하면: 투영이 maxDist로 클램프 → 정지 지점으로 이동
    const ballDir  = ballSpd > 0.5 ? ball.velocity.normalize() : Vector2D.zero();
    const toPlayer = player.position.sub(ball.position).normalize();
    const ballComingToward = ballDir.dot(toPlayer) > 0.3;

    let newIntercept, ballETA, playerETA;
    if (ballComingToward) {
      const ballToPlayer = player.position.sub(ball.position);
      const proj = ballToPlayer.dot(ballDir);
      const maxDist = (ballSpd * ballSpd) / (2 * BALL_MU);
      const targetDist = clamp(proj, 0, maxDist);

      newIntercept = Pitch.clampInside(ball.position.add(ballDir.scale(targetDist)), 1.0);

      // 볼이 투영 지점에 도달하는 시간: d = v0*t − ½μt² 역산
      const disc = ballSpd * ballSpd - 2 * BALL_MU * targetDist;
      ballETA   = disc > 0 ? (ballSpd - Math.sqrt(disc)) / BALL_MU : ballSpd / BALL_MU;
      playerETA = player.position.sub(newIntercept).length() / Math.max(player.maxSpeed, 0.1);
    } else {
      ({ pos: newIntercept, ballETA, playerETA } = findInterceptionPoint(ball, player));
    }

    // 히스테리시스: 이전 목표에서 2m 이상 벗어날 때만 갱신
    const prevTarget = mem.receiveTarget;
    if (!prevTarget || prevTarget.sub(newIntercept).length() > INTERCEPT_HYSTERESIS) {
      mem.receiveTarget    = newIntercept;
      mem.receiveBallETA   = ballETA;
      mem.receivePlayerETA = playerETA;
    }

    const target = mem.receiveTarget;
    const distToTarget = player.position.sub(target).length();
    const distToBall   = player.position.sub(ball.position).length();

    // ── FSM 상태 전이 ────────────────────────────────────────
    // CONTROL 진입: 볼까지 1.5m 이내 또는 목표까지 1.0m 이내
    if (distToBall <= 1.5 || distToTarget <= 1.0) {
      mem.receiveState = RCV_CONTROL;
    // BRAKE 진입: 목표까지 BRAKE_RADIUS 이내
    } else if (distToTarget <= BRAKE_RADIUS) {
      mem.receiveState = RCV_BRAKE;
    // APPROACH: 그 외
    } else {
      mem.receiveState = RCV_APPROACH;
    }

    // ── FSM 행동 ─────────────────────────────────────────────
    switch (mem.receiveState) {
      case RCV_CONTROL: {
        // 볼 방향으로 페이싱, 이동 정지
        const toBall = ball.position.sub(player.position);
        if (toBall.length() > 0.2) player.desiredFacingAngle = toBall.angle();
        player.desiredVelocity = Vector2D.zero();
        break;
      }
      case RCV_BRAKE: {
        // ARRIVE 감속: 목표에 비례해 속도를 줄인다. 볼보다 먼저 도착하면
        // 더 강하게 감속(arrivalError > 0 이면 brakeScale < 1)해 볼을 기다린다.
        const arrivalError = (mem.receivePlayerETA ?? 0) - (mem.receiveBallETA ?? 0);
        const brakeScale   = clamp(1.0 - arrivalError * 0.4, 0.25, 1.0);
        const slowR        = BRAKE_RADIUS * brakeScale;
        this._setVelocity(player, target, 0.9 * brakeScale, slowR, false);
        break;
      }
      case RCV_APPROACH:
      default: {
        // 스루패스는 골문 방향 소폭 리드 (볼과 함께 전진)
        let runTarget = target;
        if (ball.isThroughPass) {
          const goalCenter = Pitch.goalCenter(team.attackingDirection === 1 ? 'right' : 'left');
          const toGoal = goalCenter.sub(target);
          if (toGoal.length() > 0.5) {
            runTarget = Pitch.clampInside(target.add(toGoal.normalize().scale(1.2)), 1.0);
          }
        }
        this._setVelocity(player, runTarget, 1.0, SLOWING_RADIUS_PRESS, true);
        break;
      }
    }
  }

  // ──────────────────────────────────────────────
  // 루즈볼 처리 — 팀에서 가장 가까운 1명이 추격
  // ──────────────────────────────────────────────
  _handleLooseBall(player, team, ball) {
    const distToBall = player.position.sub(ball.position).length();
    const outfield = team.players.filter(p => p.role !== 'GK' && p !== player);
    const closestTeammateDist = outfield.length > 0
      ? Math.min(...outfield.map(p => p.position.sub(ball.position).length()))
      : Infinity;
    const isClosest = distToBall <= closestTeammateDist + 0.4;
    const hotBall = ball.velocity.length() > 2;

    if (isClosest && distToBall < (hotBall ? 22 : 6)) {
      const intercept = interceptPoint(ball, player.maxSpeed);
      this._setVelocity(player, intercept, 1.0, SLOWING_RADIUS_PRESS, true);
    } else {
      // 나머지: 포메이션 복귀
      const anchor = formationAnchor(player, team, ball, ball.lastTouchedTeam === team);
      const adjusted = clampTeamLen(anchor, player, team);
      const dist = player.position.sub(adjusted).length();
      const sf = dist > 14 ? 0.90 : dist > 5 ? 0.70 : 0.48;
      this._setVelocity(player, adjusted, sf);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 공격 서포트 포지셔닝 — 완전 통합 이동 모드 시스템 (Phase 5)
  //
  // 처리 순서 (계층 순):
  //   1. 팀 그리드·예약 갱신 (공유 상태)
  //   2. justPassedTimer 감소 (PASS_AND_MOVE 지속 판정)
  //   3. 커밋 만료 시 모드 재선택
  //   4. 모드별 목표 계산 (고정 모드는 커밋 중 목표 불변)
  //   5. 예약 충돌 감지 → 목표 미세 조정
  //   6. 동료 겹침 방지 + 팀 형태 클램프
  //   7. ARRIVE 조향 → desiredVelocity 설정
  //   8. 디버그 정보 저장
  // ──────────────────────────────────────────────────────────────
  _doAttackSupport(player, team, opponentTeam, ball, dt) {
    const mem = player.brainMemory;
    const now = Date.now() / 1000; // 예약 만료 기준 타임스탬프 (초)

    // ── 1: 팀 공간 그리드·예약 주기 갱신 ────────────────────
    team._gridTimer = (team._gridTimer ?? 0) - dt;
    if (team._gridTimer <= 0 || !team._spaceGrid) {
      team._spaceGrid = buildSpaceGrid(team, opponentTeam);
      team._gridTimer = GRID_UPDATE_INTERVAL + Math.random() * 0.05;
    }
    tickReservations(team, now);
    const grid = team._spaceGrid;

    // ── 2: justPassedTimer 감소 ───────────────────────────────
    // 볼을 방금 찬 선수(kicker)이면 타이머를 리셋, 아니면 감소
    if (ball.kicker === player && !ball.owner) {
      mem.justPassedTimer = 1.8; // 패스 후 1.8초간 PASS_AND_MOVE 유지
    } else {
      mem.justPassedTimer = Math.max(0, (mem.justPassedTimer ?? 0) - dt);
    }

    // ── 3: 커밋 타이머 감소 및 모드 재선택 ───────────────────
    mem.commitTimer = Math.max(0, (mem.commitTimer ?? 0) - dt);

    if (mem.commitTimer <= 0 || !mem.offBallMode) {
      const newMode = selectOffBallMode(player, team, opponentTeam, ball, grid);
      if (newMode !== mem.offBallMode) {
        mem.offBallMode       = newMode;
        mem.offBallModeTarget = null; // 목표 초기화 → 다음 단계에서 재계산
        mem.commitTimer       = COMMIT_MIN + Math.random() * (COMMIT_MAX - COMMIT_MIN);
      } else {
        mem.commitTimer = COMMIT_MIN * 0.55; // 같은 모드 유지 시 짧은 재확인 주기
      }
    }

    // ── 4: 목표 계산 ──────────────────────────────────────────
    // 커밋 중 고정 모드: 목표를 변경하지 않아 비현실적 방향 전환 방지
    const FIXED_MODES = new Set([
      MODE_RUN_BEHIND, MODE_RUN_BETWEEN, MODE_CHECK,
      MODE_OVERLAP, MODE_UNDERLAP, MODE_BOX_ENTRY,
      MODE_THIRD_MAN, MODE_PASS_MOVE,
    ]);
    const needsRecalc = !mem.offBallModeTarget || !FIXED_MODES.has(mem.offBallMode);
    if (needsRecalc) {
      mem.offBallModeTarget = modeTarget(mem.offBallMode, player, team, opponentTeam, ball, grid);
    }

    // ── 5: 예약 충돌 감지 → 목표 미세 조정 ──────────────────
    // 다른 선수가 이미 이 공간을 예약했으면 3m 반경 밖으로 밀어낸다
    let target = mem.offBallModeTarget;
    if (isSpaceClaimed(team, player, target)) {
      // 현재 선수 위치 기준 반대 방향으로 3.5m 이동
      const nudge = player.position.sub(target);
      const nl = nudge.length();
      target = nl > 0.1
        ? target.add(nudge.normalize().scale(3.5))
        : target.add(Vector2D.fromAngle(Math.random() * Math.PI * 2).scale(3.5));
    }
    // 이 선수의 최종 목표를 예약 목록에 등록
    claimSpace(team, player, target, now);

    // ── 6: 동료 겹침 방지 + 팀 형태 클램프 ──────────────────
    target = avoidTeammates(target, player, team.players);
    target = clampTeamLen(target, player, team);
    target = Pitch.clampInside(target, 1.2);

    // ── 7: ARRIVE 조향 → desiredVelocity 설정 ────────────────
    // 스프린트 모드: 침투·박스 진입·서드맨·패스후이동은 전력 질주
    const SPRINT_MODES = new Set([
      MODE_RUN_BEHIND, MODE_RUN_BETWEEN,
      MODE_OVERLAP, MODE_UNDERLAP, MODE_BOX_ENTRY,
      MODE_THIRD_MAN, MODE_PASS_MOVE,
    ]);
    const isSprint = SPRINT_MODES.has(mem.offBallMode);
    const dist = player.position.sub(target).length();

    if (isSprint) {
      this._setVelocity(player, target, 1.0, SLOWING_RADIUS, true);
    } else if (mem.offBallMode === MODE_RECOVER) {
      // 수비 복귀: 빠르되 전력질주는 아님
      const sf = dist > 10 ? 0.92 : dist > 4 ? 0.75 : 0.52;
      this._setVelocity(player, target, sf);
    } else {
      const sf = dist > 14 ? 0.88 : dist > 6 ? 0.68 : 0.48;
      this._setVelocity(player, target, sf);
    }

    // ── 8: 디버그 정보 저장 ───────────────────────────────────
    mem.offBallBehavior = mem.offBallMode;
    mem.offBallTarget   = target;
  }

  // ──────────────────────────────────────────────
  // 수비 역할 수행
  //
  // 기존 decideDefensiveOffBall()과 동일한 수비 판정 로직을 사용하되
  // moveIntent() 대신 ARRIVE 조향(_setVelocity)을 적용한다.
  // Defending.js의 검증된 함수들을 그대로 재활용하여 방어 품질을 보장한다.
  // ──────────────────────────────────────────────
  _doDefense(player, team, opponentTeam, ball, dt) {
    const mem = player.brainMemory;
    const distToBall = player.position.sub(ball.position).length();
    const ownGoalX = team.attackingDirection === 1 ? 0 : Pitch.LENGTH;
    const carrier = ball.owner;

    // 수비 전환 시 공격 오프볼 상태 초기화
    mem.offBallBehavior = null;
    mem.offBallTarget = null;

    // ── 후방 장거리 드리블 감지 (Breakaway Drive) ──────────────
    const isLongDrive = isBreakawayDrive({ team, ball, ownGoalX });
    mem.coverTimer = Math.max(0, (mem.coverTimer ?? 0) - dt);
    if (isLongDrive) mem.coverTimer = 0.6;
    const coverActive = (mem.coverTimer ?? 0) > 0;
    const longDrive = isLongDrive || coverActive;

    // ── 오프사이드 라인 전방 드리블 감지 (라인 고립) ─────────
    const attackDirDef = team.attackingDirection;
    const defOut = team.outfieldPlayers ?? team.players.filter(p => p.role !== 'GK');
    let lineIsolated = false;
    if (carrier && carrier.team !== team && carrier.hasBall && defOut.length > 0) {
      const lineLastX = attackDirDef === 1
        ? Math.max(...defOut.map(p => p.position.x))
        : Math.min(...defOut.map(p => p.position.x));
      const carrierOnLine = Math.abs(carrier.position.x - lineLastX) <= 10;
      const carrierAheadOfLine = attackDirDef === 1
        ? carrier.position.x > lineLastX + 2
        : carrier.position.x < lineLastX - 2;
      const carrierDribblingFwd = !!carrier.velocity &&
        carrier.velocity.length() > 0.3 &&
        (attackDirDef === 1 ? carrier.velocity.x < -0.3 : carrier.velocity.x > 0.3);
      const noCoverAhead = !defOut.some(p => attackDirDef === 1
        ? p.position.x < carrier.position.x - 0.5
        : p.position.x > carrier.position.x + 0.5);
      lineIsolated = (carrierOnLine && (carrierDribblingFwd || noCoverAhead)) ||
                     (carrierAheadOfLine && carrierDribblingFwd);
    }

    // ── Stage 2: 비용 함수 기반 1차/2차 압박 선수 선정 ────────
    // 수비 서드 또는 라인 고립 시 2명 선정, 나머지는 1명
    const ballInDefThird = Math.abs(ball.position.x - ownGoalX) < Pitch.LENGTH * 0.34;
    const presserCount = (lineIsolated || ballInDefThird || (team.tactics?.pressing ?? 0.5) > 0.65) ? 2 : 1;
    const outfieldPlayers = team.outfieldPlayers ?? team.players.filter(p => p.role !== 'GK');
    const pressers = selectPressers(outfieldPlayers, ball, presserCount);

    // ── 이 선수가 압박 선수로 선정된 경우 ─────────────────────
    if (pressers.includes(player)) {
      // 테더 체크: 기본 위치에서 MAX_TETHER 이상 이탈하면 압박 해제 → 블록 복귀
      const tooFar = player.basePosition &&
        player.position.sub(player.basePosition).length() > MAX_TETHER &&
        !(longDrive && pressers[0] === player) &&
        !lineIsolated;

      if (!tooFar) {
        // 지역 방어: 압박 트리거가 꺼졌으면 컨테인(경로 차단 대기)
        const triggered = lineIsolated || longDrive ||
          shouldPress({ player, team, ball, opponentTeam });

        // 물러서기/하프라인 압박: 볼이 압박 깊이 밖(상대 진영)에 있으면
        // 컨테인조차 하지 않고 수비 블록으로 복귀해 길목만 차단한다.
        // (적극 압박·컨테인은 볼이 지시가 정한 경계(페널티박스/하프라인)를
        //  넘어 우리 진영에 들어왔을 때만 시작한다)
        const pressDepth = team.tactics?.pressDepthRatio ?? 0.55;
        const ballDepth = Math.abs(ball.position.x - ownGoalX);
        const withinPressDepth = ballDepth < Pitch.LENGTH * pressDepth;

        if (!triggered) {
          if (withinPressDepth) {
            const containTarget = computeContainTarget(ball, team);
            const sf = distToBall > 12 ? 0.72 : 0.50;
            this._setVelocity(player, containTarget, sf, SLOWING_RADIUS_PRESS);
            return;
          }
          // 볼이 상대 진영에 있고 압박 미발동 → 수비 블록으로 낙하(길목 차단)
        } else {
          // 압박 목표: 1차는 볼 골사이드 1.8m, 2차는 3.5m(컷오프)
          const isPrimary = pressers[0] === player;
          const inOwnBoxDanger = Math.abs(ball.position.x - ownGoalX) < Pitch.PENALTY_BOX_LENGTH + 1;
          const tackleEngageMul = inOwnBoxDanger ? 1.0 : (team.tactics?.tackleEngageMultiplier ?? 1.0);
          const pressTarget = isPrimary
            ? computePresserTarget(ball, team, (inOwnBoxDanger ? 0.8 : 1.8) * tackleEngageMul)
            : computeCutoffTarget(ball, team);
          const sprint = lineIsolated || distToBall > 5;
          this._setVelocity(player, pressTarget, 1.0, SLOWING_RADIUS_PRESS, sprint);
          return;
        }
      }
      // 테더 초과 시 압박 해제 → 아래 수비 블록 로직으로 낙하
    }

    // ── Breakaway Cover: Long Drive의 2차 수비선(커버 러너) ────
    if (!pressers.includes(player) && (coverActive || isLongDrive)) {
      const cover = computeBreakawayCover({
        player, team, opponentTeam, ball, pressers, ownGoalX, active: coverActive,
      });
      if (cover) {
        const sprint = carrier && player.position.sub(carrier.position).length() > 8;
        this._setVelocity(player, cover.target, 1.0, SLOWING_RADIUS_PRESS, sprint);
        return;
      }
    }

    // ── Stage 1+3: 수비 서포트 + 대인마크/커버섀도우 ─────────
    const baseTarget = computeDefensiveSupport({ player, team, opponentTeam, ball });
    const defensive = computeDefensiveTarget({ player, team, opponentTeam, ball, baseTarget });

    // ── 라인 고립 1:1 드리블러 마크 → 압박 전환 ────────────
    if (lineIsolated && !pressers.includes(player) && defensive.markTarget === carrier) {
      const tackleEngageMul2 = team.tactics?.tackleEngageMultiplier ?? 1.0;
      const pressTarget = computePresserTarget(ball, team, 1.8 * tackleEngageMul2);
      const distToCarrier = carrier ? player.position.sub(carrier.position).length() : 0;
      const sprint = lineIsolated || distToCarrier > 2;
      this._setVelocity(player, pressTarget, 1.0, SLOWING_RADIUS_PRESS, sprint);
      return;
    }

    // ── 커버링 쉬프트: 1차 압박 선수가 비운 구역을 인접 선수가 채운다 ─
    let finalTarget = defensive.target;
    const primaryPresser = pressers[0];
    if (primaryPresser && primaryPresser !== player && primaryPresser.basePosition) {
      const coverCandidates = outfieldPlayers
        .filter(p => !pressers.includes(p) && p.role !== 'GK')
        .sort((a, b) =>
          a.position.sub(primaryPresser.basePosition).length() -
          b.position.sub(primaryPresser.basePosition).length()
        );
      if (coverCandidates.indexOf(player) < 2) {
        finalTarget = computeCoveringShift(defensive.target, primaryPresser, player);
      }
    }

    // 위협 수준에 따라 이동 속도를 높인다
    const threatLevel = clamp01(1 - Math.abs(ball.position.x - ownGoalX) / 45);
    const dist = player.position.sub(finalTarget).length();
    const sf = dist > 14 ? 0.92 + threatLevel * 0.20 :
               dist > 6  ? 0.72 + threatLevel * 0.22 :
                           0.50 + threatLevel * 0.18;
    this._setVelocity(player, finalTarget, sf, SLOWING_RADIUS);
  }

  // ──────────────────────────────────────────────
  // 내부 헬퍼 — player.desiredVelocity / desiredFacingAngle 설정
  // speedFactor: 0~1 목표 속도 배율 (null이면 그대로 사용)
  // sprint: true면 maxSpeed 사용 (speedFactor 무시)
  // slowingRadius: ARRIVE 감속 반경 (기본 SLOWING_RADIUS)
  // ──────────────────────────────────────────────
  _setVelocity(player, target, speedFactor = 0.75, slowingRadius = SLOWING_RADIUS, sprint = false) {
    const toTarget = target.sub(player.position);
    const dist = toTarget.length();

    if (dist < 0.18) {
      player.desiredVelocity = Vector2D.zero();
      return;
    }

    const dir = toTarget.normalize();
    let topSpeed = sprint ? player.maxSpeed : player.maxSpeed * (speedFactor ?? 0.75);

    // ARRIVE 감속: 지정 반경 이내에서 거리에 비례해 감속
    if (dist < slowingRadius) {
      topSpeed = Math.max(MIN_MOVE_SPEED, topSpeed * (dist / slowingRadius));
    }

    player.desiredVelocity = dir.scale(topSpeed);
    player.desiredFacingAngle = dir.angle();
  }
}
