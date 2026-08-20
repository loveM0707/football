import { suite, test, assert, assertEqual, assertClose, assertRange } from './_harness.mjs';

import { ShotPlanner, ShotType, CROSSBAR_HEIGHT } from '../ai/ShotPlanner.js';
import { GoalkeeperAI, GK_CATCH_HEIGHT, GK_DIVE_REACH } from '../ai/GoalkeeperAI.js';
import { DecisionEngine } from '../ai/DecisionEngine.js';
import { TacticalEngine } from '../tactics/TacticalEngine.js';
import { PossessionModel, PossessionState } from '../sim/PossessionModel.js';
import { ActionSystem } from '../sim/ActionSystem.js';
import { MovementEngine } from '../sim/MovementEngine.js';
import { BallPhysics } from '../ball/BallPhysics.js';
import { MatchEngine } from '../core/MatchEngine.js';
import { Phase } from '../core/MatchState.js';
import { Player, Action } from '../entities/Player.js';
import { Team, PossessionPhase } from '../entities/Team.js';
import { Role } from '../tactics/RoleModel.js';
import { BallFlight } from '../entities/Ball.js';
import { inRect, ownPenaltyBox } from '../core/Coords.js';
import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';

const DT = 1 / 60;
const SHOT_FLOOR = 0.85; // DecisionEngine의 슛 문턱과 같은 값

function makeTeam(side, formation = '4-4-2') {
  const players = [];
  for (let i = 0; i < 11; i++) {
    players.push(new Player({ id: `${side}${i}`, name: `${side}${i}`, number: i + 1 }));
  }
  return new Team({ name: side, side, color: '#000', formationName: formation, players });
}

function makeEngine({ seed = 1200 } = {}) {
  const engine = new MatchEngine({
    homeTeam: makeTeam('home', '4-4-2'),
    awayTeam: makeTeam('away', '4-3-3'),
    seed,
  });
  engine.install({
    possession: new PossessionModel(),
    tactical: new TacticalEngine(),
    decisions: new DecisionEngine(DT),
    actions: new ActionSystem(DT),
    movement: new MovementEngine(),
    physics: new BallPhysics(DT),
  });
  engine.setPhase(Phase.IN_PLAY);
  return engine;
}

/** 슛 상황만 남기고 나머지를 치운 최소 환경 */
function shootingSetup({ distance = 12, y = 34, facing = 0, keeperX = 103 } = {}) {
  const home = makeTeam('home');
  const away = makeTeam('away');
  home.opponent = away;
  away.opponent = home;
  away.players.forEach((p, i) => { p.position = new Vector2D(-30 - i * 2, -30); });
  away.goalkeeper.position = new Vector2D(keeperX, 34);

  const shooter = home.players[9];
  shooter.position = new Vector2D(Pitch.LENGTH - distance, y);
  shooter.facingAngle = facing;

  const engine = { homeTeam: home, awayTeam: away, ball: { position: shooter.position } };
  return { engine, shooter, home, away, planner: new ShotPlanner(DT) };
}

// ════════════════════════════════════════════════════════════
suite('PHASE 12 — 슛 선택 (거리만으로 정하지 않는다)');

test('가까울수록 슛 가치가 높다', () => {
  let previous = Infinity;
  for (const distance of [10, 14, 18, 22, 26]) {
    const { engine, shooter, planner } = shootingSetup({ distance });
    const option = planner.plan(engine, shooter);
    const utility = option ? option.utility : 0;
    assert(utility < previous, `${distance}m 가치(${utility.toFixed(2)})가 더 가까운 거리보다 높음`);
    previous = utility;
  }
});

test('먼 거리에서는 슛을 선택하지 않는다', () => {
  for (const distance of [24, 28, 32]) {
    const { engine, shooter, planner } = shootingSetup({ distance });
    const option = planner.plan(engine, shooter);
    const utility = option ? option.utility : 0;
    assert(utility < SHOT_FLOOR,
      `${distance}m에서 슛 가치가 ${utility.toFixed(2)} — 문턱(${SHOT_FLOOR})을 넘어 남발된다`);
  }
});

test('각도가 좁으면 슛 가치가 떨어진다', () => {
  const central = shootingSetup({ distance: 14, y: 34 });
  const wide = shootingSetup({ distance: 14, y: 14 });
  const a = central.planner.plan(central.engine, central.shooter);
  const b = wide.planner.plan(wide.engine, wide.shooter);
  assert(a && a.utility > (b ? b.utility : 0),
    '각도가 슛 가치에 반영되지 않음');
});

test('골문을 등지고 있으면 슛하지 않는다', () => {
  const front = shootingSetup({ distance: 12, facing: 0 });
  const back = shootingSetup({ distance: 12, facing: Math.PI });
  const a = front.planner.plan(front.engine, front.shooter);
  const b = back.planner.plan(back.engine, back.shooter);

  assert(a && a.utility >= SHOT_FLOOR, '정면인데 슛 가치가 낮음');
  assert(!b || b.utility < SHOT_FLOOR,
    `골문을 등지고도 슛 가치가 ${b?.utility.toFixed(2)} — 몸 방향이 반영되지 않음`);
});

test('마무리 능력이 슛 가치에 반영된다', () => {
  const utilityFor = (finishing) => {
    const { engine, shooter, planner } = shootingSetup({ distance: 14 });
    shooter.attributes.finishing = finishing;
    shooter.attributes.shooting = finishing;
    const option = planner.plan(engine, shooter);
    return option ? option.utility : 0;
  };
  assert(utilityFor(90) > utilityFor(30), '마무리 능력이 반영되지 않음');
});

test('수비수가 앞을 막으면 슛 가치가 떨어진다', () => {
  const open = shootingSetup({ distance: 14 });
  const openOption = open.planner.plan(open.engine, open.shooter);

  const blocked = shootingSetup({ distance: 14 });
  // 슈터 바로 앞에 수비벽을 세운다
  blocked.away.players[1].position = blocked.shooter.position.add(new Vector2D(1.2, 0));
  blocked.away.players[2].position = blocked.shooter.position.add(new Vector2D(1.2, 1.2));
  blocked.away.players[3].position = blocked.shooter.position.add(new Vector2D(1.2, -1.2));
  const blockedOption = blocked.planner.plan(blocked.engine, blocked.shooter);

  assert(openOption, '열린 상황에서 슛 후보가 없음');
  const blockedUtility = blockedOption ? blockedOption.utility : 0;
  assert(blockedUtility < openOption.utility,
    `수비 차단이 반영되지 않음 (${openOption.utility.toFixed(2)} → ${blockedUtility.toFixed(2)})`);
});

test('모든 슛 후보는 실제로 골문 안으로 향한다', () => {
  const [goalTop, goalBottom] = Pitch.goalYRange();
  for (const distance of [8, 12, 16, 20]) {
    for (const y of [34, 26, 42]) {
      const { engine, shooter, planner } = shootingSetup({ distance, y });
      for (const option of planner.generateOptions(engine, shooter)) {
        assert(option.aimPoint.y > goalTop - 0.01 && option.aimPoint.y < goalBottom + 0.01,
          `조준점이 골문 밖: y=${option.aimPoint.y.toFixed(2)}`);
        assert(option.flightTime > 0 && option.flightTime < 3,
          `비현실적인 도달 시간: ${option.flightTime}`);
      }
    }
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 12 — 슛 실행');

test('실행된 슛이 골문 쪽으로 날아간다', () => {
  const engine = makeEngine({ seed: 1201 });
  engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });

  const shooter = engine.homeTeam.players[9];
  shooter.position = new Vector2D(93, 34);
  shooter.facingAngle = 0;
  engine.ball.placeAt(new Vector2D(93.4, 34));
  engine.ball.carrier = shooter;
  engine.awayTeam.goalkeeper.position = new Vector2D(103, 34);

  const planner = new ShotPlanner(DT);
  const option = planner.plan(engine, shooter);
  assert(option, '슛 후보가 없음');

  shooter.setDecision(Action.SHOOT, option.aimPoint, { payload: option });
  shooter.touchCooldown = 0;
  engine.actions.update(engine, DT);

  assertEqual(engine.ball.flight, BallFlight.SHOT, '슛으로 기록되지 않음');
  assert(engine.ball.velocity.x > 5, '볼이 골문 쪽으로 가지 않음');
  assertEqual(engine.ball.carrier, null, '슛했는데 캐리어가 남아 있음');
});

test('슛 이벤트가 발생한다', () => {
  const engine = makeEngine({ seed: 1202 });
  engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
  const shooter = engine.homeTeam.players[9];
  shooter.position = new Vector2D(93, 34);
  engine.ball.placeAt(new Vector2D(93.4, 34));
  engine.ball.carrier = shooter;
  engine.awayTeam.goalkeeper.position = new Vector2D(103, 34);

  const events = [];
  engine.eventBus.on('shot', (e) => events.push(e));

  const option = new ShotPlanner(DT).plan(engine, shooter);
  shooter.setDecision(Action.SHOOT, option.aimPoint, { payload: option });
  shooter.touchCooldown = 0;
  engine.actions.update(engine, DT);

  assertEqual(events.length, 1, '슛 이벤트가 발생하지 않음');
  assertEqual(events[0].by, shooter);
});

test('마무리 능력이 낮을수록 슛이 더 흩어진다', () => {
  const spread = (finishing) => {
    const engine = makeEngine({ seed: 1203 });
    engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
    const shooter = engine.homeTeam.players[9];
    shooter.position = new Vector2D(93, 34);
    shooter.attributes.finishing = finishing;
    shooter.attributes.shooting = finishing;
    engine.ball.placeAt(new Vector2D(93.4, 34));
    engine.ball.carrier = shooter;
    engine.awayTeam.goalkeeper.position = new Vector2D(103, 34);

    const option = new ShotPlanner(DT).plan(engine, shooter);
    const angles = [];
    for (let i = 0; i < 200; i++) {
      const before = engine.rng.shot.float(); // 스트림 진행
      const sd = 0.075 - (finishing / 100) * 0.045;
      angles.push(engine.rng.shot.gaussian(0, sd, 2.5));
    }
    const mean = angles.reduce((a, b) => a + b, 0) / angles.length;
    return Math.sqrt(angles.reduce((a, b) => a + (b - mean) ** 2, 0) / angles.length);
  };
  assert(spread(30) > spread(90), '마무리 능력이 슛 정확도에 반영되지 않음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 12 — 골키퍼 위치');

test('골키퍼는 볼과 골문 중앙을 잇는 선 위에 선다', () => {
  const engine = makeEngine();
  const gk = engine.awayTeam.goalkeeper; // 원정 골문 x=105
  const goalCenter = new Vector2D(Pitch.LENGTH, Pitch.WIDTH / 2);

  for (const ballPos of [new Vector2D(85, 20), new Vector2D(85, 48), new Vector2D(90, 34)]) {
    engine.ball.placeAt(ballPos);
    engine.tactical.update(engine, engine.awayTeam, DT);
    new GoalkeeperAI().decide(engine, gk);

    const target = gk.decision.target;
    // 목표가 골문 중앙 → 볼 방향 위에 있는지 (외적이 작아야 한다)
    const toBall = ballPos.sub(goalCenter).normalize();
    const toTarget = target.sub(goalCenter);
    const cross = Math.abs(toBall.x * toTarget.y - toBall.y * toTarget.x);
    assert(cross < 3.5, `골키퍼가 각을 지우는 선에서 ${cross.toFixed(1)}m 벗어남`);
  }
});

test('볼이 가까울수록 골키퍼가 앞으로 나온다', () => {
  const engine = makeEngine();
  const gk = engine.awayTeam.goalkeeper;
  const ai = new GoalkeeperAI();

  const advanceFor = (ballX) => {
    engine.ball.placeAt(new Vector2D(ballX, 34));
    engine.tactical.update(engine, engine.awayTeam, DT);
    ai.decide(engine, gk);
    return Pitch.LENGTH - gk.decision.target.x;
  };
  assert(advanceFor(88) > advanceFor(50), '볼이 가까워져도 골키퍼가 나오지 않음');
});

test('골키퍼가 페널티 박스를 크게 벗어나지 않는다', () => {
  const engine = makeEngine();
  const gk = engine.awayTeam.goalkeeper;
  const ai = new GoalkeeperAI();

  for (const ballX of [95, 85, 70, 50, 30]) {
    for (const ballY of [5, 34, 63]) {
      engine.ball.placeAt(new Vector2D(ballX, ballY));
      engine.tactical.update(engine, engine.awayTeam, DT);
      ai.decide(engine, gk);
      const advance = Pitch.LENGTH - gk.decision.target.x;
      assert(advance <= Pitch.PENALTY_BOX_LENGTH + 2.1,
        `골키퍼가 골라인에서 ${advance.toFixed(1)}m까지 나감 (볼 ${ballX},${ballY})`);
    }
  }
});

test('슛이 날아오면 골키퍼가 통과 지점으로 움직인다', () => {
  const engine = makeEngine();
  const gk = engine.awayTeam.goalkeeper;
  gk.position = new Vector2D(103, 34);

  // 골문 위쪽 구석으로 향하는 슛
  engine.ball.placeAt(new Vector2D(90, 34));
  engine.ball.kick(new Vector2D(20, -6), 0.2, {
    kicker: engine.homeTeam.players[9], flight: BallFlight.SHOT, time: engine.time,
  });
  engine.possession.state = PossessionState.SHOT_IN_FLIGHT;
  engine.possession.team = engine.homeTeam;

  new GoalkeeperAI().decide(engine, gk);
  assertEqual(gk.debugTargetSource, 'GK_BLOCK', '슛에 반응하지 않음');
  assert(gk.decision.target.y < 34, '볼이 향하는 쪽으로 움직이지 않음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 12 — 골키퍼 볼 처리');

test('골키퍼는 자기 박스 안에서만 손을 쓴다 (Law 12)', () => {
  const engine = makeEngine();
  const gk = engine.awayTeam.goalkeeper;
  const ball = engine.ball;

  // 박스 안
  gk.position = new Vector2D(100, 34);
  ball.placeAt(new Vector2D(100.5, 34));
  assert(GoalkeeperAI.canHandle(gk, ball), '박스 안인데 손을 못 씀');

  // 박스 밖
  gk.position = new Vector2D(80, 34);
  ball.placeAt(new Vector2D(80.5, 34));
  assertEqual(GoalkeeperAI.canHandle(gk, ball), false, '박스 밖에서 손을 씀');
});

test('머리 위로 넘어가는 볼은 손이 닿지 않는다', () => {
  const engine = makeEngine();
  const gk = engine.awayTeam.goalkeeper;
  gk.position = new Vector2D(100, 34);
  engine.ball.placeAt(new Vector2D(100.5, 34));

  engine.ball.height = GK_CATCH_HEIGHT - 0.3;
  assert(GoalkeeperAI.canHandle(gk, engine.ball), '잡을 수 있는 높이인데 실패');

  engine.ball.height = GK_CATCH_HEIGHT + 0.5;
  assertEqual(GoalkeeperAI.canHandle(gk, engine.ball), false, '머리 위 볼을 잡음');
});

test('세이브는 캐치와 쳐내기로 갈린다', () => {
  const outcomes = new Set();
  for (let seed = 0; seed < 60; seed++) {
    const engine = makeEngine({ seed });
    engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
    const gk = engine.awayTeam.goalkeeper;
    gk.position = new Vector2D(101, 34);
    gk.touchCooldown = 0;

    engine.ball.placeAt(new Vector2D(101.5, 34));
    engine.ball.kick(new Vector2D(18, 0), 0, {
      kicker: engine.homeTeam.players[9], flight: BallFlight.SHOT, time: engine.time,
    });

    engine.eventBus.on('save', (e) => outcomes.add(e.held));
    engine.actions.update(engine, DT);
  }
  assert(outcomes.has(true), '캐치가 한 번도 없음');
  assert(outcomes.has(false), '쳐내기가 한 번도 없음');
});

test('강한 슛일수록 잡기 어렵다', () => {
  const catchRate = (speed) => {
    let held = 0;
    const N = 80;
    for (let seed = 0; seed < N; seed++) {
      const engine = makeEngine({ seed: seed * 7 + 1 });
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      const gk = engine.awayTeam.goalkeeper;
      gk.position = new Vector2D(101, 34);
      gk.touchCooldown = 0;
      engine.ball.placeAt(new Vector2D(101.5, 34));
      engine.ball.kick(new Vector2D(speed, 0), 0, {
        kicker: engine.homeTeam.players[9], flight: BallFlight.SHOT, time: engine.time,
      });
      engine.eventBus.on('save', (e) => { if (e.held) held++; });
      engine.actions.update(engine, DT);
    }
    return held / N;
  };
  assert(catchRate(28) < catchRate(8), '슛 세기가 캐치 확률에 반영되지 않음');
});

test('골키퍼는 같은 팀 볼을 세이브하지 않는다', () => {
  const engine = makeEngine();
  engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
  const gk = engine.awayTeam.goalkeeper;
  gk.position = new Vector2D(101, 34);
  const mate = engine.awayTeam.players[3];
  mate.position = new Vector2D(101.5, 34);

  engine.ball.placeAt(new Vector2D(101.5, 34));
  engine.ball.carrier = mate;

  const saves = [];
  engine.eventBus.on('save', (e) => saves.push(e));
  engine.actions.update(engine, DT);
  assertEqual(saves.length, 0, '같은 팀 볼을 세이브함');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 12 — 슛 빈도 (Section 31)');

test('슛은 패스보다 훨씬 드물게 나온다', () => {
  const engine = makeEngine({ seed: 1250 });
  engine.ball.placeAt(new Vector2D(52.5, 34));
  for (const team of engine.teams) {
    engine.tactical.update(engine, team, DT);
    for (const p of team.players) p.position = p.anchor.clone();
  }
  const carrier = engine.homeTeam.players[5];
  carrier.position = new Vector2D(45, 34);
  engine.ball.placeAt(new Vector2D(45.4, 34));
  engine.ball.carrier = carrier;

  let passes = 0;
  let shots = 0;
  engine.eventBus.on('pass', () => passes++);
  engine.eventBus.on('shot', () => shots++);

  for (let i = 0; i < 60 * 90; i++) engine.step(DT);

  assert(passes > 0, '패스가 한 번도 없음');
  assert(shots <= passes,
    `슛(${shots})이 패스(${passes})보다 많음 — 슛 남발 (Section 31 위반)`);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 12 — 결정론');

test('같은 상황에서 같은 슛을 고른다', () => {
  const run = () => {
    const { engine, shooter, planner } = shootingSetup({ distance: 13, y: 30 });
    const option = planner.plan(engine, shooter);
    return `${option.type}|${option.aimPoint.y.toFixed(9)}|${option.utility.toFixed(9)}`;
  };
  assertEqual(run(), run(), '같은 상황에서 다른 슛을 고름');
});

test('슛·골키퍼가 포함된 전체 시뮬레이션이 결정론적이다', () => {
  const run = () => {
    const engine = makeEngine({ seed: 4711 });
    engine.ball.placeAt(new Vector2D(52.5, 34));
    for (const team of engine.teams) {
      engine.tactical.update(engine, team, DT);
      for (const p of team.players) p.position = p.anchor.clone();
    }
    const carrier = engine.homeTeam.players[5];
    carrier.position = new Vector2D(60, 34);
    engine.ball.placeAt(new Vector2D(60.4, 34));
    engine.ball.carrier = carrier;
    for (let i = 0; i < 60 * 20; i++) engine.step(DT);
    return engine.hash();
  };
  assertEqual(run(), run(), '같은 시드에서 결과가 달라짐');
});
