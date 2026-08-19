import { suite, test, assert, assertEqual, assertClose, assertRange } from './_harness.mjs';

import { PassPlanner, PassType } from '../ai/PassPlanner.js';
import { timeToReach, futurePosition, isLaneBlocked, pressureAt } from '../ai/Estimates.js';
import { traceTrajectory, verifySolution } from '../ball/PassSolver.js';
import { MatchEngine } from '../core/MatchEngine.js';
import { Phase } from '../core/MatchState.js';
import { Player, Action } from '../entities/Player.js';
import { Team } from '../entities/Team.js';
import { Role } from '../tactics/RoleModel.js';
import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';

const DT = 1 / 60;

function makeTeam(side, formation = '4-4-2', attrs = {}) {
  const players = [];
  for (let i = 0; i < 11; i++) {
    players.push(new Player({ id: `${side}${i}`, name: `${side}${i}`, number: i + 1, attributes: attrs }));
  }
  return new Team({ name: side, side, color: '#000', formationName: formation, players });
}

/**
 * 패스 시나리오를 세운다.
 * 모든 선수를 경기장 밖으로 치워두고, 지정한 선수만 배치한다.
 */
function scenario({ seed = 100, homeAttrs = {}, awayAttrs = {} } = {}) {
  const engine = new MatchEngine({
    homeTeam: makeTeam('home', '4-4-2', homeAttrs),
    awayTeam: makeTeam('away', '4-4-2', awayAttrs),
    seed,
  });
  engine.setPhase(Phase.IN_PLAY);
  engine.allPlayers.forEach((p, i) => {
    p.position = new Vector2D(-60 - i * 2, -60);
    p.velocity = Vector2D.zero();
    p.facingAngle = 0;
    p.setDecision(Action.IDLE, null);
  });
  const planner = new PassPlanner(DT);
  return { engine, planner };
}

/** 홈팀에서 특정 역할의 선수를 꺼내 배치한다 */
function place(team, index, position, { role = null, velocity = null, facing = 0 } = {}) {
  const p = team.players[index];
  p.position = position.clone();
  if (role) p.role = role;
  if (velocity) p.velocity = velocity.clone();
  p.facingAngle = facing;
  return p;
}

// ════════════════════════════════════════════════════════════
suite('PHASE 7 — 도달 시간 추정');

test('가까운 지점일수록 빨리 도달한다', () => {
  const p = new Player({ id: 'a', name: 'a', number: 1, attributes: { pace: 70, acceleration: 70 } });
  p.position = new Vector2D(50, 34);
  const near = timeToReach(p, new Vector2D(55, 34));
  const far = timeToReach(p, new Vector2D(75, 34));
  assert(near < far, '거리와 도달 시간의 관계가 어긋남');
  assertRange(near, 0.8, 2.5, '5m 도달 시간');
});

test('반대 방향으로 달리고 있으면 도달이 늦어진다', () => {
  const make = (vx) => {
    const p = new Player({ id: 'a', name: 'a', number: 1, attributes: { pace: 75, acceleration: 75 } });
    p.position = new Vector2D(50, 34);
    p.velocity = new Vector2D(vx, 0);
    return timeToReach(p, new Vector2D(65, 34));
  };
  const towards = make(6);
  const away = make(-6);
  assert(away > towards,
    `관성이 반영되지 않음 (같은 방향 ${towards.toFixed(2)}s, 반대 ${away.toFixed(2)}s)`);
});

test('반응 지연이 포함된다', () => {
  const p = new Player({ id: 'a', name: 'a', number: 1, attributes: { reactions: 40 } });
  p.position = new Vector2D(50, 34);
  const withReaction = timeToReach(p, p.position.clone());
  assert(withReaction > 0, '제자리인데도 반응 지연이 없음');
  assertEqual(timeToReach(p, p.position.clone(), { includeReaction: false }), 0);
});

test('미래 위치 예측은 먼 미래일수록 보수적이다', () => {
  const p = new Player({ id: 'a', name: 'a', number: 1 });
  p.position = new Vector2D(50, 34);
  p.velocity = new Vector2D(6, 0);

  const at1s = futurePosition(p, 1).x - 50;
  const at2s = futurePosition(p, 2).x - 50;
  // 등속 외삽이면 각각 6m, 12m가 나온다. 감쇠가 있어야 그보다 작다.
  assert(at1s < 6, `1초 예측이 등속 외삽과 같음 (${at1s.toFixed(2)}m)`);
  assert(at2s < 12, `2초 예측이 등속 외삽과 같음 (${at2s.toFixed(2)}m)`);
  assert(at2s / at1s < 2, '먼 미래일수록 보수적이지 않음');
});

test('경로 차단 판정이 동작한다', () => {
  const from = new Vector2D(30, 34);
  const to = new Vector2D(50, 34);
  const blocker = { position: new Vector2D(40, 34.2) };
  const aside = { position: new Vector2D(40, 40) };
  assert(isLaneBlocked(from, to, [blocker]), '경로 위 수비수를 감지하지 못함');
  assert(!isLaneBlocked(from, to, [aside]), '경로 밖 수비수를 차단으로 오판');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 7 — 후보 생성과 물리 정확도');

test('계획된 패스는 실제로 목표에 도달한다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(40, 34));
  place(engine.homeTeam, 9, new Vector2D(58, 30), { role: Role.ST });

  const option = planner.plan(engine, passer);
  assert(option !== null, '패스 후보를 하나도 만들지 못함');

  const v = verifySolution(passer.position, option.targetPosition, option.solution, DT);
  assert(v.closestDistance < 1.0,
    `계획한 패스가 목표에 도달하지 않음 (최근접 ${v.closestDistance.toFixed(2)}m)`);
});

test('모든 후보가 물리적으로 실행 가능하다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(45, 34));
  place(engine.homeTeam, 6, new Vector2D(55, 20));
  place(engine.homeTeam, 7, new Vector2D(60, 48));
  place(engine.homeTeam, 9, new Vector2D(75, 34), { role: Role.ST });
  place(engine.homeTeam, 2, new Vector2D(30, 30));

  const options = planner.generateOptions(engine, passer);
  assert(options.length > 0, '후보가 없음');

  for (const o of options) {
    const v = verifySolution(passer.position, o.targetPosition, o.solution, DT);
    assert(v.closestDistance < 1.2,
      `${o.receiver.id} ${o.targetKind}: 최근접 ${v.closestDistance.toFixed(2)}m`);
    assert(o.solution.speed <= 32.01, '킥 속력 상한 초과');
  }
});

test('수신자가 도달할 수 없는 지점은 후보에서 제외된다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(20, 34));
  // 수신자는 아주 멀리 — 볼보다 먼저 갈 수 없다
  place(engine.homeTeam, 9, new Vector2D(95, 34), { role: Role.ST });

  const options = planner.generateOptions(engine, passer);
  for (const o of options) {
    assert(o.receiverETA <= o.ballETA + 0.46,
      `수신자가 볼보다 ${(o.receiverETA - o.ballETA).toFixed(2)}s 늦는데 후보로 남음`);
  }
});

test('너무 가까운 상대는 패스 대상이 아니다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(50, 34));
  place(engine.homeTeam, 6, new Vector2D(52, 34)); // 2m — 패스 거리가 아님

  const options = planner.generateOptions(engine, passer);
  for (const o of options) {
    assert(o.distance >= 4.0, `${o.distance.toFixed(1)}m 패스가 후보에 있음`);
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 7 — 가로채기 위험');

test('깨끗한 경로에서는 지상 패스를 쓴다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(40, 34));
  const receiver = place(engine.homeTeam, 6, new Vector2D(60, 34));

  const options = planner.generateOptions(engine, passer)
    .filter((o) => o.receiver === receiver && o.targetKind === 'FEET');
  assert(options.length > 0, '후보가 없음');
  assert(options.some((o) => !o.lofted), '막힘이 없는데 지상 후보가 하나도 없음');
  assert(options.every((o) => o.risk < 0.3), '수비수가 없는데 위험이 높음');
});

test('경로를 막고 선 수비수는 로빙으로 넘긴다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(40, 34));
  const receiver = place(engine.homeTeam, 6, new Vector2D(60, 34));
  // 경로 한가운데에 수비수를 놓는다
  place(engine.awayTeam, 4, new Vector2D(50, 34));

  const options = planner.generateOptions(engine, passer)
    .filter((o) => o.receiver === receiver && o.targetKind === 'FEET');
  assert(options.length > 0, '막힌 경로에서 대안을 만들지 못함');
  assert(options.every((o) => o.lofted),
    '경로가 막혔는데 지상 패스를 그대로 시도함');
});

test('경로 옆 수비수는 지상 패스의 가로채기 위험을 높인다', () => {
  // 경로에서 살짝 벗어나 있어 "막힘"은 아니지만 뛰어들어 끊을 수 있는 경우
  const riskOf = (defenderY) => {
    const { engine, planner } = scenario();
    const passer = place(engine.homeTeam, 5, new Vector2D(35, 34));
    const receiver = place(engine.homeTeam, 6, new Vector2D(65, 34));
    if (defenderY !== null) place(engine.awayTeam, 4, new Vector2D(50, defenderY));

    const ground = planner.generateOptions(engine, passer)
      .filter((o) => o.receiver === receiver && o.targetKind === 'FEET' && !o.lofted);
    if (ground.length === 0) return null;
    return Math.min(...ground.map((o) => o.risk));
  };

  const clean = riskOf(null);
  const nearby = riskOf(36); // 경로에서 2m 옆 — 뛰어들면 닿는 거리
  assert(clean !== null, '깨끗한 경로에서 지상 후보가 없음');
  assert(nearby !== null, '옆에 수비수가 있다고 지상 후보가 사라짐');
  assert(nearby > clean,
    `경로 옆 수비수가 위험에 반영되지 않음 (${clean.toFixed(2)} → ${nearby.toFixed(2)})`);
});

test('세게 찬 패스가 약한 패스보다 덜 끊긴다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(35, 34));
  const receiver = place(engine.homeTeam, 6, new Vector2D(65, 34));
  // 경로에서 8m 옆 — 약한 패스는 끊길 수 있고 강한 패스는 안전한 거리
  place(engine.awayTeam, 4, new Vector2D(50, 42));

  const ground = planner.generateOptions(engine, passer)
    .filter((o) => o.receiver === receiver && o.targetKind === 'FEET' && !o.lofted)
    .sort((a, b) => a.requestedArrivalSpeed - b.requestedArrivalSpeed);

  assert(ground.length >= 2, '패스 세기 후보가 둘 이상 생성되지 않음');
  const soft = ground[0];
  const firm = ground[ground.length - 1];
  assert(firm.ballETA < soft.ballETA, '세게 찼는데 더 늦게 도착함');
  assert(firm.risk <= soft.risk,
    `세게 찼는데 위험이 더 높음 (약 ${soft.risk.toFixed(2)}, 강 ${firm.risk.toFixed(2)})`);
});

test('머리 위로 넘기는 패스는 발로 끊기지 않는다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(35, 34));
  const receiver = place(engine.homeTeam, 6, new Vector2D(65, 34));
  // 경로 중앙에 수비수 — 지상은 막히지만 로빙은 가능해야 한다
  place(engine.awayTeam, 4, new Vector2D(50, 34));

  const options = planner.generateOptions(engine, passer)
    .filter((o) => o.receiver === receiver);
  assert(options.length > 0, '막힌 경로에서 대안(로빙)을 만들지 못함');

  const lofted = options.find((o) => o.lofted);
  assert(lofted !== undefined, '지상이 막혔는데 로빙 후보가 없음');
  assert(lofted.solution.apex > 2.0,
    `로빙인데 정점이 낮음 (${lofted.solution.apex?.toFixed(2)}m)`);
});

test('확실히 끊기는 패스는 후보에서 제외된다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(40, 34));
  place(engine.homeTeam, 6, new Vector2D(60, 34));
  // 수신자를 여러 수비수가 완전히 둘러싼다
  place(engine.awayTeam, 1, new Vector2D(57, 34));
  place(engine.awayTeam, 2, new Vector2D(60, 31));
  place(engine.awayTeam, 3, new Vector2D(60, 37));
  place(engine.awayTeam, 4, new Vector2D(50, 34));
  place(engine.awayTeam, 5, new Vector2D(45, 34));

  const options = planner.generateOptions(engine, passer);
  for (const o of options) {
    assert(o.risk < 0.98, '사실상 확실히 끊기는 패스가 후보에 남음');
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 7 — 패스 종류 분류');

test('전진 패스와 백패스를 구분한다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(50, 34));
  const forward = place(engine.homeTeam, 9, new Vector2D(72, 34), { role: Role.ST });
  const behind = place(engine.homeTeam, 2, new Vector2D(30, 34), { role: Role.CB });

  const options = planner.generateOptions(engine, passer);
  const toForward = options.find((o) => o.receiver === forward && o.targetKind === 'FEET');
  const toBehind = options.find((o) => o.receiver === behind && o.targetKind === 'FEET');

  assert(toForward, '전방 수신자 후보 없음');
  assert(toBehind, '후방 수신자 후보 없음');
  assertEqual(toForward.type, PassType.PROGRESSIVE, '전진 패스로 분류되지 않음');
  assertEqual(toBehind.type, PassType.BACK, '백패스로 분류되지 않음');
});

test('먼 측면 전환을 SWITCH로 분류한다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(50, 10));
  const farSide = place(engine.homeTeam, 7, new Vector2D(52, 58));

  const options = planner.generateOptions(engine, passer);
  const option = options.find((o) => o.receiver === farSide && o.targetKind === 'FEET');
  assert(option, '측면 전환 후보 없음');
  assertEqual(option.type, PassType.SWITCH);
});

test('침투 공간 후보는 THROUGH로 분류된다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(55, 34));
  const striker = place(engine.homeTeam, 9, new Vector2D(70, 34), {
    role: Role.ST, velocity: new Vector2D(5, 0),
  });

  const options = planner.generateOptions(engine, passer);
  const through = options.find((o) => o.receiver === striker && o.targetKind === 'SPACE');
  assert(through, '침투 후보가 생성되지 않음');
  assertEqual(through.type, PassType.THROUGH);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 7 — 스루패스 선택성 (Section 17)');

test('스루패스 목표가 수신자 도달 범위 안에 있다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(55, 34));
  const striker = place(engine.homeTeam, 9, new Vector2D(70, 34), {
    role: Role.ST, velocity: new Vector2D(6, 0),
  });

  const through = planner.generateOptions(engine, passer)
    .filter((o) => o.receiver === striker && o.targetKind === 'SPACE');

  for (const o of through) {
    const ahead = o.targetPosition.sub(striker.position).length();
    // 정상 속도로 달리는 선수 앞 20m에 볼을 놓지 않는다
    assert(ahead < 18, `수신자 앞 ${ahead.toFixed(1)}m — 너무 멀다`);
    // 수신자가 실제로 도달 가능해야 한다
    assert(o.receiverETA <= o.ballETA + 0.46,
      `스루패스인데 수신자가 못 따라감 (${o.receiverETA.toFixed(2)}s vs ${o.ballETA.toFixed(2)}s)`);
  }
});

test('수비수가 먼저 닿는 침투 패스는 선택되지 않는다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(55, 34));
  const striker = place(engine.homeTeam, 9, new Vector2D(70, 34), {
    role: Role.ST, velocity: new Vector2D(5, 0),
  });
  const safeOutlet = place(engine.homeTeam, 6, new Vector2D(58, 20));

  // 침투 공간에 수비수를 미리 세워둔다
  place(engine.awayTeam, 3, new Vector2D(80, 34));
  place(engine.awayTeam, 4, new Vector2D(78, 32));

  const best = planner.plan(engine, passer);
  assert(best !== null, '후보가 없음');
  if (best.type === PassType.THROUGH) {
    assert(best.risk < 0.5,
      `수비수가 지키는 공간으로 위험한 스루패스를 선택함 (위험 ${best.risk.toFixed(2)})`);
  }
});

test('스루패스는 기본 가산점이 없어 드물게 선택된다', () => {
  // 열린 전방 패스와 침투 패스가 모두 가능할 때,
  // 침투가 무조건 이기지는 않아야 한다
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(50, 34));
  place(engine.homeTeam, 6, new Vector2D(64, 34)); // 발밑으로 받을 수 있는 동료
  place(engine.homeTeam, 9, new Vector2D(68, 40), {
    role: Role.ST, velocity: new Vector2D(4, 0),
  });

  const options = planner.generateOptions(engine, passer);
  const throughs = options.filter((o) => o.type === PassType.THROUGH);
  const others = options.filter((o) => o.type !== PassType.THROUGH);
  assert(throughs.length > 0 && others.length > 0, '비교할 후보가 부족함');

  const bestThrough = Math.max(...throughs.map((o) => o.utility));
  const bestOther = Math.max(...others.map((o) => o.utility));
  assert(bestOther >= bestThrough - 0.5,
    '스루패스가 다른 선택지를 압도함 — 남발될 위험');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 7 — 신체 방향과 선회 비용 (Section 18)');

test('등 뒤로 찌르는 패스는 정면 패스보다 효용이 낮다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(50, 34), { facing: 0 }); // +x를 봄

  // 정면(+x)과 등 뒤(-x)에 대칭으로 동료를 놓는다.
  // 전진 가치 차이를 없애기 위해 y축 방향으로 대칭 배치한다.
  passer.facingAngle = Math.PI / 2; // +y를 봄
  const inFront = place(engine.homeTeam, 6, new Vector2D(50, 52));
  const behind = place(engine.homeTeam, 7, new Vector2D(50, 16));

  const options = planner.generateOptions(engine, passer);
  const front = options.find((o) => o.receiver === inFront && o.targetKind === 'FEET');
  const back = options.find((o) => o.receiver === behind && o.targetKind === 'FEET');

  assert(front && back, '비교할 후보가 없음');
  assert(front.utility > back.utility,
    `신체 방향이 반영되지 않음 (정면 ${front.utility.toFixed(2)}, 등 뒤 ${back.utility.toFixed(2)})`);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 7 — 전술 반응');

test('전진 성향이 높으면 전진 패스를 더 선호한다', () => {
  const utilityGap = (directness) => {
    const { engine, planner } = scenario();
    engine.homeTeam.tactics.passingDirectness = directness;
    const passer = place(engine.homeTeam, 5, new Vector2D(50, 34));
    const forward = place(engine.homeTeam, 9, new Vector2D(70, 34), { role: Role.ST });
    const back = place(engine.homeTeam, 2, new Vector2D(32, 34), { role: Role.CB });

    const options = planner.generateOptions(engine, passer);
    const f = options.find((o) => o.receiver === forward && o.targetKind === 'FEET');
    const b = options.find((o) => o.receiver === back && o.targetKind === 'FEET');
    return f.utility - b.utility;
  };
  assert(utilityGap(1.0) > utilityGap(0.0),
    '전진 성향이 패스 선택에 반영되지 않음');
});

test('리스크 감수가 낮으면 위험한 패스를 더 기피한다', () => {
  const riskPenalty = (buildUpRisk) => {
    const { engine, planner } = scenario();
    engine.homeTeam.tactics.buildUpRisk = buildUpRisk;
    const passer = place(engine.homeTeam, 5, new Vector2D(45, 34));
    const receiver = place(engine.homeTeam, 6, new Vector2D(68, 34));
    place(engine.awayTeam, 4, new Vector2D(58, 36));
    place(engine.awayTeam, 5, new Vector2D(62, 32));

    const options = planner.generateOptions(engine, passer)
      .filter((o) => o.receiver === receiver);
    if (options.length === 0) return null;
    return Math.max(...options.map((o) => o.utility));
  };
  const cautious = riskPenalty(0.0);
  const bold = riskPenalty(1.0);
  if (cautious !== null && bold !== null) {
    assert(bold > cautious, '리스크 감수 성향이 반영되지 않음');
  }
});

test('백패스는 기본 감점을 받아 남발되지 않는다', () => {
  const { engine, planner } = scenario();
  const passer = place(engine.homeTeam, 5, new Vector2D(50, 34));
  // 전방과 후방에 동등하게 열린 동료를 놓는다
  const forward = place(engine.homeTeam, 6, new Vector2D(64, 34));
  const back = place(engine.homeTeam, 2, new Vector2D(36, 34), { role: Role.CB });

  const best = planner.plan(engine, passer);
  assert(best.receiver === forward,
    `열린 전진 패스가 있는데 백패스를 선택함 (${best.type})`);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 7 — 결정론');

test('같은 상황은 같은 패스를 만든다', () => {
  const run = () => {
    const { engine, planner } = scenario({ seed: 4321 });
    const passer = place(engine.homeTeam, 5, new Vector2D(48, 30));
    place(engine.homeTeam, 6, new Vector2D(62, 22));
    place(engine.homeTeam, 7, new Vector2D(66, 46));
    place(engine.homeTeam, 9, new Vector2D(78, 34), { role: Role.ST, velocity: new Vector2D(4, 1) });
    place(engine.awayTeam, 3, new Vector2D(58, 30));
    place(engine.awayTeam, 4, new Vector2D(70, 38));

    const best = planner.plan(engine, passer);
    return `${best.receiver.id}|${best.type}|${best.utility.toFixed(9)}|${best.solution.speed.toFixed(9)}`;
  };
  assertEqual(run(), run(), '같은 상황에서 다른 패스를 선택함');
});

test('패스 계획에 난수가 개입하지 않는다', () => {
  // 시드가 달라도 같은 상황이면 같은 결정이 나와야 한다.
  // (패스 실행 시의 오차는 난수지만, 선택 자체는 결정론적이어야 한다)
  const run = (seed) => {
    const { engine, planner } = scenario({ seed });
    const passer = place(engine.homeTeam, 5, new Vector2D(50, 34));
    place(engine.homeTeam, 6, new Vector2D(66, 28));
    place(engine.homeTeam, 9, new Vector2D(74, 38), { role: Role.ST });
    const best = planner.plan(engine, passer);
    return `${best.receiver.id}|${best.type}`;
  };
  assertEqual(run(1), run(999999), '시드가 패스 선택을 바꿈');
});
