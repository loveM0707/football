import { Vector2D } from '../../entities/Vector2D.js';

/**
 * 볼 물리 — 시뮬레이션 전체에서 볼 운동의 유일한 모델.
 *
 * ⚠ 이 파일의 stepBallState()가 볼 운동의 유일한 정의다.
 *   패스 솔버는 별도의 닫힌식(v²/2μ 같은)을 쓰지 않고 반드시 이 함수를
 *   그대로 호출해 미래를 예측한다. 예측과 실제가 다른 식을 쓰면
 *   "패스가 수신자를 넘어간다" 류의 버그가 구조적으로 재발한다.
 *
 * ── 물리 모델 ────────────────────────────────────────────────
 * 지상: a = −(구름저항 + 공기저항)
 *         = −(ROLL_DECEL + DRAG_K·|v|²)  · v̂
 * 공중: a = −g·ẑ − DRAG_K·|v|·v          (3차원 속도에 대한 2차 항력)
 * 착지: 수직 속도는 반발계수만큼 반사, 수평 속도는 마찰만큼 감소
 *
 * 상수는 실제 축구공(질량 0.43kg, 반지름 0.11m)과 잔디 위 거동을 기준으로
 * 잡았고, 유도되는 거동(패스 도달 거리 등)을 테스트로 검증한다.
 */

/** 중력 가속도 (m/s²) */
export const GRAVITY = 9.81;

/**
 * 2차 항력 계수 k = ½·ρ·Cd·A / m  (1/m)
 *   ρ=1.225 kg/m³, A=πr²≈0.0380 m², m=0.43 kg
 *
 * Cd는 0.20을 쓴다. 축구공은 Re≈10⁵(약 12 m/s) 부근에서 드래그 위기를 지나
 * 그보다 빠른 영역에서 Cd가 0.2 수준으로 떨어지며, 롱패스·골킥은 대부분
 * 이 영역에서 날아간다. 백스핀에 의한 양력(마그누스)은 따로 모델링하지
 * 않으므로, 그만큼의 사거리 보정도 이 계수가 함께 흡수한다.
 *
 * 유도되는 거동: 32 m/s로 41° 발사 시 최대 사거리 약 59m — 실제 골킥 범위.
 */
export const DRAG_K = 0.0108;

/**
 * 잔디 위 구름 저항에 의한 감속 (m/s²).
 * 구름 저항 계수 μ≈0.112 (μ·g = 1.10) — 잔디 위 축구공의 통상 범위(0.08~0.15).
 *
 * 이 값과 DRAG_K가 함께 지상 패스의 도달 거리를 정한다.
 * 유도되는 거동: 8 m/s → 약 23m, 12 m/s → 약 41m, 18 m/s → 약 66m.
 */
export const ROLL_DECEL = 1.10;

/** 착지 시 수직 반발계수 (잔디) */
export const RESTITUTION = 0.50;

/** 착지 시 수평 속도 유지 비율 (잔디 마찰) */
export const GROUND_FRICTION = 0.72;

/** 이 값 이하의 수직 속도로 착지하면 튀지 않고 안착한다 (m/s) */
export const BOUNCE_CUTOFF = 0.55;

/** 지면 접촉 판정 여유 (m) */
export const GROUND_EPS = 1e-4;

/** 이 속력 이하이면 정지로 간주한다 (m/s) */
export const REST_SPEED = 0.05;

/**
 * 볼 상태를 나타내는 평면 객체.
 * 솔버가 수천 번 반복 적분하므로 Vector2D 할당을 피하기 위해 원시 필드를 쓴다.
 * @typedef {{x:number, y:number, vx:number, vy:number, h:number, vz:number}} BallStateLite
 */

/** Ball 엔티티 → 경량 상태 */
export function toLite(ball) {
  return {
    x: ball.position.x,
    y: ball.position.y,
    vx: ball.velocity.x,
    vy: ball.velocity.y,
    h: ball.height,
    vz: ball.verticalVelocity,
  };
}

/** 경량 상태 복제 */
export function cloneLite(s) {
  return { x: s.x, y: s.y, vx: s.vx, vy: s.vy, h: s.h, vz: s.vz };
}

/**
 * 볼 상태를 dt만큼 전진시킨다 (제자리 수정).
 *
 * 시뮬레이션의 실제 볼도, 솔버의 가상 볼도 모두 이 함수만 사용한다.
 *
 * @param {BallStateLite} s 볼 상태 (수정됨)
 * @param {number} dt 스텝 (초)
 * @returns {BallStateLite} 같은 객체
 */
export function stepBallState(s, dt) {
  const airborne = s.h > GROUND_EPS || s.vz > 0;

  if (!airborne) {
    // ── 지상 구르기 ────────────────────────────────────────
    s.h = 0;
    s.vz = 0;
    const speed = Math.hypot(s.vx, s.vy);
    if (speed > REST_SPEED) {
      const decel = ROLL_DECEL + DRAG_K * speed * speed;
      const next = Math.max(0, speed - decel * dt);
      const scale = next / speed;
      s.vx *= scale;
      s.vy *= scale;
    } else {
      s.vx = 0;
      s.vy = 0;
    }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    return s;
  }

  // ── 공중 비행 ────────────────────────────────────────────
  const speed3 = Math.hypot(s.vx, s.vy, s.vz);
  const dragA = DRAG_K * speed3; // a_drag = k·|v|·v (성분별)

  s.vx -= dragA * s.vx * dt;
  s.vy -= dragA * s.vy * dt;
  s.vz -= (GRAVITY + dragA * s.vz) * dt;

  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.h += s.vz * dt;

  if (s.h <= 0) {
    // ── 착지 ────────────────────────────────────────────────
    s.h = 0;
    if (s.vz < -BOUNCE_CUTOFF) {
      s.vz = -s.vz * RESTITUTION;
      s.vx *= GROUND_FRICTION;
      s.vy *= GROUND_FRICTION;
    } else {
      // 약하게 떨어지면 튀지 않고 굴러간다
      s.vz = 0;
    }
  }

  return s;
}

/**
 * 볼을 n스텝 전진시키며 매 스텝 콜백을 호출한다.
 *
 * @param {BallStateLite} state 시작 상태 (복제되어 원본은 보존)
 * @param {number} dt 스텝 (초) — 라이브 시뮬레이션과 반드시 동일해야 한다
 * @param {number} maxSteps 최대 스텝 수
 * @param {(s:BallStateLite, t:number, i:number)=>boolean|void} onStep
 *        true를 반환하면 조기 종료
 * @returns {{state:BallStateLite, time:number, steps:number}}
 */
export function simulate(state, dt, maxSteps, onStep) {
  const s = cloneLite(state);
  let t = 0;
  for (let i = 0; i < maxSteps; i++) {
    stepBallState(s, dt);
    t += dt;
    if (onStep && onStep(s, t, i) === true) {
      return { state: s, time: t, steps: i + 1 };
    }
  }
  return { state: s, time: t, steps: maxSteps };
}

/**
 * 볼이 완전히 멈출 때까지의 총 이동 거리와 소요 시간.
 * 해석식이 아니라 실제 적분기를 돌려서 구한다.
 *
 * @param {BallStateLite} state 시작 상태
 * @param {number} dt 스텝
 * @param {number} maxSeconds 안전 상한
 */
export function predictStop(state, dt, maxSeconds = 15) {
  const start = cloneLite(state);
  let distance = 0;
  let prevX = start.x, prevY = start.y;

  const result = simulate(start, dt, Math.ceil(maxSeconds / dt), (s) => {
    distance += Math.hypot(s.x - prevX, s.y - prevY);
    prevX = s.x;
    prevY = s.y;
    // 지면에 안착하고 속력이 사라지면 종료
    return s.h <= GROUND_EPS && Math.hypot(s.vx, s.vy) <= REST_SPEED;
  });

  return {
    position: new Vector2D(result.state.x, result.state.y),
    distance,
    time: result.time,
  };
}

/**
 * 볼 물리 시스템 — MatchEngine 파이프라인의 7단계.
 *
 * 볼 운동을 기록하는 유일한 주체다. 다른 어떤 모듈도
 * ball.position / velocity / height 를 직접 적분하지 않는다.
 */
export class BallPhysics {
  /**
   * @param {number} step 고정 스텝. 솔버 예측과 반드시 같은 값을 써야 한다.
   */
  constructor(step = 1 / 60) {
    this.step = step;
  }

  /**
   * @param {MatchEngine} engine
   * @param {number} dt
   */
  update(engine, dt) {
    const ball = engine.ball;

    // 누군가 발밑에 두고 있으면 물리 적분 대상이 아니다.
    // (볼 위치는 드리블 터치 사이클이 정한다 — PHASE 8)
    if (ball.isCarried) return;

    const s = toLite(ball);
    stepBallState(s, dt);

    ball.position = new Vector2D(s.x, s.y);
    ball.velocity = new Vector2D(s.vx, s.vy);
    ball.height = s.h;
    ball.verticalVelocity = s.vz;

    // 완전히 멈추면 비행 정보를 정리한다
    if (ball.isStationary) ball.clearFlight();
  }

  /**
   * 현재 볼이 앞으로 어디에 멈출지 예측한다.
   * 라이브와 동일한 적분기·동일한 dt를 쓰므로 예측이 실제와 일치한다.
   * @param {Ball} ball
   */
  predictStop(ball) {
    return predictStop(toLite(ball), this.step);
  }
}
