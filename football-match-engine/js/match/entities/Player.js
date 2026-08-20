import { Vector2D } from '../../entities/Vector2D.js';
import { Role, Duty, roleLabel, isGoalkeeper } from '../tactics/RoleModel.js';
import { clamp, clamp01 } from '../core/Coords.js';

/**
 * 선수 능력치 (1~99).
 *
 * 능력치는 "물리적 한계"와 "판단 품질"의 근거일 뿐,
 * 행동 자체를 결정하지 않는다. 행동은 임무와 상황에서 나온다.
 */
export class PlayerAttributes {
  constructor(values = {}) {
    const d = (key, def = 60) => clamp(Math.round(values[key] ?? def), 1, 99);

    // 신체
    this.pace = d('pace');                     // 최고 속도
    this.acceleration = d('acceleration');     // 가속력
    this.agility = d('agility');               // 방향 전환 (선회율)
    this.balance = d('balance');               // 접촉 시 중심 유지
    this.stamina = d('stamina');               // 체력 총량·회복력
    this.strength = d('strength');             // 몸싸움

    // 볼 기술
    this.dribbling = d('dribbling');
    this.firstTouch = d('firstTouch');
    this.passing = d('passing');               // 짧은·중거리 패스 정확도
    this.crossing = d('crossing');
    this.longPassing = d('longPassing');       // 롱패스 정확도

    // 인지·판단
    this.vision = d('vision');                 // 패스 선택지 탐색 폭
    this.decisionMaking = d('decisionMaking'); // 선택의 질
    this.positioning = d('positioning');       // 오프볼 위치 선정
    this.reactions = d('reactions');           // 상황 변화 반응 지연

    // 마무리
    this.shooting = d('shooting');
    this.finishing = d('finishing');
    this.shotPower = d('shotPower');
    this.heading = d('heading');

    // 수비
    this.tackling = d('tackling');
    this.interceptions = d('interceptions');
  }

  /** 0~1로 정규화된 값 (계수 계산에 사용) */
  norm(key) {
    return clamp01((this[key] ?? 60) / 100);
  }
}

/** 선수의 현재 판단 결과 — DecisionEngine이 쓰고 MovementEngine/ActionSystem이 읽는다 */
export const Action = {
  IDLE: 'IDLE',
  MOVE: 'MOVE',           // 목표 지점으로 이동
  CARRY: 'CARRY',         // 볼을 몰고 이동 (드리블 터치 사이클)
  PASS: 'PASS',
  SHOOT: 'SHOOT',
  CLEAR: 'CLEAR',
  TACKLE: 'TACKLE',
  SHIELD: 'SHIELD',       // 볼 보호
  RECEIVE: 'RECEIVE',     // 패스 수신 준비
  GK_ACTION: 'GK_ACTION',
};

/**
 * 선수.
 *
 * Section 8의 요구대로 네 가지를 분리해 보관한다:
 *   attributes  : 신체·기술 능력치 (변하지 않음)
 *   role/duty   : 전술적 역할(고정) / 현재 임무(매 틱 배정)
 *   decision    : 현재 판단 결과 (DecisionEngine 소유)
 *   position 등 : 현재 운동 상태 (MovementEngine 단독 소유)
 *
 * ⚠ position / velocity / facingAngle 은 MovementEngine만 기록한다.
 *   다른 모듈이 직접 대입하면 이동 권한이 둘로 갈라져 예전 엔진의
 *   "서로 다른 목표로 끌어당기는" 버그가 재발한다.
 */
export class Player {
  constructor({ id, name, number, role = Role.CM, attributes = {} }) {
    this.id = id;
    this.name = name;
    this.number = number;
    this.role = role;
    this.attributes = new PlayerAttributes(attributes);

    /** 소속 팀 — Team 생성 시 주입된다 */
    this.team = null;
    /** 포메이션 슬롯 정보 (라인·채널) — Team이 주입 */
    this.slot = null;

    // ── 운동 상태 (MovementEngine 전용) ──────────────────────
    this.position = new Vector2D(0, 0);
    this.velocity = new Vector2D(0, 0);
    /** 몸이 향한 방향 (rad). 패스 방향·선회 비용 판단에 쓰인다. */
    this.facingAngle = 0;

    // ── 체력 ─────────────────────────────────────────────────
    /** 잔여 체력 0~1 */
    this.energy = 1;

    // ── 전술 상태 (TacticalEngine 전용) ──────────────────────
    /** 현재 배정된 임무 */
    this.duty = Duty.SUPPORT;
    /** 임무가 유지된 시간 (초) — 임무 플래핑 방지에 사용 */
    this.dutyTimer = 0;
    /** 팀 구조상 기대 위치 (앵커). 렌더러 호환용 basePosition getter가 이를 반환한다. */
    this.anchor = new Vector2D(0, 0);
    /** 마크 대상 (MARK 임무일 때) */
    this.markTarget = null;

    // ── 판단 결과 (DecisionEngine 전용) ──────────────────────
    this.decision = {
      action: Action.IDLE,
      target: null,      // Vector2D — 이동 목표
      sprint: false,
      urgency: 0.5,      // 0~1, MovementEngine의 속도 배율에 반영
      committedUntil: 0, // 이 시각까지 판단을 유지 (행동 커밋)
      payload: null,     // 행동에 필요한 부가 정보 (패스 해, 태클 대상 등)
    };

    // ── 볼 관계 ──────────────────────────────────────────────
    /** 볼을 발밑에 두고 있는가 (PossessionModel이 기록) */
    this.hasBall = false;
    /** 다음 볼 접촉까지 남은 시간 (초) */
    this.touchCooldown = 0;
    /** 태클 후 재시도까지 남은 회복 시간 (초) */
    this.tackleRecovery = 0;
    /** 태클에 실패해 제쳐진 상태로 남은 시간 (초) */
    this.beatenTimer = 0;

    // ── 디버그 (렌더러 계약) ─────────────────────────────────
    this.debugTarget = null;
    this.debugTargetSource = null;
    /** 렌더러 호환용 디버그 정보 주머니 */
    this.brainMemory = {};
  }

  /** 렌더러 호환: 기존 렌더러는 기대 위치를 basePosition으로 읽는다 */
  get basePosition() {
    return this.anchor;
  }

  /** 화면 표기용 짧은 역할 라벨 */
  get roleLabel() {
    return roleLabel(this.role);
  }

  get isGoalkeeper() {
    return isGoalkeeper(this.role);
  }

  /** 현재 속력 (m/s) */
  get speed() {
    return this.velocity.length();
  }

  // ── 능력치에서 유도되는 물리 한계 ──────────────────────────
  // 실제 축구 선수 범위를 기준으로 한다:
  //   최고 속도 약 6.8 ~ 9.0 m/s, 초기 가속 약 3.5 ~ 7.0 m/s²

  /** 체력 저하를 반영한 최고 속도 (m/s) */
  get maxSpeed() {
    const base = 6.2 + this.attributes.norm('pace') * 2.8;
    // 체력이 바닥나도 62%까지만 떨어지도록 한다 (완전 정지 방지)
    const fatigue = 0.88 + 0.12 * this.energy;
    return base * fatigue;
  }

  /** 최대 가속도 (m/s²) */
  get maxAcceleration() {
    const base = 3.5 + this.attributes.norm('acceleration') * 3.5;
    return base * (0.80 + 0.20 * this.energy);
  }

  /** 최대 감속도 (m/s²) — 감속은 가속보다 빠르다 */
  get maxDeceleration() {
    return this.maxAcceleration * 1.6;
  }

  /**
   * 정지 상태 기준 최대 선회 각속도 (rad/s).
   * 실제 선회 한계는 속도가 빠를수록 줄어들며, MovementEngine이 계산한다.
   */
  get maxTurnRate() {
    return 3.0 + this.attributes.norm('agility') * 3.5;
  }

  /** 볼을 몰 때의 속도 배율 — 드리블 능력이 낮으면 볼과 함께 빨리 못 간다 */
  get carrySpeedFactor() {
    return 0.72 + this.attributes.norm('dribbling') * 0.20;
  }

  /**
   * 반응 지연 (초). 상황이 바뀌어도 이만큼은 이전 판단을 유지한다.
   * 완전 즉각 반응하는 선수는 로봇처럼 보인다.
   */
  get reactionDelay() {
    return 0.34 - this.attributes.norm('reactions') * 0.20; // 0.34 ~ 0.14초
  }

  // ── 상태 갱신 ──────────────────────────────────────────────

  /**
   * 체력 소모/회복. MovementEngine이 매 스텝 호출한다.
   * @param {number} dt 스텝 (초)
   * @param {number} exertion 0~1, 현재 운동 강도
   */
  updateEnergy(dt, exertion) {
    const staminaN = this.attributes.norm('stamina');

    // 운동 강도에 대한 소모는 선형이 아니다.
    // 조깅과 전력 질주의 대사 비용 차이가 매우 크므로 3차항을 둔다.
    //   f(0.55) ≈ 1.18 (경기 평균 강도),  f(1.0) = 4.0 (전력 질주)
    const exertionFactor = 0.3 + exertion * 0.7 + exertion * exertion * exertion * 3.0;

    // 아래 계수는 "초당" 비율이다.
    // 90분(5400초)을 평균 강도로 뛰면 잔여 체력이 대략 0.6 부근이 된다.
    const drainRate = (8.6e-5 - staminaN * 3.8e-5) * exertionFactor;
    const recoverRate = (0.35e-4 + staminaN * 0.30e-4) * Math.max(0, 1 - exertion * 1.6);

    this.energy = clamp01(this.energy + (recoverRate - drainRate) * dt);
  }

  /** 판단을 새로 기록한다 (DecisionEngine 전용) */
  setDecision(action, target, opts = {}) {
    this.decision.action = action;
    this.decision.target = target ? target.clone() : null;
    this.decision.sprint = opts.sprint ?? false;
    this.decision.urgency = clamp01(opts.urgency ?? 0.5);
    this.decision.payload = opts.payload ?? null;
    if (opts.committedUntil !== undefined) {
      this.decision.committedUntil = opts.committedUntil;
    }
    // 디버그 시각화 계약
    this.debugTarget = this.decision.target;
    this.debugTargetSource = opts.source ?? this.duty;
  }

  /** 결정론 검증용 상태 요약 */
  snapshot() {
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
      id: this.id,
      x: r(this.position.x),
      y: r(this.position.y),
      vx: r(this.velocity.x),
      vy: r(this.velocity.y),
      duty: this.duty,
    };
  }
}
