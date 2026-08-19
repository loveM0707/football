import { suite, test, assert, assertEqual, assertClose, assertRange } from './_harness.mjs';

import {
  stepBallState, simulate, predictStop, toLite, cloneLite,
  BallPhysics, GRAVITY, GROUND_EPS, REST_SPEED,
} from '../ball/BallPhysics.js';
import {
  solveGroundPass, solveLoftedPass, solvePass, verifySolution, MAX_KICK_SPEED,
} from '../ball/PassSolver.js';
import { Ball, BallFlight } from '../entities/Ball.js';
import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';

const DT = 1 / 60;

/** 지상 볼을 v0으로 굴렸을 때 총 이동 거리 */
function groundRollDistance(v0) {
  return predictStop({ x: 0, y: 0, vx: v0, vy: 0, h: 0, vz: 0 }, DT).distance;
}

// ════════════════════════════════════════════════════════════
suite('PHASE 4 — 볼 물리 (지상)');

test('지상 볼은 감속하다 결국 멈춘다', () => {
  const s = { x: 0, y: 0, vx: 12, vy: 0, h: 0, vz: 0 };
  let prevSpeed = 12;
  for (let i = 0; i < 60 * 12; i++) {
    stepBallState(s, DT);
    const speed = Math.hypot(s.vx, s.vy);
    assert(speed <= prevSpeed + 1e-9, `속력이 증가함: ${prevSpeed} → ${speed}`);
    prevSpeed = speed;
  }
  assertClose(prevSpeed, 0, 1e-6, '충분한 시간 후에도 멈추지 않음');
});

test('지상 패스 도달 거리가 실제 축구 범위 안에 있다', () => {
  // 잔디 위 구름 저항 + 공기 저항에서 유도되는 값
  assertRange(groundRollDistance(6), 12, 22, '6 m/s 지상 볼 도달 거리');
  assertRange(groundRollDistance(8), 18, 30, '8 m/s 지상 볼 도달 거리');
  assertRange(groundRollDistance(12), 33, 50, '12 m/s 지상 볼 도달 거리');
  assertRange(groundRollDistance(18), 55, 75, '18 m/s 지상 볼 도달 거리');
});

test('도달 거리는 초기 속력에 대해 단조증가한다 (이분법 전제)', () => {
  let prev = 0;
  for (let v = 2; v <= 30; v += 1) {
    const d = groundRollDistance(v);
    assert(d > prev, `단조성 위반: v=${v}에서 ${d} <= ${prev}`);
    prev = d;
  }
});

test('정지한 볼은 스스로 움직이지 않는다', () => {
  const s = { x: 30, y: 20, vx: 0, vy: 0, h: 0, vz: 0 };
  for (let i = 0; i < 600; i++) stepBallState(s, DT);
  assertClose(s.x, 30, 1e-9);
  assertClose(s.y, 20, 1e-9);
});

test('진행 방향이 유지된다 (감속은 방향을 바꾸지 않는다)', () => {
  const s = { x: 0, y: 0, vx: 6, vy: 8, h: 0, vz: 0 };
  const angle0 = Math.atan2(s.vy, s.vx);
  for (let i = 0; i < 120; i++) {
    stepBallState(s, DT);
    if (Math.hypot(s.vx, s.vy) < 0.1) break;
    assertClose(Math.atan2(s.vy, s.vx), angle0, 1e-9, '감속 중 방향이 틀어짐');
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 4 — 볼 물리 (공중)');

test('공중 볼은 포물선을 그리며 착지한다', () => {
  const s = { x: 0, y: 0, vx: 15, vy: 0, h: 0, vz: 8 };
  let apex = 0;
  let landed = false;
  for (let i = 0; i < 60 * 6; i++) {
    const prevH = s.h;
    stepBallState(s, DT);
    apex = Math.max(apex, s.h);
    if (s.h <= GROUND_EPS && prevH > GROUND_EPS) { landed = true; break; }
  }
  assert(landed, '볼이 착지하지 않음');
  // vz=8 m/s면 진공 기준 정점 h = v²/2g ≈ 3.26m. 항력으로 조금 낮아진다.
  assertRange(apex, 2.6, 3.3, '정점 높이가 물리적으로 비현실적');
});

test('항력이 없을 때보다 체공 시간이 짧다 (항력이 실제로 작동한다)', () => {
  const vz = 12;
  const vacuumTime = (2 * vz) / GRAVITY; // 진공 기준 체공 시간
  const s = { x: 0, y: 0, vx: 0, vy: 0, h: 0, vz };
  let t = 0;
  for (let i = 0; i < 60 * 8; i++) {
    const prevH = s.h;
    stepBallState(s, DT);
    t += DT;
    if (s.h <= GROUND_EPS && prevH > GROUND_EPS) break;
  }
  assert(t < vacuumTime, `항력이 적용되지 않음 (체공 ${t}s >= 진공 ${vacuumTime}s)`);
  assert(t > vacuumTime * 0.85, `체공 시간이 비현실적으로 짧음 (${t}s)`);
});

test('착지 시 반발계수만큼 튀어 오른다', () => {
  const s = { x: 0, y: 0, vx: 5, vy: 0, h: 3, vz: 0 };
  // 첫 착지까지 진행
  let impactVz = 0;
  for (let i = 0; i < 600; i++) {
    const prev = cloneLite(s);
    stepBallState(s, DT);
    if (s.h <= GROUND_EPS && prev.h > GROUND_EPS) { impactVz = prev.vz; break; }
  }
  assert(impactVz < 0, '착지 순간 하강 중이 아님');
  assert(s.vz > 0, '착지 후 튀어오르지 않음');
  assert(s.vz < -impactVz, '반발 속도가 충돌 속도보다 큼 (에너지 증가)');
});

test('여러 번 튀다가 결국 지면에 안착한다', () => {
  const s = { x: 0, y: 0, vx: 3, vy: 0, h: 5, vz: 0 };
  for (let i = 0; i < 60 * 20; i++) stepBallState(s, DT);
  assertClose(s.h, 0, 1e-6, '볼이 계속 튀고 있음');
  assertClose(s.vz, 0, 1e-6, '수직 속도가 남아 있음');
});

test('에너지가 증가하는 스텝이 없다', () => {
  const s = { x: 0, y: 0, vx: 14, vy: 3, h: 0, vz: 9 };
  const energy = (st) => 0.5 * (st.vx ** 2 + st.vy ** 2 + st.vz ** 2) + GRAVITY * st.h;
  let prev = energy(s);
  for (let i = 0; i < 60 * 10; i++) {
    stepBallState(s, DT);
    const e = energy(s);
    assert(e <= prev + 1e-6, `에너지 증가 발생: ${prev} → ${e}`);
    prev = e;
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 4 — 패스 솔버 정확도 (Section 34)');

/** Section 34 검증: 목표를 크게 지나치면 실패로 본다 */
const OVERSHOOT_LIMIT = 1.5;  // m
const CLOSEST_LIMIT = 1.0;    // m

test('20m 지상 패스가 목표에 도달한다', () => {
  const from = new Vector2D(20, 34);
  const to = new Vector2D(40, 34);
  const sol = solveGroundPass(from, to, { dt: DT, arrivalSpeed: 3.0 });
  assert(sol !== null && sol.feasible, '해를 찾지 못함');

  const v = verifySolution(from, to, sol, DT);
  assert(v.closestDistance < CLOSEST_LIMIT,
    `PASS_TRAJECTORY_FAILURE: 최근접 거리 ${v.closestDistance.toFixed(2)}m`);
  assert(Math.abs(v.overshoot) < OVERSHOOT_LIMIT,
    `PASS_TRAJECTORY_FAILURE: 오버슛 ${v.overshoot.toFixed(2)}m`);
  assertClose(v.arrivalSpeed, 3.0, 0.6, '도착 속력이 요청과 다름');
});

test('여러 거리·도착속력 조합에서 지상 패스가 정확하다', () => {
  const failures = [];
  for (const dist of [5, 10, 15, 20, 25, 30, 35]) {
    for (const arrival of [2.0, 3.5, 5.0]) {
      const from = new Vector2D(10, 34);
      const to = new Vector2D(10 + dist, 34);
      const sol = solveGroundPass(from, to, { dt: DT, arrivalSpeed: arrival });
      if (!sol || !sol.feasible) { failures.push(`${dist}m/${arrival} 해 없음`); continue; }
      const v = verifySolution(from, to, sol, DT);
      if (v.closestDistance > CLOSEST_LIMIT || Math.abs(v.overshoot) > OVERSHOOT_LIMIT) {
        failures.push(`${dist}m/${arrival}: 최근접 ${v.closestDistance.toFixed(2)} 오버슛 ${v.overshoot.toFixed(2)}`);
      }
    }
  }
  assertEqual(failures.length, 0, `PASS_TRAJECTORY_FAILURE:\n    ${failures.join('\n    ')}`);
});

test('30m 로빙 패스가 수신자를 넘어가지 않는다', () => {
  const from = new Vector2D(20, 34);
  const to = new Vector2D(50, 34);
  const sol = solveLoftedPass(from, to, { dt: DT });
  assert(sol !== null, '로빙 해를 찾지 못함');

  const v = verifySolution(from, to, sol, DT);
  assert(v.closestDistance < CLOSEST_LIMIT,
    `PASS_TRAJECTORY_FAILURE: 최근접 거리 ${v.closestDistance.toFixed(2)}m`);
  assert(Math.abs(v.overshoot) < OVERSHOOT_LIMIT,
    `PASS_TRAJECTORY_FAILURE: 오버슛 ${v.overshoot.toFixed(2)}m (구 엔진의 대표 실패 유형)`);
});

test('40m 로빙 패스가 수신자를 넘어가지 않는다', () => {
  const from = new Vector2D(15, 34);
  const to = new Vector2D(55, 34);
  const sol = solveLoftedPass(from, to, { dt: DT });
  assert(sol !== null, '로빙 해를 찾지 못함');

  const v = verifySolution(from, to, sol, DT);
  assert(v.closestDistance < CLOSEST_LIMIT,
    `PASS_TRAJECTORY_FAILURE: 최근접 거리 ${v.closestDistance.toFixed(2)}m`);
  assert(Math.abs(v.overshoot) < OVERSHOOT_LIMIT,
    `PASS_TRAJECTORY_FAILURE: 오버슛 ${v.overshoot.toFixed(2)}m`);
});

test('물리적 한계를 넘는 롱패스는 해를 만들지 않는다', () => {
  // 억지로 해를 지어내는 대신 "불가능"을 보고해야 한다.
  // (PassPlanner는 해가 없는 패스를 후보에서 제외한다)
  const from = new Vector2D(5, 34);
  const tooFar = new Vector2D(85, 34); // 80m — 최대 사거리(약 59m) 초과
  assertEqual(solveLoftedPass(from, tooFar, { dt: DT }), null,
    '도달 불가능한 거리인데 로빙 해를 반환함');
});

test('전 거리 구간에서 로빙 패스 오버슛이 허용치 이내다', () => {
  const failures = [];
  // 최대 사거리(약 59m) 안쪽 구간을 훑는다
  for (let dist = 10; dist <= 55; dist += 5) {
    const from = new Vector2D(5, 34);
    const to = new Vector2D(5 + dist, 34);
    const sol = solveLoftedPass(from, to, { dt: DT });
    if (!sol) { failures.push(`${dist}m: 해 없음`); continue; }
    const v = verifySolution(from, to, sol, DT);
    if (v.closestDistance > CLOSEST_LIMIT || Math.abs(v.overshoot) > OVERSHOOT_LIMIT) {
      failures.push(`${dist}m: 최근접 ${v.closestDistance.toFixed(2)} 오버슛 ${v.overshoot.toFixed(2)}`);
    }
  }
  assertEqual(failures.length, 0, `PASS_TRAJECTORY_FAILURE:\n    ${failures.join('\n    ')}`);
});

test('대각선 방향 패스도 동일하게 정확하다', () => {
  const failures = [];
  const from = new Vector2D(30, 34);
  for (let deg = 0; deg < 360; deg += 30) {
    const rad = (deg * Math.PI) / 180;
    const to = from.add(Vector2D.fromAngle(rad, 25));
    for (const solver of [solveGroundPass, solveLoftedPass]) {
      const sol = solver(from, to, { dt: DT, arrivalSpeed: 3 });
      if (!sol) { failures.push(`${deg}° ${solver.name}: 해 없음`); continue; }
      const v = verifySolution(from, to, sol, DT);
      if (v.closestDistance > CLOSEST_LIMIT) {
        failures.push(`${deg}° ${solver.name}: 최근접 ${v.closestDistance.toFixed(2)}m`);
      }
    }
  }
  assertEqual(failures.length, 0, `방향 의존 오차 발생:\n    ${failures.join('\n    ')}`);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 4 — 솔버·물리 일관성 (구조적 보증)');

test('솔버가 예측한 체공 시간이 실제 궤적과 일치한다', () => {
  // 솔버와 물리가 같은 적분기를 쓰므로 오차는 보간 수준이어야 한다
  for (const dist of [15, 25, 35, 45]) {
    const from = new Vector2D(10, 34);
    const to = new Vector2D(10 + dist, 34);

    const ground = solveGroundPass(from, to, { dt: DT, arrivalSpeed: 3 });
    const gv = verifySolution(from, to, ground, DT);
    assertClose(gv.closestTime, ground.flightTime, 0.05,
      `${dist}m 지상: 예측 체공(${ground.flightTime.toFixed(3)}s)과 실제(${gv.closestTime.toFixed(3)}s) 불일치`);

    const lofted = solveLoftedPass(from, to, { dt: DT });
    if (lofted) {
      const lv = verifySolution(from, to, lofted, DT);
      assertClose(lv.closestTime, lofted.flightTime, 0.05,
        `${dist}m 로빙: 예측 체공(${lofted.flightTime.toFixed(3)}s)과 실제(${lv.closestTime.toFixed(3)}s) 불일치`);
    }
  }
});

test('솔버 예측과 라이브 물리가 같은 궤적을 만든다', () => {
  // 솔버 해를 실제 Ball + BallPhysics로 돌려도 같은 곳에 도착해야 한다
  const from = new Vector2D(25, 20);
  const to = new Vector2D(55, 48);
  const sol = solvePass(from, to, { dt: DT, arrivalSpeed: 3 });

  const ball = new Ball();
  ball.placeAt(from);
  ball.kick(sol.velocity, sol.verticalVelocity, { flight: BallFlight.PASS, time: 0 });

  const physics = new BallPhysics(DT);
  const engine = { ball };

  let closest = Infinity;
  for (let i = 0; i < 60 * 8; i++) {
    physics.update(engine, DT);
    closest = Math.min(closest, ball.position.sub(to).length());
    if (ball.isStationary) break;
  }

  assert(closest < CLOSEST_LIMIT,
    `라이브 물리에서 최근접 ${closest.toFixed(2)}m — 솔버 예측과 불일치`);
});

test('solvePass는 도달 가능하면 지상을 택한다', () => {
  const from = new Vector2D(30, 34);
  const to = new Vector2D(45, 34);
  const sol = solvePass(from, to, { dt: DT, arrivalSpeed: 3 });
  assertEqual(sol.type, 'GROUND', '가까운 거리인데 로빙을 선택함');
});

test('mustLoft가 지정되면 반드시 띄운다', () => {
  const from = new Vector2D(30, 34);
  const to = new Vector2D(45, 34);
  const sol = solvePass(from, to, { dt: DT, mustLoft: true });
  assertEqual(sol.type, 'LOFTED');
  assert(sol.verticalVelocity > 0, '띄우라고 했는데 수직 속도가 없음');
});

test('최소 정점 제약이 지켜진다 (수비수 머리 위로 넘기기)', () => {
  const from = new Vector2D(20, 34);
  const to = new Vector2D(45, 34);
  const sol = solveLoftedPass(from, to, { dt: DT, minApex: 4.0 });
  assert(sol !== null, '제약을 만족하는 해가 없음');
  assert(sol.apex >= 4.0, `정점이 제약보다 낮음: ${sol.apex.toFixed(2)}m`);

  const v = verifySolution(from, to, sol, DT);
  assert(v.closestDistance < CLOSEST_LIMIT, '제약을 걸었더니 정확도가 무너짐');
});

test('선호 체공 시간에 가까운 해를 고른다', () => {
  const from = new Vector2D(20, 34);
  const to = new Vector2D(50, 34);
  const fast = solveLoftedPass(from, to, { dt: DT, preferredFlightTime: 1.2 });
  const slow = solveLoftedPass(from, to, { dt: DT, preferredFlightTime: 2.6 });
  assert(fast !== null && slow !== null, '해를 찾지 못함');
  assert(fast.flightTime < slow.flightTime,
    `선호 체공 시간이 반영되지 않음 (${fast.flightTime.toFixed(2)} vs ${slow.flightTime.toFixed(2)})`);
  // 둘 다 여전히 목표에 정확해야 한다
  for (const sol of [fast, slow]) {
    const v = verifySolution(from, to, sol, DT);
    assert(v.closestDistance < CLOSEST_LIMIT, '체공 시간 선호가 정확도를 해침');
  }
});

test('도착 속력이 낮을수록 목표를 지나 굴러가는 거리가 짧다', () => {
  // 굴러가는 거리 자체는 실패가 아니다. 다만 물리적으로 일관돼야 한다:
  // 발밑에 약하게 도착한 패스는 조금만 더 굴러야 한다.
  const from = new Vector2D(20, 34);
  const to = new Vector2D(40, 34);
  let prevRollOn = -Infinity;
  for (const arrival of [1.5, 3.0, 5.0, 7.0]) {
    const sol = solveGroundPass(from, to, { dt: DT, arrivalSpeed: arrival });
    const v = verifySolution(from, to, sol, DT);
    // 최근접 정확도는 도착 속력과 무관하게 유지돼야 한다
    assert(v.closestDistance < CLOSEST_LIMIT,
      `도착속력 ${arrival}: 최근접 ${v.closestDistance.toFixed(2)}m`);
    assert(Math.abs(v.overshoot) < OVERSHOOT_LIMIT,
      `도착속력 ${arrival}: 오버슛 ${v.overshoot.toFixed(2)}m`);
    assert(v.rollOnDistance > prevRollOn,
      `도착속력이 커졌는데 굴러간 거리가 늘지 않음 (${arrival})`);
    prevRollOn = v.rollOnDistance;
  }
});

test('공중 패스는 목표 지점에 착지한다', () => {
  // 로빙 패스는 착지 후 튀어 굴러가지만, 착지 지점 자체는 목표와 일치해야 한다
  for (const dist of [25, 35, 45]) {
    const from = new Vector2D(10, 34);
    const to = new Vector2D(10 + dist, 34);
    const sol = solveLoftedPass(from, to, { dt: DT });
    const v = verifySolution(from, to, sol, DT);
    assert(v.arrivalHeight < 0.6,
      `${dist}m: 최근접 시점에 볼이 공중에 있음 (${v.arrivalHeight.toFixed(2)}m) — 머리 위로 지나감`);
    assert(v.closestDistance < CLOSEST_LIMIT,
      `${dist}m: 최근접 ${v.closestDistance.toFixed(2)}m`);
  }
});

test('킥 속력이 물리적 상한을 넘지 않는다', () => {
  for (const dist of [10, 30, 50, 70, 90]) {
    const from = new Vector2D(5, 34);
    const to = new Vector2D(5 + dist, 34);
    for (const sol of [solveGroundPass(from, to, { dt: DT }), solveLoftedPass(from, to, { dt: DT })]) {
      if (!sol) continue;
      assert(sol.speed <= MAX_KICK_SPEED + 1e-6,
        `초기 속력이 상한 초과: ${sol.speed.toFixed(1)} m/s (${dist}m)`);
    }
  }
});

test('요구 조건을 만족할 수 없으면 feasible=false로 표시된다', () => {
  const from = new Vector2D(8, 34);
  const to = new Vector2D(98, 34); // 90m 지점에 12 m/s로 도착하라는 요구
  const ground = solveGroundPass(from, to, { dt: DT, arrivalSpeed: 12 });
  assertEqual(ground.feasible, false, '불가능한 요구를 가능하다고 보고함');

  // 아주 강하게 굴리면 90m를 지나가는 것 자체는 가능하다 (다만 느리게 도착)
  const weak = solveGroundPass(from, to, { dt: DT, arrivalSpeed: 2 });
  assertEqual(weak.feasible, true, '물리적으로 가능한 패스를 불가능하다고 보고함');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 4 — 결정론');

test('같은 입력은 항상 같은 해를 만든다', () => {
  const from = new Vector2D(31.7, 22.4);
  const to = new Vector2D(62.3, 47.1);
  const a = solvePass(from, to, { dt: DT, arrivalSpeed: 3.2 });
  const b = solvePass(from, to, { dt: DT, arrivalSpeed: 3.2 });
  assertEqual(a.speed, b.speed, '같은 입력에 다른 속력');
  assertEqual(a.flightTime, b.flightTime, '같은 입력에 다른 체공 시간');
  assertEqual(a.velocity.x, b.velocity.x);
  assertEqual(a.velocity.y, b.velocity.y);
});

test('볼 물리에 난수가 개입하지 않는다', () => {
  const run = () => {
    const s = { x: 10, y: 10, vx: 13.3, vy: -4.7, h: 0, vz: 6.1 };
    for (let i = 0; i < 300; i++) stepBallState(s, DT);
    return `${s.x},${s.y},${s.h},${s.vx},${s.vy},${s.vz}`;
  };
  assertEqual(run(), run(), '같은 초기 조건에서 결과가 달라짐');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 4 — BallPhysics 시스템 통합');

test('캐리 중인 볼도 물리 적분을 받는다 (부착하지 않는다)', () => {
  // 볼은 어떤 경우에도 선수에게 붙지 않는다 (Section 21: 터치 사이클).
  // 드리블 중에도 볼은 굴러가고, 선수가 주기적으로 터치해 끌고 간다.
  const ball = new Ball();
  ball.placeAt(new Vector2D(40, 34));
  ball.velocity = new Vector2D(10, 0);
  ball.carrier = { name: 'dummy' };

  const physics = new BallPhysics(DT);
  physics.update({ ball }, DT);
  assert(ball.position.x > 40, '캐리 중이라고 볼이 물리를 무시함 (부착 모델)');
});

test('볼이 멈추면 비행 정보가 정리된다', () => {
  const ball = new Ball();
  ball.placeAt(new Vector2D(40, 34));
  ball.kick(new Vector2D(2, 0), 0, { flight: BallFlight.PASS, time: 0 });
  ball.passTargetPlayer = { name: 'r' };

  const physics = new BallPhysics(DT);
  for (let i = 0; i < 60 * 10; i++) physics.update({ ball }, DT);

  assertEqual(ball.flight, BallFlight.NONE, '정지 후에도 비행 상태가 남음');
  assertEqual(ball.passTargetPlayer, null, '정지 후에도 수신자 지정이 남음');
});

test('predictStop이 실제 정지 위치와 일치한다', () => {
  const ball = new Ball();
  ball.placeAt(new Vector2D(20, 30));
  ball.kick(new Vector2D(11, 4), 0, { flight: BallFlight.PASS, time: 0 });

  const physics = new BallPhysics(DT);
  const predicted = physics.predictStop(ball);

  for (let i = 0; i < 60 * 15; i++) {
    physics.update({ ball }, DT);
    if (ball.isStationary) break;
  }

  const error = ball.position.sub(predicted.position).length();
  assert(error < 0.1, `정지 위치 예측 오차 ${error.toFixed(3)}m`);
});
