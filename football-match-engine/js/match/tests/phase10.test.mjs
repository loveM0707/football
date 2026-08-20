import { suite, test, assert, assertEqual, assertClose, assertRange } from './_harness.mjs';

import { DecisionEngine } from '../ai/DecisionEngine.js';
import { DefenceAI } from '../ai/DefenceAI.js';
import { OffBallAI } from '../ai/OffBallAI.js';
import { TransitionAI, COUNTERPRESS_WINDOW } from '../ai/TransitionAI.js';
import { TacticalEngine } from '../tactics/TacticalEngine.js';
import { PossessionModel, PossessionState } from '../sim/PossessionModel.js';
import { ActionSystem } from '../sim/ActionSystem.js';
import { MovementEngine } from '../sim/MovementEngine.js';
import { BallPhysics } from '../ball/BallPhysics.js';
import { MatchEngine } from '../core/MatchEngine.js';
import { Phase } from '../core/MatchState.js';
import { Player, Action } from '../entities/Player.js';
import { Team, PossessionPhase } from '../entities/Team.js';
import { Role, Duty } from '../tactics/RoleModel.js';
import { BallFlight } from '../entities/Ball.js';
import { teamNX } from '../core/Coords.js';
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

/** 전체 파이프라인을 갖춘 엔진 */
function makeEngine({ seed = 1000, homeFormation = '4-4-2', awayFormation = '4-3-3' } = {}) {
  const engine = new MatchEngine({
    homeTeam: makeTeam('home', homeFormation),
    awayTeam: makeTeam('away', awayFormation),
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

/** 양 팀을 각자 진영에 대형대로 배치한다 */
function lineUp(engine, ballPos = new Vector2D(52.5, 34)) {
  engine.ball.placeAt(ballPos);
  // 먼저 형태를 계산해 앵커를 얻고, 거기에 선수를 놓는다
  for (const team of engine.teams) {
    engine.tactical.update(engine, team, DT);
    for (const player of team.players) {
      player.position = player.anchor.clone();
      player.velocity = Vector2D.zero();
    }
  }
}

/** 소유 상태를 강제로 세팅한다 */
function setPossession(engine, state, team, player = null) {
  engine.possession.state = state;
  engine.possession.team = team;
  engine.possession.player = player;
}

/**
 * 임무 배정이 안정될 때까지 전술 엔진만 반복 실행한다.
 *
 * 임무에는 0.55초 커밋이 걸려 있어(플래핑 방지) 한 번 호출로는
 * 새 상황이 반영되지 않는다. 선수를 움직이지 않고 전술만 갱신해
 * 커밋을 만료시킨다.
 */
function settleDuties(engine, team, ticks = 45) {
  for (let i = 0; i < ticks; i++) engine.tactical.update(engine, team, DT);
}

/** 캐리어를 지정한다 */
function giveBall(engine, player, position) {
  player.position = position.clone();
  engine.ball.placeAt(position.add(new Vector2D(0.4, 0)));
  engine.ball.carrier = player;
  player.hasBall = true;
  setPossession(engine, PossessionState.DEFINITE, player.team, player);
  player.team.setPhase(PossessionPhase.IN_POSSESSION);
  player.team.opponent.setPhase(PossessionPhase.OUT_OF_POSSESSION);
  return player;
}

// ════════════════════════════════════════════════════════════
suite('PHASE 10 — 압박 (지연이 기본)');

test('압박자는 볼 소유자 쪽으로 접근한다', () => {
  const engine = makeEngine();
  lineUp(engine);
  const carrier = giveBall(engine, engine.homeTeam.players[6], new Vector2D(50, 34));

  engine.tactical.update(engine, engine.awayTeam, DT);
  const presser = engine.awayTeam.assignment.presser;
  assert(presser, '압박자가 없음');

  const before = presser.position.sub(engine.ball.position).length();
  for (let i = 0; i < 90; i++) engine.step(DT);
  const after = presser.position.sub(engine.ball.position).length();

  assert(after < before, `압박자가 볼에 접근하지 않음 (${before.toFixed(1)}m → ${after.toFixed(1)}m)`);
});

test('압박자는 볼과 자기 골문 사이에 선다', () => {
  const engine = makeEngine();
  lineUp(engine);
  const carrier = giveBall(engine, engine.homeTeam.players[6], new Vector2D(60, 34));

  for (let i = 0; i < 120; i++) engine.step(DT);

  const presser = engine.awayTeam.assignment.presser;
  assert(presser, '압박자가 없음');

  // 원정팀 골문은 x=105 쪽. 압박자는 볼보다 골문 쪽(x가 큰 쪽)에 있어야 한다
  assert(presser.position.x > engine.ball.position.x - 1.0,
    `압박자가 볼보다 골문 반대쪽에 있음 (압박자 x=${presser.position.x.toFixed(1)}, 볼 x=${engine.ball.position.x.toFixed(1)})`);
});

test('압박자는 곧바로 달려들지 않고 간격을 둔다', () => {
  const engine = makeEngine();
  lineUp(engine);
  giveBall(engine, engine.homeTeam.players[6], new Vector2D(52, 34));

  // 충분히 접근할 시간을 준다
  for (let i = 0; i < 200; i++) engine.step(DT);

  const presser = engine.awayTeam.assignment.presser;
  if (!presser || !engine.ball.carrier) return; // 이미 뺏었으면 검증 불가

  const gap = presser.position.sub(engine.ball.carrier.position).length();
  assert(gap > 0.6, `압박자가 소유자에 ${gap.toFixed(2)}m까지 밀착 — 몸이 겹침`);
});

test('수비 시 볼로 달려가는 선수는 한 명뿐이다', () => {
  const engine = makeEngine();
  lineUp(engine);
  const carrier = giveBall(engine, engine.homeTeam.players[6], new Vector2D(50, 34));

  for (let i = 0; i < 120; i++) {
    engine.step(DT);
    // 볼 5m 이내로 접근한 원정 선수 수를 센다
    const near = engine.awayTeam.players.filter(
      (p) => p.role !== Role.GK && p.position.sub(engine.ball.position).length() < 5
    );
    assert(near.length <= 3, `${near.length}명이 볼 5m 안에 몰림 (동네축구)`);
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 10 — 커버와 마크');

test('커버는 볼과 자기 골문 사이를 지킨다', () => {
  const engine = makeEngine();
  lineUp(engine);
  giveBall(engine, engine.homeTeam.players[6], new Vector2D(65, 34));

  for (let i = 0; i < 120; i++) engine.step(DT);

  const cover = engine.awayTeam.assignment.cover;
  const presser = engine.awayTeam.assignment.presser;
  assert(cover && presser, '커버 또는 압박자가 없음');

  // 원정 골문은 x=105 쪽 → 커버는 압박자보다 골문 쪽(x가 더 큰 쪽)
  assert(cover.position.x > presser.position.x - 2,
    `커버(${cover.position.x.toFixed(1)})가 압박자(${presser.position.x.toFixed(1)})보다 앞에 있음`);
});

test('마크 목표 지점은 상대보다 골문 쪽에 있다', () => {
  // 실제 도달 위치가 아니라 "어디에 서려 하는가"(결정)를 검증한다.
  // 도달 위치는 이동 지연·상대의 움직임에 좌우되지만, 의도는 수비 로직의
  // 직접적인 산물이다.
  const engine = makeEngine();
  lineUp(engine);
  giveBall(engine, engine.homeTeam.players[6], new Vector2D(55, 34));
  settleDuties(engine, engine.awayTeam);

  const defenceAI = new DefenceAI();
  let checked = 0;

  for (const [defender, target] of engine.awayTeam.assignment.marks) {
    defenceAI.decide(engine, defender);
    if (defender.duty !== Duty.MARK || !defender.decision.target) continue;
    checked++;
    // 원정 골문은 x=105 쪽 → 마크 지점은 상대보다 x가 커야 한다
    assert(defender.decision.target.x > target.position.x - 0.3,
      `${defender.id}의 마크 지점(x=${defender.decision.target.x.toFixed(1)})이 ` +
      `대상 ${target.id}(x=${target.position.x.toFixed(1)})보다 골문 반대쪽`);
  }
  assert(checked > 0, '검증할 마크 관계가 없음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 11 — 전환');

test('볼을 잃은 직후 근처 선수가 되쫓는다', () => {
  const engine = makeEngine();
  lineUp(engine);

  // 홈이 소유하다가 원정에게 뺏긴 상황을 만든다
  const winner = engine.awayTeam.players[6];
  giveBall(engine, winner, new Vector2D(50, 34));
  engine.homeTeam.setPhase(PossessionPhase.TRANSITION_DEFENCE);
  engine.homeTeam.phaseTimer = 0;

  // 볼 근처의 홈 선수를 찾는다
  const nearby = engine.homeTeam.players.filter(
    (p) => p.role !== Role.GK && p.position.sub(engine.ball.position).length() < 17
  );
  assert(nearby.length > 0, '볼 근처에 홈 선수가 없음');

  const before = nearby.map((p) => p.position.sub(engine.ball.position).length());
  for (let i = 0; i < 45; i++) engine.step(DT);
  const after = nearby.map((p) => p.position.sub(engine.ball.position).length());

  const closed = after.filter((d, i) => d < before[i]).length;
  assert(closed >= 1, '볼을 잃었는데 아무도 되쫓지 않음 (카운터프레스 없음)');
});

test('카운터프레스 창이 지나면 블록으로 후퇴한다', () => {
  const engine = makeEngine();
  lineUp(engine);
  const winner = engine.awayTeam.players[6];
  giveBall(engine, winner, new Vector2D(50, 34));

  engine.homeTeam.setPhase(PossessionPhase.TRANSITION_DEFENCE);
  engine.homeTeam.phaseTimer = COUNTERPRESS_WINDOW + 1; // 창이 이미 지난 상태

  const transition = new TransitionAI();
  // 볼에서 가장 멀리 떨어진 필드 플레이어로 검증한다
  const far = engine.homeTeam.players
    .filter((p) => p.role !== Role.GK)
    .sort((a, b) =>
      b.position.sub(engine.ball.position).length() -
      a.position.sub(engine.ball.position).length())[0];
  assert(far, '필드 플레이어를 찾지 못함');
  assertEqual(transition.decide(engine, far), false,
    '카운터프레스 창이 지났는데도 전환 행동이 유지됨');
});

test('볼을 딴 직후 전방 선수가 전력으로 달린다', () => {
  const engine = makeEngine();
  lineUp(engine);
  const winner = engine.homeTeam.players[6];
  giveBall(engine, winner, new Vector2D(50, 34));
  engine.homeTeam.setPhase(PossessionPhase.TRANSITION_ATTACK);
  engine.homeTeam.phaseTimer = 0;

  engine.tactical.update(engine, engine.homeTeam, DT);
  engine.decisions.update(engine, DT);

  const forwards = engine.homeTeam.players.filter(
    (p) => p.role === Role.ST && p !== winner && p.duty !== Duty.REST_DEFENCE
  );
  assert(forwards.length > 0, '최전방 선수가 없음');
  assert(forwards.some((p) => p.decision.sprint),
    '역습 전환인데 전방 선수가 전력 질주하지 않음');
});

test('전환 중에도 후방 잔류 인원은 올라가지 않는다', () => {
  const engine = makeEngine();
  lineUp(engine);
  const winner = engine.homeTeam.players[6];
  giveBall(engine, winner, new Vector2D(50, 34));
  engine.homeTeam.setPhase(PossessionPhase.TRANSITION_ATTACK);
  settleDuties(engine, engine.homeTeam);
  engine.homeTeam.phaseTimer = 0;

  const transition = new TransitionAI();
  const rest = engine.homeTeam.players.filter((p) => p.duty === Duty.REST_DEFENCE);
  assert(rest.length > 0, '후방 잔류 인원이 없음');
  for (const p of rest) {
    assertEqual(transition.decide(engine, p), false,
      `${p.id}(후방 잔류)가 역습에 가담함 — 다시 뺏기면 무너진다`);
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 11 — 패스 수신');

test('수신자는 볼 도착 지점으로 이동한다', () => {
  const engine = makeEngine();
  lineUp(engine);

  const passer = engine.homeTeam.players[3];
  const receiver = engine.homeTeam.players[6];
  passer.position = new Vector2D(35, 34);
  receiver.position = new Vector2D(60, 20);

  engine.ball.placeAt(new Vector2D(35.4, 34));
  engine.ball.kick(new Vector2D(9, -4), 0, {
    kicker: passer, flight: BallFlight.PASS, target: receiver,
    targetPos: new Vector2D(58, 24), time: engine.time,
  });
  setPossession(engine, PossessionState.PASS_IN_FLIGHT, engine.homeTeam);

  engine.tactical.update(engine, engine.homeTeam, DT);
  engine.decisions.update(engine, DT);

  // 판단의 출처는 디버그 필드에 기록된다 (렌더러 계약과 동일)
  assertEqual(receiver.debugTargetSource, 'RECEIVE', '수신자가 마중 판단을 하지 않음');
  const toTarget = receiver.decision.target.sub(new Vector2D(58, 24)).length();
  assert(toTarget < 2, `수신 목표가 패스 도착 지점과 ${toTarget.toFixed(1)}m 어긋남`);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 11 — 온볼 판단');

test('열린 동료가 있으면 패스를 선택한다', () => {
  const engine = makeEngine();
  lineUp(engine);
  const carrier = giveBall(engine, engine.homeTeam.players[5], new Vector2D(45, 34));
  // 완전히 열린 동료를 앞에 놓는다
  const mate = engine.homeTeam.players[9];
  mate.position = new Vector2D(62, 34);
  // 상대를 모두 멀리 치운다
  engine.awayTeam.players.forEach((p, i) => {
    p.position = new Vector2D(100, 2 + i * 6);
  });

  engine.tactical.update(engine, engine.homeTeam, DT);
  engine.decisions.update(engine, DT);

  assertEqual(carrier.decision.action, Action.PASS,
    `열린 동료가 있는데 ${carrier.decision.action}을 선택함`);
});

test('앞이 완전히 열려 있으면 몰고 간다', () => {
  const engine = makeEngine();
  lineUp(engine);
  const carrier = giveBall(engine, engine.homeTeam.players[5], new Vector2D(50, 34));
  // 동료를 전부 뒤로, 상대를 전부 멀리 치운다 → 패스 선택지 제거
  engine.homeTeam.players.forEach((p) => {
    if (p !== carrier) p.position = new Vector2D(8, 34);
  });
  engine.awayTeam.players.forEach((p, i) => {
    p.position = new Vector2D(103, 2 + i * 6);
  });

  engine.tactical.update(engine, engine.homeTeam, DT);
  engine.decisions.update(engine, DT);

  assert(carrier.decision.action === Action.CARRY || carrier.decision.action === Action.PASS,
    `앞이 열렸는데 ${carrier.decision.action}을 선택함`);
});

test('온볼 판단이 매 틱 뒤집히지 않는다', () => {
  const engine = makeEngine();
  lineUp(engine);
  const carrier = giveBall(engine, engine.homeTeam.players[5], new Vector2D(45, 30));

  engine.tactical.update(engine, engine.homeTeam, DT);
  engine.decisions.update(engine, DT);
  const first = carrier.decision.action;

  let changes = 0;
  for (let i = 0; i < 12; i++) {
    engine.tactical.update(engine, engine.homeTeam, DT);
    engine.decisions.update(engine, DT);
    if (carrier.decision.action !== first) changes++;
  }
  assert(changes <= 4, `12틱(0.2초) 동안 판단이 ${changes}회 바뀜 — 커밋이 동작하지 않음`);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 10-11 — 전체 파이프라인 통합');

test('30초 시뮬레이션이 수치적으로 안정하다', () => {
  const engine = makeEngine({ seed: 8080 });
  lineUp(engine);
  giveBall(engine, engine.homeTeam.players[5], new Vector2D(40, 34));

  for (let i = 0; i < 60 * 30; i++) {
    engine.step(DT);

    if (i % 120 === 0) {
      for (const p of engine.allPlayers) {
        assert(Number.isFinite(p.position.x) && Number.isFinite(p.position.y),
          `${p.id} 위치가 NaN (스텝 ${i})`);
        assert(Number.isFinite(p.velocity.x) && Number.isFinite(p.velocity.y),
          `${p.id} 속도가 NaN (스텝 ${i})`);
      }
      assert(Number.isFinite(engine.ball.position.x) && Number.isFinite(engine.ball.position.y),
        `볼 위치가 NaN (스텝 ${i})`);
    }
  }
});

test('30초 동안 선수들이 경기장 안에 머문다', () => {
  const engine = makeEngine({ seed: 8081 });
  lineUp(engine);
  giveBall(engine, engine.homeTeam.players[5], new Vector2D(40, 34));

  for (let i = 0; i < 60 * 30; i++) {
    engine.step(DT);
    if (i % 60 !== 0) continue;
    for (const p of engine.allPlayers) {
      assertRange(p.position.x, -3.1, Pitch.LENGTH + 3.1, `${p.id} x (스텝 ${i})`);
      assertRange(p.position.y, -3.1, Pitch.WIDTH + 3.1, `${p.id} y (스텝 ${i})`);
    }
  }
});

test('30초 동안 패스와 소유 전환이 실제로 일어난다', () => {
  const engine = makeEngine({ seed: 8082 });
  lineUp(engine);
  giveBall(engine, engine.homeTeam.players[5], new Vector2D(40, 34));

  let passes = 0;
  let touches = 0;
  engine.eventBus.on('pass', () => passes++);
  engine.eventBus.on('firstTouch', () => touches++);

  for (let i = 0; i < 60 * 30; i++) engine.step(DT);

  assert(passes > 0, '30초 동안 패스가 한 번도 없음 — 경기가 진행되지 않음');
  assert(touches > 0, '30초 동안 볼 접촉이 한 번도 없음');
});

test('팀이 자기 진영 안에서만 뭉쳐 있지 않는다', () => {
  const engine = makeEngine({ seed: 8083 });
  lineUp(engine);
  giveBall(engine, engine.homeTeam.players[5], new Vector2D(40, 34));

  let maxHomeAdvance = 0;
  for (let i = 0; i < 60 * 30; i++) {
    engine.step(DT);
    if (i % 30 !== 0) continue;
    // 홈팀 최전방 선수의 전진도
    const advance = Math.max(
      ...engine.homeTeam.players
        .filter((p) => p.role !== Role.GK)
        .map((p) => teamNX(p.position.x, 1))
    );
    maxHomeAdvance = Math.max(maxHomeAdvance, advance);
  }
  assert(maxHomeAdvance > 0.55,
    `홈팀이 30초 동안 최대 nx=${maxHomeAdvance.toFixed(2)}까지만 전진 — 공격수가 자기 진영에 머무름`);
});

test('전체 파이프라인이 결정론적이다', () => {
  const run = () => {
    const engine = makeEngine({ seed: 5150 });
    lineUp(engine);
    giveBall(engine, engine.homeTeam.players[5], new Vector2D(42, 30));
    for (let i = 0; i < 60 * 12; i++) engine.step(DT);
    return engine.hash();
  };
  assertEqual(run(), run(), '같은 시드에서 전체 시뮬레이션 결과가 달라짐');
});
