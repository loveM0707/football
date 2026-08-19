import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { MatchEngine } from '../core/MatchEngine.js';
import { Phase } from '../core/MatchState.js';
import { Player, Action } from '../entities/Player.js';
import { Team, PossessionPhase } from '../entities/Team.js';
import { Role } from '../tactics/RoleModel.js';
import { BallFlight } from '../entities/Ball.js';
import { PossessionModel, PossessionState } from '../sim/PossessionModel.js';
import { TacticalEngine } from '../tactics/TacticalEngine.js';
import { DecisionEngine } from '../ai/DecisionEngine.js';
import { ActionSystem } from '../sim/ActionSystem.js';
import { MovementEngine } from '../sim/MovementEngine.js';
import { BallPhysics } from '../ball/BallPhysics.js';
import { RulesEngine } from '../rules/RulesEngine.js';
import { RestartEngine } from '../rules/RestartEngine.js';
import { MatchStatistics } from '../stats/MatchStatistics.js';

/**
 * 시나리오 실행기 (Section 33).
 *
 * 20개의 정해진 상황을 결정론적으로 재현해, 엔진의 각 하위 시스템이
 * 기대대로 동작하는지 확인한다. 같은 시드는 항상 같은 결과를 낸다.
 *
 * 각 시나리오는 완전한 파이프라인(규칙·재개 포함)을 갖춘 엔진 위에서
 * 특정 배치를 만들고, 정해진 스텝만큼 실행한 뒤 사건 로그와
 * 최종 스냅샷을 리포트로 돌려준다.
 */

const DT = 1 / 60;

/** 표준 11명 팀 생성 */
function makeTeam(side, formation, attrs = {}) {
  const players = [];
  for (let i = 0; i < 11; i++) {
    players.push(new Player({ id: `${side}${i}`, name: `${side}${i}`, number: i + 1, attributes: attrs }));
  }
  return new Team({
    name: side === 'home' ? '홈팀' : '원정팀',
    side, color: side === 'home' ? '#3b6fd6' : '#d6483b',
    formationName: formation, players,
  });
}

/** 완전한 파이프라인을 갖춘 엔진을 만든다 */
export function makeScenarioEngine({
  seed = 1,
  homeFormation = '4-4-2',
  awayFormation = '4-3-3',
  homeAttrs = {},
  awayAttrs = {},
} = {}) {
  const engine = new MatchEngine({
    homeTeam: makeTeam('home', homeFormation, homeAttrs),
    awayTeam: makeTeam('away', awayFormation, awayAttrs),
    seed,
  });
  const restarts = new RestartEngine(DT);
  const rules = new RulesEngine(restarts).attach(engine);
  const statistics = new MatchStatistics().attach(engine);
  engine.install({
    possession: new PossessionModel(),
    tactical: new TacticalEngine(),
    decisions: new DecisionEngine(DT),
    actions: new ActionSystem(DT),
    movement: new MovementEngine(),
    physics: new BallPhysics(DT),
    rules, restarts, statistics,
  });
  return engine;
}

/** 팀을 대형대로 배치하고 볼을 중앙에 둔다 */
function lineUp(engine, ballPos = Pitch.center()) {
  engine.setPhase(Phase.IN_PLAY);
  engine.ball.placeAt(ballPos);
  for (const team of engine.teams) {
    engine.tactical.update(engine, team, DT);
    for (const player of team.players) {
      player.position = player.anchor.clone();
      player.velocity = Vector2D.zero();
    }
  }
}

/** 선수를 지정 위치에 놓는다 */
function place(team, index, x, y, opts = {}) {
  const p = team.players[index];
  p.position = new Vector2D(x, y);
  if (opts.role) p.role = opts.role;
  if (opts.velocity) p.velocity = opts.velocity.clone();
  if (opts.facing !== undefined) p.facingAngle = opts.facing;
  return p;
}

/** 캐리어로 지정한다 */
function giveBall(engine, player, position, opts = {}) {
  player.position = position.clone();
  if (opts.role) player.role = opts.role;
  engine.ball.placeAt(position.add(new Vector2D(0.4, 0)));
  engine.ball.carrier = player;
  player.hasBall = true;
  return player;
}

/**
 * 이벤트 로그 구독을 시작한다.
 *
 * ⚠ 반드시 setup()보다 먼저 호출해야 한다. 일부 시나리오는 setup() 안에서
 *   규칙 판정을 직접 호출해(예: 오프사이드 시나리오) 동기적으로 이벤트를
 *   발생시키므로, 구독이 늦으면 그 사건을 로그가 놓친다.
 */
function startLogging(engine, eventNames) {
  const log = [];
  for (const name of eventNames) {
    engine.eventBus.on(name, (payload) =>
      log.push({ event: name, time: engine.time, payload: summarize(payload) })
    );
  }
  return log;
}

/** n스텝 실행한다 */
function run(engine, steps) {
  for (let i = 0; i < steps; i++) engine.step(DT);
}

/** 이벤트 페이로드에서 순환 참조(선수↔팀)를 제거하고 식별자만 남긴다 */
function summarize(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (value && typeof value === 'object') {
      if (value.id !== undefined && value.role !== undefined) { out[key] = `Player(${value.id})`; continue; }
      if (value.side !== undefined && value.players !== undefined) { out[key] = `Team(${value.side})`; continue; }
      if (value instanceof Vector2D) { out[key] = { x: Number(value.x.toFixed(2)), y: Number(value.y.toFixed(2)) }; continue; }
      if (typeof value.x === 'number' && typeof value.y === 'number') { out[key] = { x: Number(value.x.toFixed(2)), y: Number(value.y.toFixed(2)) }; continue; }
    }
    out[key] = value;
  }
  return out;
}

const ALL_EVENTS = [
  'pass', 'shot', 'goal', 'tackle', 'tackleFailed', 'foulCommitted', 'foul',
  'firstTouch', 'turnover', 'restart', 'offside', 'save', 'gkClaim',
  'advantage', 'dribbleTouch',
];

// ════════════════════════════════════════════════════════════
// 20개 시나리오 정의
// ════════════════════════════════════════════════════════════

export const SCENARIOS = [
  {
    id: 1,
    name: '중앙 빌드업',
    seconds: 15,
    setup(engine) {
      lineUp(engine, new Vector2D(30, 34));
      giveBall(engine, engine.homeTeam.goalkeeper, new Vector2D(8, 34));
    },
  },
  {
    id: 2,
    name: '측면 빌드업',
    seconds: 15,
    setup(engine) {
      lineUp(engine, new Vector2D(30, 8));
      const fb = engine.homeTeam.players.find((p) => p.role === Role.FB && p.slot.channel < 0);
      giveBall(engine, fb, new Vector2D(20, 6));
    },
  },
  {
    id: 3,
    name: '미드필드 드리블 대 수비 블록',
    seconds: 10,
    setup(engine) {
      lineUp(engine, new Vector2D(52, 34));
      engine.awayTeam.tactics.defensiveLineHeight = 0.1;
      engine.awayTeam.tactics.compactness = 0.9;
      giveBall(engine, engine.homeTeam.players[6], new Vector2D(45, 34));
    },
  },
  {
    id: 4,
    name: '1대1 드리블',
    seconds: 8,
    setup(engine) {
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      const attacker = giveBall(engine, engine.homeTeam.players[9], new Vector2D(70, 34));
      attacker.attributes.dribbling = 80;
      place(engine.awayTeam, 3, 78, 34, { facing: Math.PI });
    },
  },
  {
    id: 5,
    name: '20m 일반 패스',
    seconds: 5,
    setup(engine) {
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      giveBall(engine, engine.homeTeam.players[5], new Vector2D(40, 34));
      place(engine.homeTeam, 6, 60, 34);
    },
  },
  {
    id: 6,
    name: '30m 롱패스',
    seconds: 6,
    setup(engine) {
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      giveBall(engine, engine.homeTeam.players[5], new Vector2D(30, 34));
      place(engine.homeTeam, 9, 60, 34, { role: Role.ST });
    },
  },
  {
    id: 7,
    name: '40m 롱패스',
    seconds: 6,
    setup(engine) {
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      giveBall(engine, engine.homeTeam.players[2], new Vector2D(20, 20));
      place(engine.homeTeam, 9, 60, 48, { role: Role.ST });
    },
  },
  {
    id: 8,
    name: '수비 라인 뒤 스루패스',
    seconds: 6,
    setup(engine) {
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      giveBall(engine, engine.homeTeam.players[7], new Vector2D(60, 34));
      place(engine.homeTeam, 9, 68, 30, { role: Role.ST, velocity: new Vector2D(5, 0) });
      place(engine.awayTeam, 2, 75, 30);
      place(engine.awayTeam, 3, 75, 38);
      engine.awayTeam.goalkeeper.position = new Vector2D(100, 34);
    },
  },
  {
    id: 9,
    name: '압박받는 수신자',
    seconds: 6,
    setup(engine) {
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      giveBall(engine, engine.homeTeam.players[5], new Vector2D(45, 34));
      place(engine.homeTeam, 6, 62, 34);
      place(engine.awayTeam, 4, 64, 35);
      place(engine.awayTeam, 5, 60, 33);
    },
  },
  {
    id: 10,
    name: '턴오버와 역습',
    seconds: 8,
    setup(engine) {
      lineUp(engine, new Vector2D(80, 34));
      const winner = giveBall(engine, engine.homeTeam.players[6], new Vector2D(80, 34));
      engine.homeTeam.setPhase(PossessionPhase.TRANSITION_ATTACK);
      engine.awayTeam.setPhase(PossessionPhase.TRANSITION_DEFENCE);
    },
  },
  {
    id: 11,
    name: '오프사이드 위치이지만 관여하지 않음 (Section 4 원칙)',
    seconds: 5,
    setup(engine) {
      // 오프사이드 "위치"에 있는 것만으로는 반칙이 아니다.
      // 여기서는 명백한 오프사이드 위치의 선수가 있어도, 골키퍼가 볼을
      // 먼저 처리해 그 선수가 실제로 관여하지 못하면 휘슬이 불리지
      // 않아야 한다 — Section 4가 명시적으로 요구하는 원칙이다.
      // (실제로 반칙이 성립하는 경로는 시나리오 16에서 확인한다)
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      const passer = giveBall(engine, engine.homeTeam.players[5], new Vector2D(55, 34));
      place(engine.homeTeam, 9, 75, 34, { role: Role.ST, velocity: new Vector2D(5, 0) });
      place(engine.awayTeam, 2, 68, 30);
      place(engine.awayTeam, 3, 68, 38);
      engine.awayTeam.goalkeeper.position = new Vector2D(100, 34);
    },
  },
  {
    id: 12,
    name: '스로인',
    seconds: 6,
    setup(engine) {
      lineUp(engine);
      const toucher = engine.awayTeam.players[6];
      engine.ball.placeAt(new Vector2D(50, -0.5));
      engine.ball.velocity = new Vector2D(0, -3);
      engine.ball.registerTouch(toucher, engine.time);
    },
  },
  {
    id: 13,
    name: '골킥',
    seconds: 8,
    setup(engine) {
      lineUp(engine);
      const toucher = engine.awayTeam.players[9];
      engine.ball.placeAt(new Vector2D(-0.5, 30));
      engine.ball.velocity = new Vector2D(-4, 0);
      engine.ball.registerTouch(toucher, engine.time);
    },
  },
  {
    id: 14,
    name: '코너킥',
    seconds: 8,
    setup(engine) {
      lineUp(engine);
      const defender = engine.homeTeam.players[2];
      engine.ball.placeAt(new Vector2D(-0.5, 20));
      engine.ball.velocity = new Vector2D(-3, 0);
      engine.ball.registerTouch(defender, engine.time);
    },
  },
  {
    id: 15,
    name: '직접 프리킥',
    seconds: 6,
    setup(engine) {
      lineUp(engine);
      const offender = engine.awayTeam.players[4];
      const victim = engine.homeTeam.players[9];
      engine.rules._onFoul(engine, {
        offender, victim, position: new Vector2D(55, 34), team: offender.team,
      });
      engine.possession.team = null;
    },
  },
  {
    id: 16,
    name: '간접 프리킥 (오프사이드)',
    seconds: 6,
    setup(engine) {
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      const passer = giveBall(engine, engine.homeTeam.players[5], new Vector2D(60, 34));
      const mate = place(engine.homeTeam, 9, 82, 34, { role: Role.ST });
      place(engine.awayTeam, 2, 70, 34);
      engine.awayTeam.goalkeeper.position = new Vector2D(100, 34);
      engine.ball.flight = BallFlight.PASS;
      engine.rules._onBallPlayed(engine, passer);
      engine.rules._onTouch(engine, mate);
    },
  },
  {
    id: 17,
    name: '페널티킥',
    seconds: 6,
    setup(engine) {
      lineUp(engine);
      const offender = engine.awayTeam.players[3];
      const victim = engine.homeTeam.players[9];
      const box = Pitch.penaltyBoxRect('right');
      engine.rules._onFoul(engine, {
        offender, victim, position: new Vector2D(box.x + 5, 34), team: offender.team,
      });
      engine.possession.team = null;
    },
  },
  {
    id: 18,
    name: '페널티 지역 혼전',
    seconds: 6,
    setup(engine) {
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      engine.ball.placeAt(new Vector2D(98, 34));
      engine.ball.velocity = new Vector2D(-2, 1);
      place(engine.homeTeam, 9, 96, 32, { role: Role.ST });
      place(engine.homeTeam, 6, 97, 37);
      place(engine.awayTeam, 2, 98, 34);
      place(engine.awayTeam, 3, 96, 36);
      engine.awayTeam.goalkeeper.position = new Vector2D(103, 34);
    },
  },
  {
    id: 19,
    name: '크로스와 헤더',
    seconds: 6,
    setup(engine) {
      engine.setPhase(Phase.IN_PLAY);
      engine.allPlayers.forEach((p, i) => { p.position = new Vector2D(-40 - i * 2, -40); });
      const winger = giveBall(engine, engine.homeTeam.players[8], new Vector2D(95, 6), { role: Role.WINGER });
      place(engine.homeTeam, 9, 96, 32, { role: Role.ST });
      engine.awayTeam.goalkeeper.position = new Vector2D(103, 34);
      place(engine.awayTeam, 2, 98, 33);
    },
  },
  {
    id: 20,
    name: '골키퍼 배급',
    seconds: 6,
    setup(engine) {
      lineUp(engine, new Vector2D(10, 34));
      giveBall(engine, engine.homeTeam.goalkeeper, new Vector2D(6, 34));
    },
  },
];

/**
 * 시나리오 하나를 실행한다.
 * @param {number} id 1~20
 * @param {number} [seed]
 * @returns {{id:number, name:string, seed:number, steps:number, log:Array, finalState:object}}
 */
export function runScenario(id, seed = 12345) {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`알 수 없는 시나리오 id: ${id}`);

  const engine = makeScenarioEngine({ seed });
  const log = startLogging(engine, ALL_EVENTS);
  scenario.setup(engine);
  run(engine, Math.round(scenario.seconds * 60));

  return {
    id: scenario.id,
    name: scenario.name,
    seed,
    steps: engine.stepCount,
    log,
    finalHash: engine.hash(),
    score: { ...engine.state.score },
  };
}

/** 20개 시나리오를 모두 실행한다 */
export function runAllScenarios(seed = 12345) {
  return SCENARIOS.map((s) => runScenario(s.id, seed));
}
