import { Vector2D } from '../../entities/Vector2D.js';
import {
  stepBallState, cloneLite, GROUND_EPS, REST_SPEED,
} from './BallPhysics.js';

/**
 * 패스 솔버 — "이 지점으로 보내려면 어떻게 차야 하는가"를 역산한다.
 *
 * ⚠ 핵심 설계 원칙
 *   이 파일에는 볼 운동을 기술하는 독자적인 수식이 하나도 없다.
 *   모든 예측은 BallPhysics.stepBallState()를 그대로 돌려서 얻고,
 *   원하는 결과가 나오는 초기 속도를 이분법으로 찾는다.
 *
 *   즉 솔버는 물리 모델의 "수치적 역함수"다. 물리와 솔버가 서로 다른
 *   식을 쓸 수 없는 구조이므로, 구 엔진에서 롱패스가 수신자를 넘어가던
 *   원인(솔버는 지상 감쇠식, 실제는 공중 포물선)이 재발할 수 없다.
 *
 *   또한 예측에 쓰는 dt는 반드시 라이브 시뮬레이션의 고정 스텝과 같아야 한다.
 *   같은 dt·같은 적분기이므로 예측 궤적과 실제 궤적이 일치한다.
 */

/** 킥 초기 속력 상한 (m/s) — 사람이 낼 수 있는 현실적 한계 */
export const MAX_KICK_SPEED = 32;

/** 킥 초기 속력 하한 */
const MIN_KICK_SPEED = 0.5;

/** 이분법 반복 횟수 (2^-40 수준까지 수렴) */
const BISECTION_ITERATIONS = 40;

/** 예측 안전 상한 (초) */
const MAX_FLIGHT_SECONDS = 8;

// ════════════════════════════════════════════════════════════
// 1차원 예측 (방향을 x축으로 놓고 계산한 뒤 실제 방향으로 회전한다)
// ════════════════════════════════════════════════════════════

/**
 * 지상 볼을 v0으로 굴렸을 때, 거리 d 지점에서의 속력과 도달 시간.
 *
 * @param {number} d 목표 거리 (m)
 * @param {number} v0 초기 속력 (m/s)
 * @param {number} dt 고정 스텝
 * @returns {{reached:boolean, speedAtTarget:number, time:number, maxDistance:number}}
 */
function rollToDistance(d, v0, dt) {
  const s = { x: 0, y: 0, vx: v0, vy: 0, h: 0, vz: 0 };
  const maxSteps = Math.ceil(MAX_FLIGHT_SECONDS / dt);
  let t = 0;

  for (let i = 0; i < maxSteps; i++) {
    const prevX = s.x;
    const prevSpeed = Math.abs(s.vx);

    stepBallState(s, dt);
    t += dt;

    if (s.x >= d) {
      // 목표 지점을 지난 스텝 안에서 선형 보간해 도달 시각·속력을 구한다
      const span = s.x - prevX;
      const frac = span > 1e-9 ? (d - prevX) / span : 1;
      const speed = prevSpeed + (Math.abs(s.vx) - prevSpeed) * frac;
      return {
        reached: true,
        speedAtTarget: speed,
        time: t - dt + dt * frac,
        maxDistance: s.x,
      };
    }

    if (Math.abs(s.vx) <= REST_SPEED) break; // 목표 전에 멈춤
  }

  return { reached: false, speedAtTarget: 0, time: t, maxDistance: s.x };
}

/**
 * 공중 킥의 착지 거리·체공 시간·최고 높이.
 *
 * @param {number} v0 초기 속력 (m/s)
 * @param {number} elevation 발사각 (rad)
 * @param {number} dt 고정 스텝
 * @returns {{range:number, time:number, apex:number}}
 */
function launchToLanding(v0, elevation, dt) {
  const s = {
    x: 0, y: 0,
    vx: v0 * Math.cos(elevation), vy: 0,
    h: 0, vz: v0 * Math.sin(elevation),
  };
  const maxSteps = Math.ceil(MAX_FLIGHT_SECONDS / dt);
  let t = 0;
  let apex = 0;

  for (let i = 0; i < maxSteps; i++) {
    const prev = cloneLite(s);

    stepBallState(s, dt);
    t += dt;
    if (s.h > apex) apex = s.h;

    // 첫 착지 검출: 직전에는 떠 있었는데 이번 스텝에 지면에 닿았다
    if (s.h <= GROUND_EPS && prev.h > GROUND_EPS) {
      // 스텝 내부에서 지면에 닿은 시점을 보간한다.
      // (스텝 단위로만 보고하면 15 m/s에서 25cm 오차가 생긴다)
      const fallSpeed = Math.max(1e-9, -prev.vz);
      const tLand = Math.min(dt, prev.h / fallSpeed);
      return {
        range: prev.x + prev.vx * tLand,
        time: t - dt + tLand,
        apex,
      };
    }
  }

  return { range: s.x, time: t, apex };
}

// ════════════════════════════════════════════════════════════
// 이분법 역산
// ════════════════════════════════════════════════════════════

/**
 * 목표 지점에서 원하는 도착 속력이 나오도록 초기 속력을 역산한다.
 * 도달 속력은 초기 속력에 대해 단조증가하므로 이분법이 안전하다.
 */
function bisectGroundSpeed(d, arrivalSpeed, dt) {
  let lo = MIN_KICK_SPEED;
  let hi = MAX_KICK_SPEED;

  // 상한으로도 목표 속력에 못 미치면 도달 불가 — 최대 세기로 최선을 다한다
  const atMax = rollToDistance(d, hi, dt);
  if (!atMax.reached || atMax.speedAtTarget < arrivalSpeed) {
    return { speed: hi, result: atMax, feasible: false };
  }

  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const r = rollToDistance(d, mid, dt);
    if (r.reached && r.speedAtTarget >= arrivalSpeed) hi = mid;
    else lo = mid;
  }

  return { speed: hi, result: rollToDistance(d, hi, dt), feasible: true };
}

/**
 * 주어진 발사각에서 착지 거리가 d가 되도록 초기 속력을 역산한다.
 * 착지 거리는 초기 속력에 대해 단조증가한다.
 */
function bisectLoftedSpeed(d, elevation, dt) {
  let lo = MIN_KICK_SPEED;
  let hi = MAX_KICK_SPEED;

  const atMax = launchToLanding(hi, elevation, dt);
  if (atMax.range < d) {
    return { speed: hi, result: atMax, feasible: false };
  }

  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (launchToLanding(mid, elevation, dt).range >= d) hi = mid;
    else lo = mid;
  }

  return { speed: hi, result: launchToLanding(hi, elevation, dt), feasible: true };
}

// ════════════════════════════════════════════════════════════
// 공개 API
// ════════════════════════════════════════════════════════════

/**
 * 지상 패스 해를 구한다.
 *
 * @param {Vector2D} from 출발 지점
 * @param {Vector2D} to 도착 지점
 * @param {object} opts
 * @param {number} opts.dt 고정 스텝 (라이브와 동일해야 함)
 * @param {number} [opts.arrivalSpeed] 도착 시 원하는 속력 (m/s)
 * @returns {{
 *   type:'GROUND', velocity:Vector2D, verticalVelocity:number,
 *   speed:number, flightTime:number, distance:number,
 *   arrivalSpeed:number, feasible:boolean
 * }|null}
 */
export function solveGroundPass(from, to, { dt, arrivalSpeed = 3.0 } = {}) {
  const delta = to.sub(from);
  const distance = delta.length();
  if (distance < 0.05) return null;

  const dir = delta.normalize();
  const { speed, result, feasible } = bisectGroundSpeed(distance, arrivalSpeed, dt);

  return {
    type: 'GROUND',
    velocity: dir.scale(speed),
    verticalVelocity: 0,
    speed,
    flightTime: result.time,
    distance,
    arrivalSpeed: result.speedAtTarget,
    feasible,
  };
}

/**
 * 공중(로빙) 패스 해를 구한다.
 *
 * 발사각을 후보군으로 훑으면서 각각에 대해 착지 거리가 목표와 일치하는
 * 초기 속력을 역산한 뒤, 제약과 선호를 만족하는 해를 고른다.
 *
 * @param {Vector2D} from
 * @param {Vector2D} to
 * @param {object} opts
 * @param {number} opts.dt 고정 스텝
 * @param {number} [opts.preferredFlightTime] 선호 체공 시간 (초). 지정하면 이에 가까운 해를 고른다.
 * @param {number} [opts.minApex] 최소 정점 높이 (m) — 수비수 머리 위로 넘길 때 사용
 * @param {number} [opts.maxApex] 최대 정점 높이 (m)
 * @returns {object|null}
 */
export function solveLoftedPass(from, to, {
  dt,
  preferredFlightTime = null,
  minApex = 0,
  maxApex = Infinity,
} = {}) {
  const delta = to.sub(from);
  const distance = delta.length();
  if (distance < 0.05) return null;

  const dir = delta.normalize();

  // 발사각 후보: 8° ~ 55°.
  // 낮은 각은 빠르고 낮은 궤적(드리븐), 높은 각은 느리고 높은 궤적(로빙).
  const candidates = [];
  for (let deg = 8; deg <= 55; deg += 2) {
    const elevation = (deg * Math.PI) / 180;
    const { speed, result, feasible } = bisectLoftedSpeed(distance, elevation, dt);
    if (!feasible) continue;
    if (result.apex < minApex || result.apex > maxApex) continue;
    candidates.push({ elevation, speed, result });
  }

  if (candidates.length === 0) return null;

  // 선택 기준:
  //  - 선호 체공 시간이 있으면 그에 가장 가까운 해
  //  - 없으면 정점이 지나치게 높지 않은(=가장 빠른) 해
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    const cost = preferredFlightTime !== null
      ? Math.abs(c.result.time - preferredFlightTime)
      : c.result.apex;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }

  const horizontalSpeed = best.speed * Math.cos(best.elevation);
  return {
    type: 'LOFTED',
    velocity: dir.scale(horizontalSpeed),
    verticalVelocity: best.speed * Math.sin(best.elevation),
    speed: best.speed,
    elevation: best.elevation,
    flightTime: best.result.time,
    distance,
    apex: best.result.apex,
    feasible: true,
  };
}

/**
 * 상황에 맞는 패스 해를 고른다.
 *
 * 지상 패스가 가능하고 경로를 띄울 이유가 없으면 지상을 택한다.
 * 지상으로 도달할 수 없거나(거리 초과) 넘겨야 할 대상이 있으면 로빙을 택한다.
 *
 * @param {Vector2D} from
 * @param {Vector2D} to
 * @param {object} opts
 * @param {number} opts.dt
 * @param {number} [opts.arrivalSpeed] 지상 패스 도착 속력
 * @param {boolean} [opts.mustLoft] 반드시 띄워야 하는가 (경로 차단 등)
 * @param {number} [opts.minApex] 넘겨야 할 최소 높이
 * @param {number} [opts.preferredFlightTime]
 */
export function solvePass(from, to, opts = {}) {
  const { mustLoft = false } = opts;

  if (!mustLoft) {
    const ground = solveGroundPass(from, to, opts);
    // 지상으로 목표 속력을 만족하며 도달할 수 있으면 그것을 쓴다
    if (ground && ground.feasible) return ground;
  }

  const lofted = solveLoftedPass(from, to, opts);
  if (lofted) return lofted;

  // 로빙도 불가능하면 최대 세기 지상 패스로 최선을 다한다
  return solveGroundPass(from, to, opts);
}

/**
 * 해가 실제로 목표에 도달하는지 검증한다 (테스트·진단용).
 *
 * 솔버가 돌려준 초기 조건을 그대로 적분해 최근접 지점과 오버슛을 측정한다.
 * 이 함수가 쓰는 적분기는 라이브 시뮬레이션과 동일하므로,
 * 여기서 통과하면 실제 경기에서도 같은 궤적이 나온다.
 *
 * @param {Vector2D} from 출발 지점
 * @param {Vector2D} to 목표 지점
 * @param {object} solution solvePass 결과
 * @param {number} dt 고정 스텝
 * ── 지표 정의 ────────────────────────────────────────────────
 * closestDistance : 궤적이 목표에 가장 가까웠던 거리. Section 34의 핵심 판정.
 *                   이 값이 크면 볼이 수신자 머리 위/옆으로 지나갔다는 뜻이다.
 * overshoot       : 최근접 순간에 목표를 얼마나 지나쳐 있었는가.
 *                   양수면 수신자 뒤에서야 가장 가까워졌다는 뜻 → 실패 신호.
 * rollOnDistance  : 아무도 건드리지 않았을 때 최종적으로 목표를 지나간 거리.
 *                   이것은 실패가 아니다. 발밑에 속도를 갖고 도착한 패스는
 *                   당연히 계속 굴러간다. 통제는 수신자의 퍼스트 터치가 한다.
 *
 * @returns {{
 *   closestDistance:number, closestTime:number, overshoot:number,
 *   rollOnDistance:number, arrivalSpeed:number, arrivalHeight:number
 * }}
 */
export function verifySolution(from, to, solution, dt) {
  const s = {
    x: from.x, y: from.y,
    vx: solution.velocity.x, vy: solution.velocity.y,
    h: 0, vz: solution.verticalVelocity,
  };

  const toTarget = to.sub(from);
  const totalDist = toTarget.length();
  const dir = totalDist > 1e-9 ? toTarget.normalize() : new Vector2D(1, 0);

  let closestDistance = Infinity;
  let closestTime = 0;
  let arrivalSpeed = 0;
  let arrivalHeight = 0;
  let projectionAtClosest = 0;
  let maxProjection = 0;
  let t = 0;

  const maxSteps = Math.ceil(MAX_FLIGHT_SECONDS / dt);
  for (let i = 0; i < maxSteps; i++) {
    stepBallState(s, dt);
    t += dt;

    // 출발→목표 방향으로의 투영 거리
    const proj = (s.x - from.x) * dir.x + (s.y - from.y) * dir.y;
    if (proj > maxProjection) maxProjection = proj;

    const d = Math.hypot(s.x - to.x, s.y - to.y);
    if (d < closestDistance) {
      closestDistance = d;
      closestTime = t;
      arrivalSpeed = Math.hypot(s.vx, s.vy);
      arrivalHeight = s.h;
      projectionAtClosest = proj;
    }

    if (s.h <= GROUND_EPS && Math.hypot(s.vx, s.vy) <= REST_SPEED) break;
  }

  return {
    closestDistance,
    closestTime,
    // 최근접 순간 기준 오버슛 — 양수면 수신자를 지나친 뒤에야 가까워졌다는 뜻
    overshoot: projectionAtClosest - totalDist,
    // 아무도 건드리지 않았을 때 최종적으로 목표를 지나간 거리 (실패 지표 아님)
    rollOnDistance: maxProjection - totalDist,
    arrivalSpeed,
    arrivalHeight,
  };
}
