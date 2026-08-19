import { suite, test, assert, assertEqual, assertClose, assertRange } from './_harness.mjs';

import { PossessionModel, PossessionState } from '../sim/PossessionModel.js';
import { resolveFirstTouch, TouchResult, CONTROL_RADIUS } from '../sim/FirstTouch.js';
import { BallPhysics } from '../ball/BallPhysics.js';
import { MatchEngine } from '../core/MatchEngine.js';
import { Phase } from '../core/MatchState.js';
import { Player, Action } from '../entities/Player.js';
import { Team, PossessionPhase } from '../entities/Team.js';
import { BallFlight } from '../entities/Ball.js';
import { Rng } from '../core/Rng.js';
import { Vector2D } from '../../entities/Vector2D.js';

const DT = 1 / 60;

function makeTeam(side, attrs = {}) {
  const players = [];
  for (let i = 0; i < 11; i++) {
    players.push(new Player({ id: `${side}${i}`, name: `${side}${i}`, number: i + 1, attributes: attrs }));
  }
  return new Team({
    name: side, side, color: '#000', formationName: '4-4-2', players,
  });
}

/** 소유 모델 + 물리를 갖춘 엔진 */
function makeEngine({ seed = 1234, homeAttrs = {}, awayAttrs = {} } = {}) {
  const engine = new MatchEngine({
    homeTeam: makeTeam('home', homeAttrs),
    awayTeam: makeTeam('away', awayAttrs),
    seed,
  });
  engine.install({
    possession: new PossessionModel(),
    physics: new BallPhysics(DT),
  });
  engine.setPhase(Phase.IN_PLAY);

  // 모든 선수를 멀리 흩어놓고, 테스트에서 필요한 선수만 배치한다
  engine.allPlayers.forEach((p, i) => {
    p.position = new Vector2D(-40 - (i % 11) * 4, i < 11 ? -30 : -60);
    p.setDecision(Action.IDLE, null);
  });
  return engine;
}

// ════════════════════════════════════════════════════════════
suite('PHASE 6 — 퍼스트 터치');

test('느리고 정면으로 오는 볼은 대체로 잘 잡는다', () => {
  const rng = new Rng(7).stream('touch');
  const player = new Player({ id: 'p', name: 'p', number: 1, attributes: { firstTouch: 75, dribbling: 70, agility: 70 } });
  player.position = new Vector2D(50, 34);
  player.facingAngle = Math.PI; // 볼이 오는 쪽을 본다

  let retained = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const ball = { velocity: new Vector2D(-5, 0), height: 0 };
    const t = resolveFirstTouch({ player, ball, pressure: 0, rng });
    if (t.retained) retained++;
  }
  assertRange(retained / N, 0.90, 1.0, '쉬운 볼 통제 성공률');
});

test('빠른 볼은 통제하기 어렵다', () => {
  const rng = new Rng(11).stream('touch');
  const player = new Player({ id: 'p', name: 'p', number: 1, attributes: { firstTouch: 60, dribbling: 60, agility: 60 } });
  player.position = new Vector2D(50, 34);
  player.facingAngle = Math.PI;

  const rate = (speed) => {
    let retained = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const ball = { velocity: new Vector2D(-speed, 0), height: 0 };
      if (resolveFirstTouch({ player, ball, pressure: 0, rng }).retained) retained++;
    }
    return retained / N;
  };

  const slow = rate(5);
  const fast = rate(20);
  assert(fast < slow, `볼 속도가 통제 성공률에 반영되지 않음 (${slow} vs ${fast})`);
  assert(fast < 0.85, `20 m/s 볼을 너무 쉽게 잡음 (${fast})`);
});

test('능력치가 높으면 통제 성공률이 높다', () => {
  const rate = (skill) => {
    const rng = new Rng(23).stream('touch');
    const player = new Player({
      id: 'p', name: 'p', number: 1,
      attributes: { firstTouch: skill, dribbling: skill, agility: skill, balance: skill },
    });
    player.position = new Vector2D(50, 34);
    player.facingAngle = Math.PI;
    let retained = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const ball = { velocity: new Vector2D(-13, 0), height: 0 };
      if (resolveFirstTouch({ player, ball, pressure: 0.3, rng }).retained) retained++;
    }
    return retained / N;
  };
  assert(rate(85) > rate(30) + 0.10, '능력치가 퍼스트 터치에 충분히 반영되지 않음');
});

test('압박을 받으면 통제가 어려워진다', () => {
  const rate = (pressure) => {
    const rng = new Rng(31).stream('touch');
    const player = new Player({ id: 'p', name: 'p', number: 1, attributes: { firstTouch: 65, dribbling: 65 } });
    player.position = new Vector2D(50, 34);
    player.facingAngle = Math.PI;
    let retained = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const ball = { velocity: new Vector2D(-12, 0), height: 0 };
      if (resolveFirstTouch({ player, ball, pressure, rng }).retained) retained++;
    }
    return retained / N;
  };
  assert(rate(1.0) < rate(0.0), '압박이 퍼스트 터치에 반영되지 않음');
});

test('등 뒤에서 오는 볼이 정면보다 어렵다', () => {
  const rate = (facing) => {
    const rng = new Rng(41).stream('touch');
    const player = new Player({ id: 'p', name: 'p', number: 1, attributes: { firstTouch: 60, dribbling: 60 } });
    player.position = new Vector2D(50, 34);
    player.facingAngle = facing;
    let retained = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      // 볼은 항상 -x 방향으로 진행 (즉 +x 쪽에서 날아온다)
      const ball = { velocity: new Vector2D(-14, 0), height: 0 };
      if (resolveFirstTouch({ player, ball, pressure: 0.2, rng }).retained) retained++;
    }
    return retained / N;
  };
  const facingBall = rate(0);       // 볼이 오는 쪽(+x)을 봄
  const facingAway = rate(Math.PI); // 등을 돌림
  assert(facingAway < facingBall,
    `신체 방향이 반영되지 않음 (정면 ${facingBall}, 등 ${facingAway})`);
});

test('나쁜 터치는 볼을 크게 튕겨낸다', () => {
  const rng = new Rng(53).stream('touch');
  const player = new Player({ id: 'p', name: 'p', number: 1, attributes: { firstTouch: 20, dribbling: 20, agility: 20, balance: 20 } });
  player.position = new Vector2D(50, 34);

  let sawBad = false;
  for (let i = 0; i < 300; i++) {
    const ball = { velocity: new Vector2D(-22, 0), height: 0.5 };
    const t = resolveFirstTouch({ player, ball, pressure: 0.8, rng });
    if (t.result === TouchResult.BAD_TOUCH || t.result === TouchResult.LOOSE_CONTROL) {
      sawBad = true;
      assert(!t.retained, '나쁜 터치인데 소유를 유지함');
      assert(t.ballVelocity.length() > 2.5, '나쁜 터치인데 볼이 거의 안 튐');
    }
  }
  assert(sawBad, '어려운 상황에서도 나쁜 터치가 한 번도 발생하지 않음');
});

test('퍼스트 터치가 결정론적이다', () => {
  const run = () => {
    const rng = new Rng(99).stream('touch');
    const player = new Player({ id: 'p', name: 'p', number: 1, attributes: { firstTouch: 55 } });
    player.position = new Vector2D(50, 34);
    const out = [];
    for (let i = 0; i < 100; i++) {
      const ball = { velocity: new Vector2D(-11, 2), height: 0.2 };
      const t = resolveFirstTouch({ player, ball, pressure: 0.4, rng });
      out.push(`${t.result}:${t.quality.toFixed(6)}`);
    }
    return out.join('|');
  };
  assertEqual(run(), run(), '같은 시드에서 결과가 달라짐');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 6 — 소유 상태 판정');

test('발밑에 볼이 있으면 확실한 소유다', () => {
  const engine = makeEngine();
  const p = engine.homeTeam.players[5];
  p.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50.4, 34));
  engine.ball.carrier = p;

  engine.possession.update(engine, DT);
  assertEqual(engine.possession.state, PossessionState.DEFINITE);
  assertEqual(engine.possession.team, engine.homeTeam);
  assertEqual(p.hasBall, true, 'hasBall 플래그가 동기화되지 않음');
});

test('상대가 밀착하면 경합 상태가 된다', () => {
  const engine = makeEngine();
  const p = engine.homeTeam.players[5];
  const o = engine.awayTeam.players[3];
  p.position = new Vector2D(50, 34);
  o.position = new Vector2D(51.5, 34);
  engine.ball.placeAt(new Vector2D(50.4, 34));
  engine.ball.carrier = p;

  engine.possession.update(engine, DT);
  assertEqual(engine.possession.state, PossessionState.CONTESTED);
  // 경합 중에도 소유팀은 여전히 볼을 가진 쪽이다
  assertEqual(engine.possession.team, engine.homeTeam);
});

test('아무도 통제하지 못하는 볼은 루즈볼이다', () => {
  const engine = makeEngine();
  engine.ball.placeAt(new Vector2D(50, 34));
  engine.possession.update(engine, DT);
  assertEqual(engine.possession.state, PossessionState.LOOSE);
  assertEqual(engine.possession.team, null);
});

test('캐리어가 볼에서 멀어지면 소유를 잃는다', () => {
  const engine = makeEngine();
  const p = engine.homeTeam.players[5];
  p.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(53, 34)); // 3m 떨어짐
  engine.ball.carrier = p;

  engine.possession.update(engine, DT);
  assertEqual(engine.ball.carrier, null, '멀어졌는데도 소유가 유지됨');
  assertEqual(p.hasBall, false);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 6 — 패스 비행 중 소유 유지 (핵심)');

test('패스가 발을 떠나도 소유팀이 유지된다', () => {
  const engine = makeEngine();
  const passer = engine.homeTeam.players[5];
  passer.position = new Vector2D(40, 34);
  engine.ball.placeAt(new Vector2D(40.4, 34));
  engine.ball.kick(new Vector2D(12, 0), 0, {
    kicker: passer, flight: BallFlight.PASS, time: engine.time,
  });

  engine.possession.update(engine, DT);
  assertEqual(engine.possession.state, PossessionState.PASS_IN_FLIGHT,
    '패스 비행이 별도 상태로 인식되지 않음');
  assertEqual(engine.possession.team, engine.homeTeam,
    '패스 중 소유팀이 사라짐 — 구 엔진의 대표 결함');
});

test('패스 비행 중 팀이 수비 국면으로 뒤집히지 않는다', () => {
  const engine = makeEngine();
  const passer = engine.homeTeam.players[5];
  passer.position = new Vector2D(40, 34);
  engine.homeTeam.setPhase(PossessionPhase.IN_POSSESSION);
  engine.awayTeam.setPhase(PossessionPhase.OUT_OF_POSSESSION);

  engine.ball.placeAt(new Vector2D(40.4, 34));
  engine.ball.kick(new Vector2D(14, 3), 0, {
    kicker: passer, flight: BallFlight.PASS, time: engine.time,
  });

  // 패스가 날아가는 동안 계속 확인
  for (let i = 0; i < 60; i++) {
    engine.possession.update(engine, DT);
    engine.physics.update(engine, DT);
    assert(engine.homeTeam.isAttacking,
      `패스 비행 중 홈팀이 수비 국면으로 바뀜 (스텝 ${i})`);
  }
});

test('슛 비행은 패스와 구분된다', () => {
  const engine = makeEngine();
  const shooter = engine.homeTeam.players[9];
  shooter.position = new Vector2D(90, 34);
  engine.ball.placeAt(new Vector2D(90.4, 34));
  engine.ball.kick(new Vector2D(25, 0), 2, {
    kicker: shooter, flight: BallFlight.SHOT, time: engine.time,
  });

  engine.possession.update(engine, DT);
  assertEqual(engine.possession.state, PossessionState.SHOT_IN_FLIGHT);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 6 — 전환 감지');

test('상대에게 볼을 뺏기면 양 팀이 전환 국면이 된다', () => {
  const engine = makeEngine();
  const home = engine.homeTeam.players[5];
  const away = engine.awayTeam.players[4];

  // 먼저 홈이 소유
  home.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50.4, 34));
  engine.ball.carrier = home;
  engine.possession.update(engine, DT);
  engine.homeTeam.setPhase(PossessionPhase.IN_POSSESSION);
  engine.awayTeam.setPhase(PossessionPhase.OUT_OF_POSSESSION);

  // 원정이 볼을 가져감
  home.position = new Vector2D(60, 40);
  away.position = new Vector2D(50, 34);
  engine.ball.carrier = away;
  engine.possession.update(engine, DT);

  assertEqual(engine.awayTeam.phase, PossessionPhase.TRANSITION_ATTACK,
    '볼을 딴 팀이 공격 전환이 아님');
  assertEqual(engine.homeTeam.phase, PossessionPhase.TRANSITION_DEFENCE,
    '볼을 잃은 팀이 수비 전환이 아님');
});

test('턴오버 이벤트가 발생한다', () => {
  const engine = makeEngine();
  const home = engine.homeTeam.players[5];
  const away = engine.awayTeam.players[4];
  const events = [];
  engine.eventBus.on('turnover', (e) => events.push(e));

  home.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50.4, 34));
  engine.ball.carrier = home;
  engine.possession.update(engine, DT);

  home.position = new Vector2D(60, 40);
  away.position = new Vector2D(50, 34);
  engine.ball.carrier = away;
  engine.possession.update(engine, DT);

  assertEqual(events.length, 1, '턴오버 이벤트가 발생하지 않음');
  assertEqual(events[0].winner, engine.awayTeam);
});

test('같은 팀 안에서 패스가 이어져도 턴오버가 아니다', () => {
  const engine = makeEngine();
  const a = engine.homeTeam.players[5];
  const b = engine.homeTeam.players[6];
  const events = [];
  engine.eventBus.on('turnover', (e) => events.push(e));

  a.position = new Vector2D(40, 34);
  engine.ball.placeAt(new Vector2D(40.4, 34));
  engine.ball.carrier = a;
  engine.possession.update(engine, DT);

  a.position = new Vector2D(40, 34);
  b.position = new Vector2D(55, 34);
  engine.ball.placeAt(new Vector2D(55.3, 34));
  engine.ball.carrier = b;
  engine.possession.update(engine, DT);

  assertEqual(events.length, 0, '같은 팀 내 소유 이동을 턴오버로 처리함');
  assertEqual(engine.possession.team, engine.homeTeam);
});

test('점유 시간이 소유팀에 적립된다', () => {
  const engine = makeEngine();
  const p = engine.homeTeam.players[5];
  p.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50.4, 34));
  engine.ball.carrier = p;

  for (let i = 0; i < 60; i++) engine.possession.update(engine, DT);
  assertClose(engine.homeTeam.possessionSeconds, 1.0, 0.05);
  assertClose(engine.awayTeam.possessionSeconds, 0, 1e-9);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 6 — 통제 시도 통합');

test('굴러오는 볼을 근처 선수가 잡는다', () => {
  const engine = makeEngine({ seed: 555 });
  const receiver = engine.homeTeam.players[7];
  receiver.position = new Vector2D(60, 34);
  receiver.facingAngle = Math.PI;
  receiver.attributes.firstTouch = 85;
  receiver.attributes.dribbling = 80;

  engine.ball.placeAt(new Vector2D(45, 34));
  engine.ball.kick(new Vector2D(7, 0), 0, {
    kicker: engine.homeTeam.players[3], flight: BallFlight.PASS, time: engine.time,
  });

  let controlled = false;
  for (let i = 0; i < 60 * 8; i++) {
    engine.possession.update(engine, DT);
    engine.physics.update(engine, DT);
    if (engine.ball.carrier === receiver) { controlled = true; break; }
  }
  assert(controlled, '근처로 굴러온 볼을 잡지 못함');
});

test('통제 후 즉시 재터치하지 않는다 (진동 방지)', () => {
  const engine = makeEngine({ seed: 777 });
  const p = engine.homeTeam.players[7];
  p.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50.3, 34));
  engine.ball.velocity = new Vector2D(3, 0);

  const touches = [];
  engine.eventBus.on('firstTouch', (e) => touches.push(engine.stepCount));

  for (let i = 0; i < 30; i++) {
    engine.stepCount = i;
    engine.possession.update(engine, DT);
  }

  // 쿨다운(0.28초 ≈ 17스텝) 안에 두 번 터치하면 안 된다
  for (let i = 1; i < touches.length; i++) {
    assert(touches[i] - touches[i - 1] >= 16,
      `터치 간격이 너무 짧음: ${touches[i - 1]} → ${touches[i]}`);
  }
});

test('높이 뜬 볼은 발로 통제할 수 없다', () => {
  const engine = makeEngine();
  const p = engine.homeTeam.players[7];
  p.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50.3, 34));
  engine.ball.height = 2.5;
  engine.ball.velocity = new Vector2D(5, 0);

  engine.possession.update(engine, DT);
  assertEqual(engine.ball.carrier, null, '머리 위 볼을 발로 잡음');
});

test('인플레이가 아니면 소유 판정을 하지 않는다', () => {
  const engine = makeEngine();
  engine.setPhase(Phase.THROW_IN);
  const p = engine.homeTeam.players[5];
  p.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50.3, 34));

  engine.possession.update(engine, DT);
  assertEqual(engine.possession.state, PossessionState.NONE);
});

test('패스한 선수가 자기 패스를 즉시 되잡지 않는다', () => {
  const engine = makeEngine({ seed: 909 });
  const passer = engine.homeTeam.players[5];
  passer.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50.4, 34));
  engine.ball.kick(new Vector2D(4, 0), 0, {
    kicker: passer, flight: BallFlight.PASS, time: engine.time,
  });

  // 찬 직후 몇 스텝 동안은 되잡히면 안 된다
  for (let i = 0; i < 12; i++) {
    engine.possession.update(engine, DT);
    engine.physics.update(engine, DT);
    assert(engine.ball.carrier !== passer, `패스한 선수가 ${i}스텝 만에 되잡음`);
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 6 — 결정론');

test('같은 시드는 같은 소유 전개를 만든다', () => {
  const run = (seed) => {
    const engine = makeEngine({ seed });
    // 두 선수를 볼 주변에 배치하고 볼을 굴린다
    const a = engine.homeTeam.players[5];
    const b = engine.awayTeam.players[5];
    a.position = new Vector2D(48, 34);
    b.position = new Vector2D(56, 35);
    engine.ball.placeAt(new Vector2D(50, 34));
    engine.ball.velocity = new Vector2D(6, 1);

    const trace = [];
    for (let i = 0; i < 300; i++) {
      engine.step(DT);
      trace.push(engine.possession.snapshot().state);
    }
    return trace.join(',');
  };
  assertEqual(run(2468), run(2468), '같은 시드에서 소유 전개가 달라짐');
});
