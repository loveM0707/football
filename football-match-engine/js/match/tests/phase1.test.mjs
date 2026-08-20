import { suite, test, assert, assertEqual, assertClose, assertRange, assertDeepEqual } from './_harness.mjs';

import { Rng } from '../core/Rng.js';
import { FixedStep } from '../sim/FixedStep.js';
import { MatchState, Phase, HALF_DURATION } from '../core/MatchState.js';
import { MatchEngine } from '../core/MatchEngine.js';
import { Player } from '../entities/Player.js';
import { Team, PossessionPhase, TRANSITION_DURATION } from '../entities/Team.js';
import { Ball, BallFlight } from '../entities/Ball.js';
import { Role, Duty, roamRadius, roleLine, Line } from '../tactics/RoleModel.js';
import { formationNames, validateFormation, resolveSlots } from '../tactics/Formation.js';
import {
  toTeamX, fromTeamX, toTeamY, fromTeamY, teamNX, teamNY,
  toTeamSpace, fromTeamSpace, opponentGoalLineX, ownGoalLineX,
  clamp, clamp01, smoothstep, angleDiff,
} from '../core/Coords.js';
import { Pitch } from '../../entities/Pitch.js';
import { Vector2D } from '../../entities/Vector2D.js';

// ════════════════════════════════════════════════════════════
suite('PHASE 3 — 결정론 RNG');

test('같은 시드는 같은 수열을 만든다', () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  for (let i = 0; i < 500; i++) {
    assertEqual(a.float(), b.float(), `${i}번째 값이 다름`);
  }
});

test('다른 시드는 다른 수열을 만든다', () => {
  const a = new Rng(1);
  const b = new Rng(2);
  let same = 0;
  for (let i = 0; i < 200; i++) {
    if (a.float() === b.float()) same++;
  }
  assert(same < 5, `서로 다른 시드인데 값이 ${same}개나 일치함`);
});

test('float()은 [0,1) 범위를 벗어나지 않는다', () => {
  const r = new Rng(777);
  for (let i = 0; i < 5000; i++) {
    const v = r.float();
    assert(v >= 0 && v < 1, `범위 이탈: ${v}`);
  }
});

test('reset()은 수열을 처음으로 되돌린다', () => {
  const r = new Rng(42);
  const first = [r.float(), r.float(), r.float()];
  r.reset();
  assertDeepEqual([r.float(), r.float(), r.float()], first, 'reset 후 수열이 다름');
});

test('clone()은 내부 상태까지 복제한다', () => {
  const r = new Rng(99);
  for (let i = 0; i < 10; i++) r.float();
  const c = r.clone();
  for (let i = 0; i < 50; i++) {
    assertEqual(r.float(), c.float(), '복제본 수열이 원본과 다름');
  }
});

test('stream()은 시스템별로 독립적인 수열을 만든다', () => {
  const root = new Rng(2026);
  const touch = root.stream('touch');
  const pass = root.stream('pass');
  let same = 0;
  for (let i = 0; i < 200; i++) {
    if (touch.float() === pass.float()) same++;
  }
  assert(same < 5, `독립 스트림인데 ${same}개 값이 일치함`);
});

test('stream()은 같은 라벨이면 재현된다', () => {
  const a = new Rng(555).stream('duel');
  const b = new Rng(555).stream('duel');
  for (let i = 0; i < 100; i++) assertEqual(a.float(), b.float());
});

test('gaussian()은 평균·표준편차를 대략 만족하고 clamp를 지킨다', () => {
  const r = new Rng(31337);
  const N = 20000;
  let sum = 0, sumSq = 0, maxAbs = 0;
  for (let i = 0; i < N; i++) {
    const v = r.gaussian(0, 1, 3);
    sum += v;
    sumSq += v * v;
    maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  const mean = sum / N;
  const sd = Math.sqrt(sumSq / N - mean * mean);
  assertRange(mean, -0.05, 0.05, '표본 평균이 0에서 벗어남');
  assertRange(sd, 0.90, 1.05, '표본 표준편차가 1에서 벗어남');
  assert(maxAbs <= 3 + 1e-9, `clamp(3σ)를 넘는 값 발생: ${maxAbs}`);
});

test('chance()는 경계값에서 확정적으로 동작한다', () => {
  const r = new Rng(8);
  for (let i = 0; i < 100; i++) {
    assertEqual(r.chance(0), false, 'p=0인데 true가 나옴');
    assertEqual(r.chance(1), true, 'p=1인데 false가 나옴');
  }
});

test('int()는 경계를 포함하고 범위를 벗어나지 않는다', () => {
  const r = new Rng(64);
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const v = r.int(3, 7);
    assert(Number.isInteger(v), `정수가 아님: ${v}`);
    assertRange(v, 3, 7, '범위 이탈');
    seen.add(v);
  }
  assertEqual(seen.size, 5, '경계값(3 또는 7)이 생성되지 않음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 3 — 고정 타임스텝');

test('누산기는 정확히 스텝 단위로만 전진한다', () => {
  const fs = new FixedStep({ step: 1 / 60 });
  const dts = [];
  fs.advance(0.1, 1, (dt) => dts.push(dt));
  assertEqual(dts.length, 6, '0.1초는 1/60 스텝 6회여야 함');
  for (const dt of dts) assertClose(dt, 1 / 60, 1e-12, '스텝 크기가 고정이 아님');
});

test('배속은 dt가 아니라 스텝 수를 늘린다', () => {
  const at1x = new FixedStep({ step: 1 / 60 });
  const at8x = new FixedStep({ step: 1 / 60 });
  const dts1 = [], dts8 = [];

  // 실제 재생과 같은 조건: 60fps로 1초(= 60프레임)를 재생한다
  for (let i = 0; i < 60; i++) {
    at1x.advance(1 / 60, 1, (dt) => dts1.push(dt));
    at8x.advance(1 / 60, 8, (dt) => dts8.push(dt));
  }

  assertEqual(dts1.length, 60, '1배속 1초(실시간) = 시뮬레이션 60스텝');
  assertEqual(dts8.length, 480, '8배속 1초(실시간) = 시뮬레이션 480스텝');
  // 핵심: 스텝 크기 자체는 배속과 무관하게 동일해야 한다
  for (const dt of dts8) assertClose(dt, 1 / 60, 1e-12, '배속이 스텝 크기를 바꿨음');
  // 예산 초과로 버려진 스텝이 없어야 한다 (정상 프레임률에서는 항상 따라잡아야 함)
  assertEqual(at8x.droppedSteps, 0, '정상 프레임률인데 스텝이 버려짐');
});

test('가변 프레임률이어도 같은 시뮬레이션 시간에 같은 스텝 수를 낸다', () => {
  const steady = new FixedStep({ step: 1 / 60 });
  const jittery = new FixedStep({ step: 1 / 60 });

  let steadyCount = 0, jitterCount = 0;
  // 60fps 균등
  for (let i = 0; i < 60; i++) steady.advance(1 / 60, 1, () => steadyCount++);
  // 불규칙 프레임 (합계는 동일하게 1초)
  const frames = [0.004, 0.031, 0.012, 0.05, 0.02, 0.008, 0.041, 0.017, 0.033, 0.027];
  let total = 0;
  for (const f of frames) total += f;
  const scale = 1 / total;
  for (const f of frames) jittery.advance(f * scale, 1, () => jitterCount++);

  assertEqual(steadyCount, 60);
  assertEqual(jitterCount, 60, '불규칙 프레임에서 스텝 수가 달라짐');
});

test('runSteps()는 누산기를 거치지 않고 정확한 횟수를 실행한다', () => {
  const fs = new FixedStep({ step: 1 / 60 });
  let n = 0;
  fs.runSteps(123, () => n++);
  assertEqual(n, 123);
  assertEqual(fs.totalSteps, 123);
});

test('스텝 예산 초과 시 누산기를 버려 죽음의 나선을 막는다', () => {
  const fs = new FixedStep({ step: 1 / 60, maxStepsPerFrame: 10 });
  let n = 0;
  fs.advance(5.0, 1, () => n++); // 300스텝 분량을 요구
  assertEqual(n, 10, '예산보다 많이 실행됨');
  assert(fs.droppedSteps > 0, '초과분이 버려지지 않음');
  assert(fs.accumulator < fs.step, '누산기에 부채가 남아 있음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 1 — 좌표계 (팀 상대 변환)');

test('홈 방향(+1)에서는 월드 좌표와 팀 좌표가 같다', () => {
  assertClose(toTeamX(30, 1), 30);
  assertClose(toTeamY(20, 1), 20);
});

test('원정 방향(-1)에서는 피치 중심 기준 180도 회전이다', () => {
  assertClose(toTeamX(30, -1), Pitch.LENGTH - 30);
  assertClose(toTeamY(20, -1), Pitch.WIDTH - 20);
});

test('왕복 변환은 원래 값을 복원한다', () => {
  for (const dir of [1, -1]) {
    for (const x of [0, 12.5, 52.5, 91, 105]) {
      assertClose(fromTeamX(toTeamX(x, dir), dir), x, 1e-9, `dir=${dir}, x=${x}`);
    }
    for (const y of [0, 7.3, 34, 60, 68]) {
      assertClose(fromTeamY(toTeamY(y, dir), dir), y, 1e-9, `dir=${dir}, y=${y}`);
    }
  }
});

test('팀 좌표에서 전진은 항상 +x 이다', () => {
  for (const dir of [1, -1]) {
    // 자기 골라인은 팀 x=0, 상대 골라인은 팀 x=LENGTH
    assertClose(toTeamX(ownGoalLineX(dir), dir), 0, 1e-9, `dir=${dir} 자기 골라인`);
    assertClose(toTeamX(opponentGoalLineX(dir), dir), Pitch.LENGTH, 1e-9, `dir=${dir} 상대 골라인`);
  }
});

test('정규화 전진도 nx는 자기 골문 0, 상대 골문 1이다', () => {
  for (const dir of [1, -1]) {
    assertClose(teamNX(ownGoalLineX(dir), dir), 0, 1e-9);
    assertClose(teamNX(opponentGoalLineX(dir), dir), 1, 1e-9);
    assertClose(teamNX(Pitch.LENGTH / 2, dir), 0.5, 1e-9, '중앙선은 항상 0.5');
  }
});

test('좌우 손잡이(handedness)가 보존된다', () => {
  // x·y를 함께 뒤집으므로 외적 부호가 유지되어야 한다.
  // (x만 뒤집으면 좌우가 뒤집혀 "왼쪽 윙어"가 반대편으로 간다)
  const a = new Vector2D(10, 5);
  const b = new Vector2D(20, 30);
  const crossWorld = (b.x - a.x) * (0 - a.y) - (b.y - a.y) * (0 - a.x);

  for (const dir of [1, -1]) {
    const ta = toTeamSpace(a, dir);
    const tb = toTeamSpace(b, dir);
    const to = toTeamSpace(new Vector2D(0, 0), dir);
    const crossTeam = (tb.x - ta.x) * (to.y - ta.y) - (tb.y - ta.y) * (to.x - ta.x);
    assert(Math.sign(crossTeam) === Math.sign(crossWorld),
      `dir=${dir}에서 손잡이가 뒤집힘`);
  }
});

test('위치 왕복 변환이 벡터 단위로도 성립한다', () => {
  const p = new Vector2D(73.2, 12.9);
  for (const dir of [1, -1]) {
    const back = fromTeamSpace(toTeamSpace(p, dir), dir);
    assertClose(back.x, p.x, 1e-9);
    assertClose(back.y, p.y, 1e-9);
  }
});

test('보조 수학 함수가 정의대로 동작한다', () => {
  assertEqual(clamp(5, 0, 3), 3);
  assertEqual(clamp(-5, 0, 3), 0);
  assertEqual(clamp01(1.7), 1);
  assertClose(smoothstep(0, 10, 5), 0.5);
  assertClose(smoothstep(0, 10, -3), 0);
  assertClose(smoothstep(0, 10, 99), 1);
  assertClose(angleDiff(Math.PI * 0.9, -Math.PI * 0.9), -Math.PI * 0.2, 1e-9,
    '각도 차이가 -π~π로 정규화되지 않음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 1 — 포메이션 구조');

test('모든 포메이션이 정합성 검사를 통과한다', () => {
  for (const name of formationNames()) {
    const problems = validateFormation(name);
    assertEqual(problems.length, 0, `${name}: ${problems.join(', ')}`);
  }
});

test('포메이션 슬롯에 절대 좌표가 없다', () => {
  // 좌표가 아니라 라인·채널·깊이라는 상대 구조만 있어야 한다
  for (const name of formationNames()) {
    for (const slot of resolveSlots(name)) {
      assert(slot.line !== undefined, `${name}: 라인 정보 없음`);
      assert(typeof slot.channel === 'number', `${name}: 채널 정보 없음`);
      assert(slot.x === undefined && slot.y === undefined,
        `${name}: 슬롯에 절대 좌표가 들어 있음`);
    }
  }
});

test('4-3-3은 최전방에 3명을 둔다', () => {
  const attack = resolveSlots('4-3-3').filter((s) => s.line === Line.ATTACK);
  assertEqual(attack.length, 3, '4-3-3 최전방 인원이 3명이 아님');
});

test('4-4-2는 최전방에 2명, 미드에 4명을 둔다', () => {
  const slots = resolveSlots('4-4-2');
  assertEqual(slots.filter((s) => s.line === Line.ATTACK).length, 2);
  assertEqual(slots.filter((s) => s.line === Line.MID).length, 4);
  assertEqual(slots.filter((s) => s.line === Line.BACK).length, 4);
});

test('채널은 좌우 대칭으로 배치된다', () => {
  for (const name of formationNames()) {
    const sum = resolveSlots(name).reduce((acc, s) => acc + s.channel, 0);
    assertClose(sum, 0, 1e-9, `${name}: 채널 합이 0이 아님 (좌우 비대칭)`);
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 1 — 역할 모델');

test('역할별 활동 자유도가 설계 의도를 따른다', () => {
  // Section 10: CB 작음 < CM 중간 < 윙어/ST 큼
  const cb = roamRadius(Role.CB, true);
  const cm = roamRadius(Role.CM, true);
  const wg = roamRadius(Role.WINGER, true);
  const st = roamRadius(Role.ST, true);
  assert(cb < cm, `CB(${cb}) 자유도가 CM(${cm})보다 작아야 함`);
  assert(cm < wg, `CM(${cm}) 자유도가 윙어(${wg})보다 작아야 함`);
  assert(cm < st, `CM(${cm}) 자유도가 ST(${st})보다 작아야 함`);
});

test('수비 시 자유도는 공격 시보다 작다', () => {
  for (const role of [Role.FB, Role.CM, Role.WINGER, Role.ST]) {
    assert(roamRadius(role, false) < roamRadius(role, true),
      `${role}: 수비 자유도가 공격 자유도보다 크거나 같음`);
  }
});

test('역할이 올바른 라인에 속한다', () => {
  assertEqual(roleLine(Role.CB), Line.BACK);
  assertEqual(roleLine(Role.FB), Line.BACK);
  assertEqual(roleLine(Role.DM), Line.MID);
  assertEqual(roleLine(Role.CM), Line.MID);
  assertEqual(roleLine(Role.ST), Line.ATTACK);
  assertEqual(roleLine(Role.GK), Line.GK);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 2 — 엔티티');

/** 테스트용 팀 생성 */
function makeTeam(side, formation = '4-4-2', attrs = {}) {
  const players = [];
  for (let i = 0; i < 11; i++) {
    players.push(new Player({
      id: `${side}-${i}`,
      name: `${side}${i}`,
      number: i + 1,
      attributes: attrs,
    }));
  }
  return new Team({
    name: side === 'home' ? '홈팀' : '원정팀',
    side,
    color: '#000',
    formationName: formation,
    players,
  });
}

test('팀 생성 시 선수에게 슬롯과 역할이 주입된다', () => {
  const team = makeTeam('home', '4-3-3');
  assertEqual(team.players.length, 11);
  for (const p of team.players) {
    assert(p.team === team, '팀 역참조가 없음');
    assert(p.slot !== null, '슬롯이 배정되지 않음');
    assertEqual(p.role, p.slot.role, '역할과 슬롯 역할이 불일치');
  }
  assert(team.goalkeeper !== null, '골키퍼가 없음');
  assertEqual(team.outfield.length, 10, '필드 플레이어가 10명이 아님');
});

test('공격 방향이 홈 +1, 원정 -1로 설정된다', () => {
  assertEqual(makeTeam('home').attackingDirection, 1);
  assertEqual(makeTeam('away').attackingDirection, -1);
});

test('진영 교대는 공격 방향을 뒤집는다', () => {
  const team = makeTeam('home');
  team.swapSides();
  assertEqual(team.attackingDirection, -1);
  team.swapSides();
  assertEqual(team.attackingDirection, 1);
});

test('선수의 물리 한계가 실제 축구 범위 안에 있다', () => {
  const slow = new Player({ id: 's', name: 's', number: 1, attributes: { pace: 30, acceleration: 30, agility: 30 } });
  const fast = new Player({ id: 'f', name: 'f', number: 2, attributes: { pace: 95, acceleration: 95, agility: 95 } });

  // 최고 속도: 대략 6.8 ~ 9.0 m/s (24 ~ 32 km/h)
  assertRange(slow.maxSpeed, 6.5, 8.0, '느린 선수 최고 속도');
  assertRange(fast.maxSpeed, 8.5, 9.5, '빠른 선수 최고 속도');
  assert(fast.maxSpeed > slow.maxSpeed, '능력치가 속도에 반영되지 않음');

  // 가속도: 대략 3.5 ~ 7.0 m/s²
  assertRange(slow.maxAcceleration, 3.5, 5.5, '느린 선수 가속도');
  assertRange(fast.maxAcceleration, 6.0, 7.5, '빠른 선수 가속도');

  // 감속은 가속보다 빠르다
  assert(fast.maxDeceleration > fast.maxAcceleration, '감속도가 가속도보다 작음');
});

test('체력이 떨어져도 속도가 0으로 붕괴하지 않는다', () => {
  const p = new Player({ id: 'p', name: 'p', number: 1, attributes: { pace: 70 } });
  const full = p.maxSpeed;
  p.energy = 0;
  const empty = p.maxSpeed;
  assert(empty < full, '체력 소진이 속도에 반영되지 않음');
  assert(empty > full * 0.8, `체력 소진 시 속도가 과도하게 붕괴함 (${empty}/${full})`);
});

test('체력은 90분 동안 서서히 소모된다', () => {
  const p = new Player({ id: 'p', name: 'p', number: 1, attributes: { stamina: 60 } });
  const dt = 1 / 60;
  // 90분간 중간 강도로 뛴다
  for (let i = 0; i < 90 * 60 * 60; i++) p.updateEnergy(dt, 0.55);
  assertRange(p.energy, 0.45, 0.95, '90분 후 잔여 체력이 비현실적');
});

test('볼은 상태만 갖고 스스로 움직이지 않는다', () => {
  const ball = new Ball();
  ball.placeAt(new Vector2D(52.5, 34));
  assert(ball.isStationary, '배치 직후 볼이 정지 상태가 아님');
  assertEqual(ball.isAirborne, false);
  assertEqual(ball.isCarried, false);

  const before = ball.position.clone();
  // 물리 시스템 없이는 위치가 변하지 않아야 한다
  assertClose(ball.position.x, before.x);
  assertClose(ball.position.y, before.y);
});

test('볼 접촉 기록이 마지막/직전 접촉자를 구분한다', () => {
  const team = makeTeam('home');
  const [a, b] = team.players;
  const ball = new Ball();

  ball.registerTouch(a, 1.0);
  assertEqual(ball.lastTouch.player, a);
  assertEqual(ball.previousTouch, null);

  // 같은 선수의 연속 접촉은 직전 접촉자를 덮어쓰지 않는다
  ball.registerTouch(a, 1.2);
  assertEqual(ball.previousTouch, null, '같은 선수 연속 접촉이 직전 기록을 덮어씀');

  ball.registerTouch(b, 1.5);
  assertEqual(ball.lastTouch.player, b);
  assertEqual(ball.previousTouch.player, a);
});

test('킥은 초기 조건만 설정하고 접촉을 기록한다', () => {
  const team = makeTeam('home');
  const kicker = team.players[5];
  const ball = new Ball();
  ball.placeAt(new Vector2D(40, 34));
  ball.kick(new Vector2D(12, 0), 4, { kicker, flight: BallFlight.PASS, time: 3.5 });

  assertClose(ball.velocity.x, 12);
  assertClose(ball.verticalVelocity, 4);
  assertEqual(ball.flight, BallFlight.PASS);
  assertEqual(ball.kicker, kicker);
  assertEqual(ball.lastTouch.player, kicker, '킥이 접촉으로 기록되지 않음');
  assertEqual(ball.carrier, null, '킥 후에도 캐리어가 남아 있음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 1 — 경기 상태 기계');

test('시계는 정해진 국면에서만 흐른다', () => {
  const s = new MatchState();

  s.setPhase(Phase.PRE_MATCH);
  s.advance(1.0);
  assertClose(s.halfSeconds, 0, 1e-9, 'PRE_MATCH에서 시계가 흘렀음');

  s.setPhase(Phase.IN_PLAY);
  s.advance(1.0);
  assertClose(s.halfSeconds, 1.0, 1e-9, 'IN_PLAY에서 시계가 흐르지 않음');

  s.setPhase(Phase.HALF_TIME);
  s.advance(5.0);
  assertClose(s.halfSeconds, 1.0, 1e-9, 'HALF_TIME에서 시계가 흘렀음');

  // 세트피스 준비 중에도 경기 시계는 흐른다 (IFAB: 시계는 멈추지 않는다)
  s.setPhase(Phase.THROW_IN);
  s.advance(2.0);
  assertClose(s.halfSeconds, 3.0, 1e-9, '세트피스 중 시계가 멈춤');
});

test('인플레이 여부는 IN_PLAY 국면에서만 참이다', () => {
  const s = new MatchState();
  const inPlayPhases = [Phase.IN_PLAY];
  const outPhases = [
    Phase.PRE_MATCH, Phase.KICKOFF, Phase.THROW_IN, Phase.CORNER_KICK,
    Phase.GOAL_KICK, Phase.PENALTY, Phase.GOAL, Phase.HALF_TIME, Phase.FULL_TIME,
    Phase.DIRECT_FREE_KICK, Phase.INDIRECT_FREE_KICK, Phase.OFFSIDE,
  ];
  for (const p of inPlayPhases) {
    s.setPhase(p);
    assertEqual(s.isBallInPlay, true, `${p}는 인플레이여야 함`);
  }
  for (const p of outPhases) {
    s.setPhase(p);
    assertEqual(s.isBallInPlay, false, `${p}는 아웃오브플레이여야 함`);
  }
});

test('하프 종료는 정규 시간 + 추가 시간을 모두 소진해야 성립한다', () => {
  const s = new MatchState();
  s.setPhase(Phase.IN_PLAY);
  s.halfSeconds = HALF_DURATION;
  assertEqual(s.isHalfExpired, true, '정규 시간 만료가 감지되지 않음');
  assertEqual(s.isHalfComplete, true, '추가 시간 0일 때 하프가 끝나야 함');

  s.addStoppage(120);
  assertEqual(s.isHalfComplete, false, '추가 시간이 남았는데 하프가 끝남');
  s.halfSeconds += 120;
  assertEqual(s.isHalfComplete, true, '추가 시간 소진 후에도 하프가 안 끝남');
});

test('후반 시작 시 시계와 추가 시간이 초기화된다', () => {
  const s = new MatchState();
  s.halfSeconds = HALF_DURATION;
  s.addStoppage(90);
  s.startSecondHalf();
  assertEqual(s.half, 2);
  assertClose(s.halfSeconds, 0);
  assertClose(s.stoppageSeconds, 0);
});

test('표시 시계는 후반에 45분부터 이어진다', () => {
  const s = new MatchState();
  s.setPhase(Phase.IN_PLAY);
  s.halfSeconds = 65; // 1분 5초
  assertEqual(s.displayMinute, 1);
  assertEqual(s.displaySecond, 5);

  s.startSecondHalf();
  s.halfSeconds = 65;
  assertEqual(s.displayMinute, 46, '후반 표시가 45분부터 이어지지 않음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 1 — 팀 소유 국면');

test('전환 국면은 정해진 시간 후 안정 국면으로 넘어간다', () => {
  const team = makeTeam('home');
  team.setPhase(PossessionPhase.TRANSITION_ATTACK);

  const dt = 1 / 60;
  for (let t = 0; t < TRANSITION_DURATION - 0.1; t += dt) team.advancePhase(dt);
  assertEqual(team.phase, PossessionPhase.TRANSITION_ATTACK, '전환 국면이 너무 빨리 끝남');

  for (let t = 0; t < 0.3; t += dt) team.advancePhase(dt);
  assertEqual(team.phase, PossessionPhase.IN_POSSESSION, '전환 국면이 안정 국면으로 넘어가지 않음');
});

test('수비 전환도 같은 방식으로 만료된다', () => {
  const team = makeTeam('away');
  team.setPhase(PossessionPhase.TRANSITION_DEFENCE);
  const dt = 1 / 60;
  for (let t = 0; t < TRANSITION_DURATION + 0.2; t += dt) team.advancePhase(dt);
  assertEqual(team.phase, PossessionPhase.OUT_OF_POSSESSION);
});

test('공격/수비 국면 판정이 전환 상태를 포함한다', () => {
  const team = makeTeam('home');
  team.setPhase(PossessionPhase.IN_POSSESSION);
  assertEqual(team.isAttacking, true);
  team.setPhase(PossessionPhase.TRANSITION_ATTACK);
  assertEqual(team.isAttacking, true, '공격 전환이 공격 국면으로 잡히지 않음');
  team.setPhase(PossessionPhase.TRANSITION_DEFENCE);
  assertEqual(team.isDefending, true, '수비 전환이 수비 국면으로 잡히지 않음');
  team.setPhase(PossessionPhase.OUT_OF_POSSESSION);
  assertEqual(team.isDefending, true);
});

test('같은 국면을 다시 지정해도 타이머가 초기화되지 않는다', () => {
  const team = makeTeam('home');
  team.setPhase(PossessionPhase.IN_POSSESSION);
  team.advancePhase(0.5);
  team.setPhase(PossessionPhase.IN_POSSESSION);
  assertClose(team.phaseTimer, 0.5, 1e-9, '동일 국면 재지정이 타이머를 리셋함');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 1 — MatchEngine 골격 / 결정론');

/** 테스트용 엔진 생성 */
function makeEngine(seed = 12345) {
  return new MatchEngine({
    homeTeam: makeTeam('home', '4-4-2'),
    awayTeam: makeTeam('away', '4-3-3'),
    seed,
  });
}

test('엔진이 팀 상호 참조를 주입한다', () => {
  const e = makeEngine();
  assertEqual(e.homeTeam.opponent, e.awayTeam);
  assertEqual(e.awayTeam.opponent, e.homeTeam);
});

test('하위 시스템이 없어도 스텝이 안전하게 진행된다', () => {
  const e = makeEngine();
  e.setPhase(Phase.IN_PLAY);
  e.runSeconds(2);
  assertEqual(e.stepCount, 120, '2초에 120스텝이 실행되지 않음');
  assertClose(e.state.halfSeconds, 2.0, 1e-6);
});

test('같은 시드는 같은 상태 해시를 만든다', () => {
  const a = makeEngine(2026);
  const b = makeEngine(2026);
  a.setPhase(Phase.IN_PLAY);
  b.setPhase(Phase.IN_PLAY);
  a.runSeconds(30);
  b.runSeconds(30);
  assertEqual(a.hash(), b.hash(), '동일 시드인데 상태 해시가 다름');
});

test('1배속과 8배속이 동일한 시뮬레이션 결과를 낸다', () => {
  // Section 6 요구: 배속은 궤적을 바꾸지 않는다
  const slow = makeEngine(4242);
  const fast = makeEngine(4242);
  slow.setPhase(Phase.IN_PLAY);
  fast.setPhase(Phase.IN_PLAY);

  // 같은 시뮬레이션 시간(2초)을 서로 다른 배속으로 소화한다
  for (let i = 0; i < 120; i++) slow.advance(1 / 60, 1);
  for (let i = 0; i < 15; i++) fast.advance(1 / 60, 8);

  assertEqual(slow.stepCount, fast.stepCount, '배속에 따라 스텝 수가 달라짐');
  assertEqual(slow.hash(), fast.hash(), '배속에 따라 시뮬레이션 결과가 달라짐');
});

test('난수 스트림이 시스템별로 분리되어 있다', () => {
  const e = makeEngine(31337);
  const names = Object.keys(e.rng);
  assert(names.length >= 5, '난수 스트림이 충분히 분리되지 않음');
  const firsts = names.map((n) => e.rng[n].float());
  assertEqual(new Set(firsts).size, firsts.length, '서로 다른 스트림이 같은 값을 냄');
});

test('국면 전환이 이벤트로 통지된다', () => {
  const e = makeEngine();
  const seen = [];
  e.eventBus.on('phase', (ev) => seen.push(ev));
  e.setPhase(Phase.KICKOFF);
  e.setPhase(Phase.IN_PLAY);
  assertEqual(seen.length, 2, '국면 전환 이벤트가 누락됨');
  assertEqual(seen[1].from, Phase.KICKOFF);
  assertEqual(seen[1].to, Phase.IN_PLAY);
});
