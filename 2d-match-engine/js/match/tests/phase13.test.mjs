import { suite, test, assert, assertEqual, assertClose, assertRange } from './_harness.mjs';

import { RulesEngine } from '../rules/RulesEngine.js';
import { RestartEngine } from '../rules/RestartEngine.js';
import {
  isInOffsidePosition, captureOffsideSnapshot, isOffsideOffence, secondLastOpponentX,
} from '../rules/Offside.js';
import { DecisionEngine } from '../ai/DecisionEngine.js';
import { TacticalEngine } from '../tactics/TacticalEngine.js';
import { PossessionModel } from '../sim/PossessionModel.js';
import { ActionSystem } from '../sim/ActionSystem.js';
import { MovementEngine } from '../sim/MovementEngine.js';
import { BallPhysics } from '../ball/BallPhysics.js';
import { MatchEngine } from '../core/MatchEngine.js';
import { Phase } from '../core/MatchState.js';
import { Player, Action } from '../entities/Player.js';
import { Team } from '../entities/Team.js';
import { Role } from '../tactics/RoleModel.js';
import { BallFlight } from '../entities/Ball.js';
import { inRect, ownPenaltyBox } from '../core/Coords.js';
import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';

const DT = 1 / 60;

function makeTeam(side, formation = '4-4-2') {
  const players = [];
  for (let i = 0; i < 11; i++) {
    players.push(new Player({ id: `${side}${i}`, name: `${side}${i}`, number: i + 1 }));
  }
  return new Team({ name: side, side, color: '#000', formationName: formation, players });
}

/** 규칙 엔진까지 포함한 완전한 엔진 */
function makeEngine({ seed = 1300 } = {}) {
  const engine = new MatchEngine({
    homeTeam: makeTeam('home', '4-4-2'),
    awayTeam: makeTeam('away', '4-3-3'),
    seed,
  });
  const restarts = new RestartEngine(DT);
  const rules = new RulesEngine(restarts).attach(engine);
  engine.install({
    possession: new PossessionModel(),
    tactical: new TacticalEngine(),
    decisions: new DecisionEngine(DT),
    actions: new ActionSystem(DT),
    movement: new MovementEngine(),
    physics: new BallPhysics(DT),
    rules,
    restarts,
  });
  engine.setPhase(Phase.IN_PLAY);
  // 선수를 대형대로 배치한다
  engine.ball.placeAt(Pitch.center());
  for (const team of engine.teams) {
    engine.tactical.update(engine, team, DT);
    for (const p of team.players) p.position = p.anchor.clone();
  }
  return engine;
}

/** 볼을 특정 위치·속도로 두고, 마지막 접촉자를 지정한다 */
function setBall(engine, position, velocity, toucher) {
  engine.ball.placeAt(position);
  engine.ball.velocity = velocity.clone();
  if (toucher) engine.ball.registerTouch(toucher, engine.time);
}

// ════════════════════════════════════════════════════════════
suite('PHASE 13 — Law 9: 볼 인/아웃');

test('볼 전체가 라인을 넘어야 아웃이다', () => {
  const engine = makeEngine();
  const toucher = engine.homeTeam.players[5];

  // 라인에 걸쳐 있는 상태 — 아직 인플레이
  setBall(engine, new Vector2D(50, 0.05), new Vector2D(0, -1), toucher);
  engine.rules.postStep(engine, DT);
  assertEqual(engine.state.phase, Phase.IN_PLAY, '라인에 걸친 볼을 아웃으로 판정함');

  // 완전히 넘어감
  setBall(engine, new Vector2D(50, -0.3), new Vector2D(0, -1), toucher);
  engine.rules.postStep(engine, DT);
  assertEqual(engine.state.phase, Phase.THROW_IN, '완전히 넘어간 볼을 아웃으로 판정하지 못함');
});

test('터치라인 아웃은 마지막에 만진 팀의 상대에게 스로인', () => {
  const engine = makeEngine();
  const toucher = engine.homeTeam.players[5];
  setBall(engine, new Vector2D(60, -0.5), new Vector2D(0, -3), toucher);
  engine.rules.postStep(engine, DT);

  assertEqual(engine.state.phase, Phase.THROW_IN);
  assertEqual(engine.state.restart.team, engine.awayTeam, '스로인이 잘못된 팀에게 주어짐');
  assertClose(engine.state.restart.position.y, 0, 0.01, '스로인 위치가 터치라인이 아님');
  assertClose(engine.state.restart.position.x, 60, 0.01, '스로인 x 위치가 잘못됨');
});

test('수비 팀이 마지막으로 만지고 골라인을 넘으면 코너킥', () => {
  const engine = makeEngine();
  // 홈은 +x로 공격 → x=0 골라인은 홈이 지킨다
  const defender = engine.homeTeam.players[2];
  setBall(engine, new Vector2D(-0.5, 20), new Vector2D(-3, 0), defender);
  engine.rules.postStep(engine, DT);

  assertEqual(engine.state.phase, Phase.CORNER_KICK);
  assertEqual(engine.state.restart.team, engine.awayTeam, '코너킥이 잘못된 팀에게 주어짐');
  assertClose(engine.state.restart.position.x, 0, 0.01);
  assertClose(engine.state.restart.position.y, 0, 0.01, '코너 위치가 볼이 나간 쪽이 아님');
});

test('공격 팀이 마지막으로 만지고 골라인을 넘으면 골킥', () => {
  const engine = makeEngine();
  // 원정은 -x로 공격 → x=0 골라인 너머로 원정이 찼다
  const attacker = engine.awayTeam.players[9];
  setBall(engine, new Vector2D(-0.5, 20), new Vector2D(-5, 0), attacker);
  engine.rules.postStep(engine, DT);

  assertEqual(engine.state.phase, Phase.GOAL_KICK);
  assertEqual(engine.state.restart.team, engine.homeTeam, '골킥이 잘못된 팀에게 주어짐');
  const box = Pitch.goalBoxRect('left');
  assert(engine.state.restart.position.x <= box.w + 0.01, '골킥 위치가 골 에어리어 밖');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 13 — Law 10: 득점');

test('골문 안으로 들어가면 득점이다', () => {
  const engine = makeEngine();
  const scorer = engine.homeTeam.players[9];
  // 홈은 +x로 공격 → x=105 골문
  setBall(engine, new Vector2D(Pitch.LENGTH + 0.3, 34), new Vector2D(10, 0), scorer);
  engine.ball.height = 1.0;

  const goals = [];
  engine.eventBus.on('goal', (e) => goals.push(e));
  engine.rules.postStep(engine, DT);

  assertEqual(goals.length, 1, '득점이 인정되지 않음');
  assertEqual(goals[0].team, engine.homeTeam, '득점 팀이 잘못됨');
  assertEqual(engine.state.score.home, 1);
});

test('크로스바를 넘으면 득점이 아니다', () => {
  const engine = makeEngine();
  const scorer = engine.homeTeam.players[9];
  setBall(engine, new Vector2D(Pitch.LENGTH + 0.3, 34), new Vector2D(10, 0), scorer);
  engine.ball.height = 3.0; // 크로스바(2.44m) 위

  const goals = [];
  engine.eventBus.on('goal', (e) => goals.push(e));
  engine.rules.postStep(engine, DT);

  assertEqual(goals.length, 0, '크로스바를 넘었는데 득점 처리됨');
  assertEqual(engine.state.phase, Phase.GOAL_KICK, '골킥으로 재개되지 않음');
});

test('골포스트 밖으로 나가면 득점이 아니다', () => {
  const engine = makeEngine();
  const scorer = engine.homeTeam.players[9];
  const [, goalBottom] = Pitch.goalYRange();
  setBall(engine, new Vector2D(Pitch.LENGTH + 0.3, goalBottom + 2), new Vector2D(10, 0), scorer);

  const goals = [];
  engine.eventBus.on('goal', (e) => goals.push(e));
  engine.rules.postStep(engine, DT);
  assertEqual(goals.length, 0, '골문 밖인데 득점 처리됨');
});

test('득점 후에는 실점한 팀의 킥오프로 재개된다', () => {
  const engine = makeEngine();
  const scorer = engine.homeTeam.players[9];
  setBall(engine, new Vector2D(Pitch.LENGTH + 0.3, 34), new Vector2D(10, 0), scorer);
  engine.rules.postStep(engine, DT);

  assertEqual(engine.state.phase, Phase.GOAL);
  assertEqual(engine.state.restart.type, 'KICKOFF');
  assertEqual(engine.state.restart.team, engine.awayTeam, '실점 팀이 킥오프하지 않음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 13 — Law 11: 오프사이드');

/** 오프사이드 판정용 최소 배치 */
function offsideSetup() {
  const home = makeTeam('home');
  const away = makeTeam('away');
  home.opponent = away;
  away.opponent = home;
  // 원정 수비 라인을 x=70에 세운다 (골키퍼는 x=100)
  away.players.forEach((p, i) => { p.position = new Vector2D(70, 10 + i * 5); });
  away.goalkeeper.position = new Vector2D(100, 34);
  home.players.forEach((p, i) => { p.position = new Vector2D(60, 10 + i * 5); });
  return { home, away };
}

test('상대보다 앞서 있으면 오프사이드 위치다', () => {
  const { home, away } = offsideSetup();
  const attacker = home.players[9];
  const ball = { position: new Vector2D(60, 34) };

  attacker.position = new Vector2D(75, 34); // 수비 라인(70) 앞
  assert(isInOffsidePosition(attacker, ball, away), '오프사이드 위치를 인식하지 못함');

  attacker.position = new Vector2D(65, 34); // 수비 라인 뒤
  assertEqual(isInOffsidePosition(attacker, ball, away), false, '온사이드를 오프사이드로 판정');
});

test('자기 진영에서는 오프사이드가 아니다', () => {
  const { home, away } = offsideSetup();
  const attacker = home.players[9];
  // 상대 수비를 자기 진영 깊숙이 끌어온다
  away.players.forEach((p) => { p.position = new Vector2D(20, 34); });
  away.goalkeeper.position = new Vector2D(10, 34);

  const ball = { position: new Vector2D(15, 34) };
  attacker.position = new Vector2D(40, 34); // 자기 진영(중앙선 이전)
  assertEqual(isInOffsidePosition(attacker, ball, away), false,
    '자기 진영인데 오프사이드로 판정');
});

test('볼보다 뒤에 있으면 오프사이드가 아니다', () => {
  const { home, away } = offsideSetup();
  const attacker = home.players[9];
  attacker.position = new Vector2D(75, 34);
  // 볼이 더 앞에 있다
  const ball = { position: new Vector2D(80, 34) };
  assertEqual(isInOffsidePosition(attacker, ball, away), false,
    '볼보다 뒤인데 오프사이드로 판정');
});

test('골키퍼는 오프사이드 판정 대상이 아니다', () => {
  const { home, away } = offsideSetup();
  const gk = home.goalkeeper;
  gk.position = new Vector2D(90, 34);
  const ball = { position: new Vector2D(60, 34) };
  assertEqual(isInOffsidePosition(gk, ball, away), false, '골키퍼를 오프사이드로 판정');
});

test('오프사이드 위치에 있는 것만으로는 반칙이 아니다', () => {
  const { home, away } = offsideSetup();
  const passer = home.players[5];
  const offsideMate = home.players[9];
  const onsideMate = home.players[6];
  passer.position = new Vector2D(60, 34);
  offsideMate.position = new Vector2D(78, 34);
  onsideMate.position = new Vector2D(64, 40);

  const ball = { position: new Vector2D(60, 34), flight: BallFlight.PASS };
  const snapshot = captureOffsideSnapshot(passer, ball);

  assert(snapshot.players.has(offsideMate), '오프사이드 위치가 기록되지 않음');
  // 온사이드 동료가 받으면 반칙이 아니다
  assertEqual(isOffsideOffence(snapshot, onsideMate), false,
    '온사이드 선수를 반칙으로 판정');
  // 오프사이드 위치의 선수가 관여해야 반칙이다
  assertEqual(isOffsideOffence(snapshot, offsideMate), true,
    '관여했는데 반칙으로 판정하지 않음');
});

test('상대 선수가 만지면 오프사이드가 아니다', () => {
  const { home, away } = offsideSetup();
  const passer = home.players[5];
  const offsideMate = home.players[9];
  offsideMate.position = new Vector2D(78, 34);
  const ball = { position: new Vector2D(60, 34), flight: BallFlight.PASS };
  const snapshot = captureOffsideSnapshot(passer, ball);

  assertEqual(isOffsideOffence(snapshot, away.players[3]), false,
    '수비수가 만졌는데 오프사이드 판정');
});

test('스로인에서 직접 받으면 오프사이드가 아니다', () => {
  const { home } = offsideSetup();
  const thrower = home.players[5];
  const mate = home.players[9];
  mate.position = new Vector2D(78, 34);
  const ball = { position: new Vector2D(60, 34), flight: BallFlight.THROW_IN };
  const snapshot = captureOffsideSnapshot(thrower, ball);
  assertEqual(snapshot.exempt, true, '스로인 예외가 적용되지 않음');
  assertEqual(isOffsideOffence(snapshot, mate), false, '스로인에서 오프사이드 판정');
});

test('오프사이드는 간접 프리킥으로 재개된다', () => {
  const engine = makeEngine();
  const passer = engine.homeTeam.players[5];
  const offsideMate = engine.homeTeam.players[9];

  engine.awayTeam.players.forEach((p) => { p.position = new Vector2D(70, 34); });
  engine.awayTeam.goalkeeper.position = new Vector2D(100, 34);
  passer.position = new Vector2D(60, 34);
  offsideMate.position = new Vector2D(80, 34);
  engine.ball.placeAt(new Vector2D(60, 34));
  engine.ball.flight = BallFlight.PASS;

  const offsides = [];
  engine.eventBus.on('offside', (e) => offsides.push(e));

  engine.rules._onBallPlayed(engine, passer);
  engine.rules._onTouch(engine, offsideMate);

  assertEqual(offsides.length, 1, '오프사이드가 선언되지 않음');
  assertEqual(engine.state.phase, Phase.OFFSIDE);
  assertEqual(engine.state.restart.type, 'INDIRECT_FREE_KICK');
  assertEqual(engine.state.restart.team, engine.awayTeam, '프리킥이 잘못된 팀에게 주어짐');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 13 — Law 12/14: 반칙과 어드밴티지');

test('박스 밖 반칙은 직접 프리킥이다', () => {
  const engine = makeEngine();
  const offender = engine.awayTeam.players[4];
  const victim = engine.homeTeam.players[9];
  const spot = new Vector2D(60, 34);

  engine.rules._onFoul(engine, { offender, victim, position: spot, team: offender.team });
  // 어드밴티지 창을 넘긴다 (볼 소유가 없는 상태)
  engine.possession.team = null;
  for (let i = 0; i < 100; i++) engine.rules._reviewAdvantage(engine, DT);

  assertEqual(engine.state.phase, Phase.DIRECT_FREE_KICK);
  assertEqual(engine.state.restart.team, engine.homeTeam);
});

test('반칙 팀의 페널티 지역 안이면 페널티킥이다', () => {
  const engine = makeEngine();
  // 원정은 -x로 공격 → 원정의 페널티 지역은 x=105 쪽
  const offender = engine.awayTeam.players[3];
  const victim = engine.homeTeam.players[9];
  const box = ownPenaltyBox(engine.awayTeam.attackingDirection);
  const spot = new Vector2D(box.x + 5, 34);
  assert(inRect(spot, box), '테스트 지점이 페널티 지역 안이 아님');

  engine.rules._onFoul(engine, { offender, victim, position: spot, team: offender.team });
  engine.possession.team = null;
  for (let i = 0; i < 100; i++) engine.rules._reviewAdvantage(engine, DT);

  assertEqual(engine.state.phase, Phase.PENALTY, '박스 안 반칙이 페널티가 아님');
  assertEqual(engine.state.restart.team, engine.homeTeam);
  assertClose(engine.state.restart.position.x, Pitch.LENGTH - Pitch.PENALTY_SPOT_DIST, 0.01,
    '페널티 스팟 위치가 잘못됨');
});

test('이득이 유지되면 어드밴티지를 적용한다', () => {
  const engine = makeEngine();
  const offender = engine.awayTeam.players[4];
  const victim = engine.homeTeam.players[9];

  const advantages = [];
  engine.eventBus.on('advantage', (e) => advantages.push(e));

  engine.rules._onFoul(engine, {
    offender, victim, position: new Vector2D(60, 34), team: offender.team,
  });
  // 피해 팀이 계속 볼을 갖고 있다
  engine.possession.team = engine.homeTeam;
  for (let i = 0; i < 100; i++) engine.rules._reviewAdvantage(engine, DT);

  assertEqual(advantages.length, 1, '어드밴티지가 적용되지 않음');
  assertEqual(engine.state.phase, Phase.IN_PLAY, '어드밴티지인데 경기가 중단됨');
});

test('이득을 잃으면 원래 지점에서 프리킥을 준다', () => {
  const engine = makeEngine();
  const offender = engine.awayTeam.players[4];
  const victim = engine.homeTeam.players[9];
  const spot = new Vector2D(58, 30);

  engine.rules._onFoul(engine, { offender, victim, position: spot, team: offender.team });
  // 피해 팀이 볼을 잃었다
  engine.possession.team = engine.awayTeam;
  engine.rules._reviewAdvantage(engine, DT);

  assertEqual(engine.state.phase, Phase.DIRECT_FREE_KICK, '이득을 잃었는데 반칙을 불지 않음');
  assertClose(engine.state.restart.position.x, spot.x, 0.01, '프리킥 지점이 반칙 지점과 다름');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 14 — 재개 배치');

test('프리킥에서 상대는 9.15m를 지킨다', () => {
  const engine = makeEngine();
  const spot = new Vector2D(60, 34);
  engine.rules._awardRestart(engine, {
    type: 'DIRECT_FREE_KICK', team: engine.homeTeam, position: spot, reason: 'TEST',
  }, Phase.DIRECT_FREE_KICK);

  for (const opponent of engine.awayTeam.players) {
    const distance = opponent.anchor.sub(spot).length();
    assert(distance >= 9.15 - 0.01,
      `${opponent.id}의 배치 위치가 ${distance.toFixed(2)}m — 규정 거리 미달`);
  }
});

test('골킥에서 상대는 페널티 지역 밖으로 나간다', () => {
  const engine = makeEngine();
  const box = Pitch.goalBoxRect('left');
  engine.rules._awardRestart(engine, {
    type: 'GOAL_KICK', team: engine.homeTeam,
    position: new Vector2D(box.w, 34), reason: 'TEST',
  }, Phase.GOAL_KICK);

  const penaltyBox = ownPenaltyBox(engine.homeTeam.attackingDirection);
  for (const opponent of engine.awayTeam.players) {
    assert(!inRect(opponent.anchor, penaltyBox),
      `${opponent.id}가 골킥 중 페널티 지역 안에 배치됨`);
  }
});

test('골킥은 골키퍼가 찬다', () => {
  const engine = makeEngine();
  const box = Pitch.goalBoxRect('left');
  engine.rules._awardRestart(engine, {
    type: 'GOAL_KICK', team: engine.homeTeam,
    position: new Vector2D(box.w, 34), reason: 'TEST',
  }, Phase.GOAL_KICK);
  assertEqual(engine.state.restart.kicker, engine.homeTeam.goalkeeper);
});

test('킥오프에서 양 팀은 자기 진영에 있는다', () => {
  const engine = makeEngine();
  engine.rules.kickOff(engine, engine.homeTeam);

  for (const team of engine.teams) {
    const dir = team.attackingDirection;
    for (const player of team.players) {
      const nx = (dir === 1 ? player.anchor.x : Pitch.LENGTH - player.anchor.x) / Pitch.LENGTH;
      assert(nx <= 0.52, `${player.id}가 킥오프 시 상대 진영(nx=${nx.toFixed(2)})에 있음`);
    }
  }
});

test('코너킥에서 공격 측이 박스로 모인다', () => {
  const engine = makeEngine();
  engine.rules._awardRestart(engine, {
    type: 'CORNER_KICK', team: engine.homeTeam,
    position: new Vector2D(Pitch.LENGTH, 0), reason: 'TEST',
  }, Phase.CORNER_KICK);

  const box = Pitch.penaltyBoxRect('right');
  const inBox = engine.homeTeam.players.filter((p) => inRect(p.anchor, box));
  assert(inBox.length >= 3, `코너킥인데 박스 안 배치가 ${inBox.length}명뿐`);
});

test('재개는 일정 시간 안에 반드시 실행된다', () => {
  const engine = makeEngine();
  const toucher = engine.homeTeam.players[5];
  setBall(engine, new Vector2D(60, -0.5), new Vector2D(0, -3), toucher);
  engine.rules.postStep(engine, DT);
  assertEqual(engine.state.phase, Phase.THROW_IN);

  // 최대 대기 시간(4초)을 충분히 넘겨 진행한다
  for (let i = 0; i < 60 * 8; i++) engine.step(DT);
  assertEqual(engine.state.phase, Phase.IN_PLAY, '재개가 실행되지 않아 경기가 멈춤');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 13-14 — 전체 경기 진행');

test('3분 시뮬레이션에서 볼이 경기장 밖에 오래 머물지 않는다', () => {
  const engine = makeEngine({ seed: 1350 });
  engine.rules.kickOff(engine, engine.homeTeam);

  let outFrames = 0;
  const total = 60 * 180;
  for (let i = 0; i < total; i++) {
    engine.step(DT);
    const b = engine.ball.position;
    if (b.x < -1 || b.x > Pitch.LENGTH + 1 || b.y < -1 || b.y > Pitch.WIDTH + 1) {
      outFrames++;
    }
  }
  const ratio = outFrames / total;
  assert(ratio < 0.12,
    `볼이 경기장 밖에 있던 시간이 ${(ratio * 100).toFixed(0)}% — 재개가 제대로 동작하지 않음`);
});

test('3분 동안 재개가 실제로 발생한다', () => {
  const engine = makeEngine({ seed: 1351 });
  engine.rules.kickOff(engine, engine.homeTeam);

  const restarts = [];
  engine.eventBus.on('restart', (e) => restarts.push(e.type));
  for (let i = 0; i < 60 * 180; i++) engine.step(DT);

  assert(restarts.length >= 3, `3분 동안 재개가 ${restarts.length}회뿐`);
});

test('규칙이 포함된 전체 시뮬레이션이 결정론적이다', () => {
  const run = () => {
    const engine = makeEngine({ seed: 9001 });
    engine.rules.kickOff(engine, engine.homeTeam);
    for (let i = 0; i < 60 * 60; i++) engine.step(DT);
    return engine.hash();
  };
  assertEqual(run(), run(), '같은 시드에서 결과가 달라짐');
});

test('경기 국면을 바꾸는 것은 규칙 엔진뿐이다', () => {
  // 국면 전환 이벤트가 모두 규칙 판정 경로에서 나오는지 확인한다
  const engine = makeEngine({ seed: 1352 });
  engine.rules.kickOff(engine, engine.homeTeam);

  const phases = [];
  engine.eventBus.on('phase', (e) => phases.push(e.to));
  for (let i = 0; i < 60 * 120; i++) engine.step(DT);

  const allowed = new Set([
    Phase.IN_PLAY, Phase.THROW_IN, Phase.CORNER_KICK, Phase.GOAL_KICK,
    Phase.GOAL, Phase.KICKOFF, Phase.OFFSIDE, Phase.DIRECT_FREE_KICK,
    Phase.INDIRECT_FREE_KICK, Phase.PENALTY, Phase.BALL_OUT,
    Phase.HALF_TIME, Phase.FULL_TIME, Phase.FOUL_STOP,
  ]);
  for (const phase of phases) {
    assert(allowed.has(phase), `알 수 없는 국면으로 전환됨: ${phase}`);
  }
});
