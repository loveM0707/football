import { suite, test, assert, assertEqual, assertClose, assertRange } from './_harness.mjs';

import { DribblePlanner, TOUCH_TRIGGER_DISTANCE } from '../ai/DribblePlanner.js';
import {
  tackleFactors, resolveTackle, tackleDesirability, shieldStrength,
  DuelOutcome, TACKLE_RANGE,
} from '../ai/DuelResolver.js';
import { ActionSystem } from '../sim/ActionSystem.js';
import { PossessionModel } from '../sim/PossessionModel.js';
import { MovementEngine } from '../sim/MovementEngine.js';
import { BallPhysics } from '../ball/BallPhysics.js';
import { PassPlanner } from '../ai/PassPlanner.js';
import { MatchEngine } from '../core/MatchEngine.js';
import { Phase } from '../core/MatchState.js';
import { Player, Action } from '../entities/Player.js';
import { Team } from '../entities/Team.js';
import { Rng } from '../core/Rng.js';
import { Vector2D } from '../../entities/Vector2D.js';

const DT = 1 / 60;

function makeTeam(side, attrs = {}) {
  const players = [];
  for (let i = 0; i < 11; i++) {
    players.push(new Player({ id: `${side}${i}`, name: `${side}${i}`, number: i + 1, attributes: attrs }));
  }
  return new Team({ name: side, side, color: '#000', formationName: '4-4-2', players });
}

/** 완전한 시뮬레이션 파이프라인을 갖춘 엔진 */
function makeEngine({ seed = 500, homeAttrs = {}, awayAttrs = {} } = {}) {
  const engine = new MatchEngine({
    homeTeam: makeTeam('home', homeAttrs),
    awayTeam: makeTeam('away', awayAttrs),
    seed,
  });
  engine.install({
    possession: new PossessionModel(),
    actions: new ActionSystem(DT),
    movement: new MovementEngine(),
    physics: new BallPhysics(DT),
  });
  engine.setPhase(Phase.IN_PLAY);
  engine.allPlayers.forEach((p, i) => {
    p.position = new Vector2D(-50 - i * 3, -50);
    p.velocity = Vector2D.zero();
    p.setDecision(Action.IDLE, null);
  });
  return engine;
}

/** 캐리어를 세팅한다 (볼을 발 앞에 두고 지배 상태로) */
function giveBall(engine, player, position) {
  player.position = position.clone();
  engine.ball.placeAt(position.add(new Vector2D(0.4, 0)));
  engine.ball.carrier = player;
  player.hasBall = true;
  return player;
}

// ════════════════════════════════════════════════════════════
suite('PHASE 8 — 볼은 발에 붙지 않는다');

test('캐리 중에도 볼은 물리 적분을 받는다', () => {
  const engine = makeEngine();
  const p = giveBall(engine, engine.homeTeam.players[5], new Vector2D(50, 34));
  engine.ball.velocity = new Vector2D(4, 0);

  const before = engine.ball.position.x;
  engine.physics.update(engine, DT);
  assert(engine.ball.position.x > before,
    '캐리 중이라고 볼이 물리를 무시함 (부착 모델)');
});

test('선수가 가만히 있으면 볼도 제자리에 있다', () => {
  const engine = makeEngine();
  const p = giveBall(engine, engine.homeTeam.players[5], new Vector2D(50, 34));
  p.setDecision(Action.IDLE, null);

  const before = engine.ball.position.clone();
  for (let i = 0; i < 60; i++) engine.step(DT);
  assert(engine.ball.position.sub(before).length() < 0.1,
    '아무도 안 건드렸는데 볼이 움직임');
});

test('터치 없이 선수만 달려가면 볼을 두고 간다', () => {
  const engine = makeEngine();
  const p = giveBall(engine, engine.homeTeam.players[5], new Vector2D(50, 34));
  // MOVE만 지정 — CARRY가 아니므로 터치하지 않는다
  p.setDecision(Action.MOVE, new Vector2D(80, 34), { sprint: true });

  for (let i = 0; i < 90; i++) engine.step(DT);
  assert(engine.ball.carrier !== p, '볼을 두고 갔는데도 소유가 유지됨');
  assert(p.position.x - engine.ball.position.x > 3,
    '선수가 볼을 두고 앞서가지 않음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 8 — 드리블 터치 사이클');

test('드리블하면 볼이 앞으로 밀린다', () => {
  const engine = makeEngine({ seed: 11 });
  const p = giveBall(engine, engine.homeTeam.players[5], new Vector2D(40, 34));
  p.setDecision(Action.CARRY, new Vector2D(90, 34), { sprint: true });

  const touches = [];
  engine.eventBus.on('dribbleTouch', (e) => touches.push(e));

  for (let i = 0; i < 60 * 5; i++) {
    p.setDecision(Action.CARRY, new Vector2D(90, 34), { sprint: true });
    engine.step(DT);
  }

  assert(touches.length >= 3, `5초 동안 터치가 ${touches.length}회뿐 — 사이클이 동작하지 않음`);
  assert(p.position.x > 55, `드리블로 전진하지 못함 (x=${p.position.x.toFixed(1)})`);
  assertEqual(engine.ball.carrier, p, '드리블 도중 소유를 잃음');
});

test('볼이 선수보다 앞서 나간다 (붙어 다니지 않는다)', () => {
  const engine = makeEngine({ seed: 13 });
  const p = giveBall(engine, engine.homeTeam.players[5], new Vector2D(30, 34));

  let maxGap = 0;
  for (let i = 0; i < 60 * 5; i++) {
    p.setDecision(Action.CARRY, new Vector2D(95, 34), { sprint: true });
    engine.step(DT);
    maxGap = Math.max(maxGap, engine.ball.position.sub(p.position).length());
  }
  assert(maxGap > 1.0, `볼과 선수 간격이 최대 ${maxGap.toFixed(2)}m — 사실상 붙어 있음`);
  assert(maxGap < 6.0, `볼이 ${maxGap.toFixed(2)}m나 앞서감 — 통제 불가`);
});

test('빠르게 달릴수록 터치를 멀리 한다', () => {
  const planner = new DribblePlanner(DT);
  const engine = makeEngine();
  const p = engine.homeTeam.players[5];
  p.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50.4, 34));

  const distanceAt = (speed) => {
    p.velocity = new Vector2D(speed, 0);
    return planner._touchDistance(p, [], new Vector2D(90, 34));
  };
  const walking = distanceAt(1.5);
  const sprinting = distanceAt(8);
  assert(sprinting > walking * 1.5,
    `속도가 터치 거리에 반영되지 않음 (걷기 ${walking.toFixed(2)}m, 질주 ${sprinting.toFixed(2)}m)`);
});

test('압박을 받으면 볼을 발밑에 붙인다', () => {
  const planner = new DribblePlanner(DT);
  const engine = makeEngine();
  const p = engine.homeTeam.players[5];
  p.position = new Vector2D(50, 34);
  p.velocity = new Vector2D(5, 0);
  engine.ball.placeAt(new Vector2D(50.4, 34));

  const free = planner._touchDistance(p, [], new Vector2D(90, 34));

  const marker = engine.awayTeam.players[3];
  marker.position = new Vector2D(51.5, 34.5);
  const pressed = planner._touchDistance(p, [marker], new Vector2D(90, 34));

  assert(pressed < free,
    `압박이 터치 거리에 반영되지 않음 (자유 ${free.toFixed(2)}m, 압박 ${pressed.toFixed(2)}m)`);
});

test('드리블 능력이 높으면 같은 속도에서 더 가깝게 통제한다', () => {
  const planner = new DribblePlanner(DT);
  const engine = makeEngine();

  const distanceFor = (dribbling) => {
    const p = new Player({ id: 'x', name: 'x', number: 1, attributes: { dribbling } });
    p.position = new Vector2D(50, 34);
    p.velocity = new Vector2D(6, 0);
    p.team = engine.homeTeam;
    return planner._touchDistance(p, [], new Vector2D(90, 34));
  };
  assert(distanceFor(85) < distanceFor(30),
    '드리블 능력이 터치 거리에 반영되지 않음');
});

test('크게 방향을 꺾을 때는 터치를 짧게 한다', () => {
  const planner = new DribblePlanner(DT);
  const engine = makeEngine();
  const p = engine.homeTeam.players[5];
  p.position = new Vector2D(50, 34);
  p.velocity = new Vector2D(7, 0); // +x로 달리는 중

  const straight = planner._touchDistance(p, [], new Vector2D(90, 34));
  const turning = planner._touchDistance(p, [], new Vector2D(50, 5)); // 직각으로 꺾기
  assert(turning < straight,
    `방향 전환이 터치 거리에 반영되지 않음 (직진 ${straight.toFixed(2)}m, 전환 ${turning.toFixed(2)}m)`);
});

test('수비수 쪽으로 볼을 밀지 않는다', () => {
  const planner = new DribblePlanner(DT);
  const engine = makeEngine();
  const p = engine.homeTeam.players[5];
  p.position = new Vector2D(50, 34);
  p.velocity = new Vector2D(4, 0);

  // 정면 바로 앞에 수비수
  const defender = engine.awayTeam.players[3];
  defender.position = new Vector2D(53, 34);

  const direction = planner._touchDirection(p, new Vector2D(90, 34), [defender]);
  const toDefender = defender.position.sub(p.position).normalize();
  assert(direction.dot(toDefender) < 0.95,
    '수비수 정면으로 볼을 밀어넣음');
});

test('드리블 터치가 결정론적이다', () => {
  const run = () => {
    const engine = makeEngine({ seed: 4242 });
    const p = giveBall(engine, engine.homeTeam.players[5], new Vector2D(35, 30));
    engine.awayTeam.players[3].position = new Vector2D(48, 32);
    for (let i = 0; i < 60 * 4; i++) {
      p.setDecision(Action.CARRY, new Vector2D(95, 40), { sprint: true });
      engine.step(DT);
    }
    return `${p.position.x.toFixed(6)},${p.position.y.toFixed(6)},${engine.ball.position.x.toFixed(6)}`;
  };
  assertEqual(run(), run(), '같은 시드에서 드리블 결과가 달라짐');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 8 — 1v1 태클 판정');

/** 태클 상황을 만든다 */
function duelSetup({ tacklerAttrs = {}, carrierAttrs = {}, ballGap = 0.5, angle = 0 } = {}) {
  const tackler = new Player({ id: 'd', name: 'd', number: 4, attributes: tacklerAttrs });
  const carrier = new Player({ id: 'a', name: 'a', number: 9, attributes: carrierAttrs });
  carrier.position = new Vector2D(50, 34);
  carrier.velocity = new Vector2D(5, 0); // +x 방향으로 전진 중
  carrier.facingAngle = 0;
  // angle: 공격수 위치를 기준으로 수비수를 놓는 방향.
  //   0  = 공격수 진행 방향 앞  → 수비수가 정면에서 마주 본다
  //   π  = 공격수 뒤            → 수비수가 등 뒤에서 쫓아간다
  tackler.position = carrier.position.add(Vector2D.fromAngle(angle, 1.6));
  tackler.velocity = Vector2D.zero();
  const ball = { position: carrier.position.add(new Vector2D(ballGap, 0)) };
  return { tackler, carrier, ball };
}

test('볼이 발에서 멀수록 태클 성공률이 높다', () => {
  const near = duelSetup({ ballGap: 0.4 });
  const far = duelSetup({ ballGap: 2.0 });
  const a = tackleFactors(near.tackler, near.carrier, near.ball);
  const b = tackleFactors(far.tackler, far.carrier, far.ball);
  assert(b.success > a.success,
    `볼 노출도가 반영되지 않음 (${a.success.toFixed(2)} vs ${b.success.toFixed(2)})`);
});

test('능력치 대결이 성공률에 반영된다', () => {
  const strong = duelSetup({
    tacklerAttrs: { tackling: 90, interceptions: 85, strength: 80 },
    carrierAttrs: { dribbling: 30, balance: 30 },
  });
  const weak = duelSetup({
    tacklerAttrs: { tackling: 30, interceptions: 30, strength: 40 },
    carrierAttrs: { dribbling: 90, balance: 85 },
  });
  const s = tackleFactors(strong.tackler, strong.carrier, strong.ball);
  const w = tackleFactors(weak.tackler, weak.carrier, weak.ball);
  assert(s.success > w.success + 0.25, '능력치 대결이 충분히 반영되지 않음');
});

test('뒤에서 덤비면 반칙 위험이 높다', () => {
  const front = duelSetup({ angle: 0 });        // 수비수가 정면에서 마주 봄
  const behind = duelSetup({ angle: Math.PI }); // 수비수가 등 뒤에서 쫓아감
  const f = tackleFactors(front.tackler, front.carrier, front.ball);
  const b = tackleFactors(behind.tackler, behind.carrier, behind.ball);
  assert(b.foulRisk > f.foulRisk,
    `접근 각도가 반칙 위험에 반영되지 않음 (정면 ${f.foulRisk.toFixed(2)}, 뒤 ${b.foulRisk.toFixed(2)})`);
});

test('상대 속도가 빠르면 태클이 어렵다', () => {
  const slow = duelSetup();
  slow.carrier.velocity = new Vector2D(2, 0);
  const fast = duelSetup();
  fast.carrier.velocity = new Vector2D(9, 0);

  const s = tackleFactors(slow.tackler, slow.carrier, slow.ball);
  const f = tackleFactors(fast.tackler, fast.carrier, fast.ball);
  assert(f.success < s.success, '상대 속도가 반영되지 않음');
});

test('태클 결과가 네 가지로 갈린다', () => {
  const rng = new Rng(31).stream('duel');
  const seen = new Set();
  for (let i = 0; i < 800; i++) {
    const gap = 0.3 + (i % 5) * 0.45;
    const setup = duelSetup({
      ballGap: gap,
      angle: (i % 7) * (Math.PI / 6),
      tacklerAttrs: { tackling: 40 + (i % 5) * 12 },
      carrierAttrs: { dribbling: 40 + (i % 4) * 14 },
    });
    seen.add(resolveTackle({ ...setup, rng }).outcome);
  }
  assert(seen.has(DuelOutcome.WIN_CLEAN), '깨끗한 성공이 한 번도 없음');
  assert(seen.has(DuelOutcome.FAIL), '실패가 한 번도 없음');
  assert(seen.has(DuelOutcome.FOUL), '반칙이 한 번도 없음');
});

test('태클 성공률이 극단으로 치우치지 않는다', () => {
  const rng = new Rng(77).stream('duel');
  let wins = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const setup = duelSetup({
      ballGap: 0.9,
      tacklerAttrs: { tackling: 65, interceptions: 60, strength: 65 },
      carrierAttrs: { dribbling: 65, balance: 65 },
    });
    const r = resolveTackle({ ...setup, rng });
    if (r.outcome === DuelOutcome.WIN_CLEAN || r.outcome === DuelOutcome.WIN_LOOSE) wins++;
  }
  const rate = wins / N;
  assertRange(rate, 0.20, 0.65, '동등한 능력의 1대1 태클 성공률');
});

test('태클이 결정론적이다', () => {
  const run = () => {
    const rng = new Rng(2024).stream('duel');
    const out = [];
    for (let i = 0; i < 200; i++) {
      const setup = duelSetup({ ballGap: 0.5 + (i % 4) * 0.4 });
      out.push(resolveTackle({ ...setup, rng }).outcome);
    }
    return out.join(',');
  };
  assertEqual(run(), run(), '같은 시드에서 태클 결과가 달라짐');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 8 — 태클 판단 (지연이 기본)');

test('최후의 수비수는 덤비기를 꺼린다', () => {
  // 원래는 덤빌 만한 상황(정면 접근 + 볼이 크게 노출)에서 비교해야
  // 최후 수비수 감점이 눈에 보인다
  const setup = duelSetup({ angle: 0, ballGap: 1.8 });
  const normal = tackleDesirability(setup.tackler, setup.carrier, setup.ball, {
    lastDefender: false,
  });
  const last = tackleDesirability(setup.tackler, setup.carrier, setup.ball, {
    lastDefender: true,
  });
  assert(last < normal, '최후의 수비수 상황이 반영되지 않음');
});

test('볼이 크게 떠 있으면 덤빌 만하다', () => {
  const tight = duelSetup({ ballGap: 0.4 });
  const loose = duelSetup({ ballGap: 2.2 });
  const a = tackleDesirability(tight.tackler, tight.carrier, tight.ball);
  const b = tackleDesirability(loose.tackler, loose.carrier, loose.ball);
  assert(b > a, '볼 노출도가 태클 판단에 반영되지 않음');
});

test('팀 태클 적극성이 판단에 반영된다', () => {
  const setup = duelSetup({ ballGap: 0.9 });
  const cautious = tackleDesirability(setup.tackler, setup.carrier, setup.ball, { aggression: 0 });
  const aggressive = tackleDesirability(setup.tackler, setup.carrier, setup.ball, { aggression: 1 });
  assert(aggressive > cautious, '팀 지시가 반영되지 않음');
});

test('몸싸움 우위가 능력치로 결정된다', () => {
  const big = new Player({ id: 'b', name: 'b', number: 9, attributes: { strength: 90, balance: 85 } });
  const small = new Player({ id: 's', name: 's', number: 2, attributes: { strength: 35, balance: 40 } });
  assert(shieldStrength(big, small) > 0.6, '강한 선수가 몸싸움에서 밀림');
  assert(shieldStrength(small, big) < 0.4, '약한 선수가 몸싸움에서 이김');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 8 — 태클 실행 통합');

test('태클 성공 시 소유가 넘어간다', () => {
  const engine = makeEngine({ seed: 3 });
  const carrier = giveBall(engine, engine.homeTeam.players[9], new Vector2D(50, 34));
  const tackler = engine.awayTeam.players[3];
  tackler.position = new Vector2D(51.2, 34);
  tackler.attributes.tackling = 99;
  tackler.attributes.interceptions = 99;
  tackler.attributes.strength = 95;
  carrier.attributes.dribbling = 5;
  carrier.attributes.balance = 5;
  // 볼을 크게 노출시켜 성공 확률을 높인다.
  // placeAt은 캐리어를 해제하므로 배치 후 다시 지정해야 한다.
  engine.ball.placeAt(carrier.position.add(new Vector2D(1.8, 0)));
  engine.ball.carrier = carrier;

  const events = [];
  engine.eventBus.on('tackle', (e) => events.push(e));

  let taken = false;
  for (let i = 0; i < 40; i++) {
    tackler.tackleRecovery = 0;
    tackler.setDecision(Action.TACKLE, carrier.position);
    engine.actions.update(engine, DT);
    if (engine.ball.carrier === tackler) { taken = true; break; }
    if (events.length > 0) break;
  }
  assert(taken || events.length > 0, '유리한 조건에서도 태클이 한 번도 성립하지 않음');
});

test('사거리 밖에서는 태클이 실행되지 않는다', () => {
  const engine = makeEngine({ seed: 5 });
  const carrier = giveBall(engine, engine.homeTeam.players[9], new Vector2D(50, 34));
  const tackler = engine.awayTeam.players[3];
  tackler.position = new Vector2D(50 + TACKLE_RANGE + 2, 34);

  const events = [];
  engine.eventBus.on('tackle', (e) => events.push(e));
  engine.eventBus.on('tackleFailed', (e) => events.push(e));

  for (let i = 0; i < 60; i++) {
    tackler.tackleRecovery = 0;
    tackler.setDecision(Action.TACKLE, carrier.position);
    engine.actions.update(engine, DT);
  }
  assertEqual(events.length, 0, '사거리 밖에서 태클이 실행됨');
});

test('같은 팀에게는 태클하지 않는다', () => {
  const engine = makeEngine({ seed: 7 });
  const carrier = giveBall(engine, engine.homeTeam.players[9], new Vector2D(50, 34));
  const mate = engine.homeTeam.players[3];
  mate.position = new Vector2D(51, 34);

  const events = [];
  engine.eventBus.on('tackle', (e) => events.push(e));
  for (let i = 0; i < 30; i++) {
    mate.tackleRecovery = 0;
    mate.setDecision(Action.TACKLE, carrier.position);
    engine.actions.update(engine, DT);
  }
  assertEqual(events.length, 0, '같은 팀에게 태클함');
});

test('태클 후 회복 시간 동안 재시도하지 않는다', () => {
  const engine = makeEngine({ seed: 9 });
  const carrier = giveBall(engine, engine.homeTeam.players[9], new Vector2D(50, 34));
  const tackler = engine.awayTeam.players[3];
  tackler.position = new Vector2D(51.2, 34);

  let attempts = 0;
  engine.eventBus.on('tackle', () => attempts++);
  engine.eventBus.on('tackleFailed', () => attempts++);
  engine.eventBus.on('foulCommitted', () => attempts++);

  // 1초 동안 매 스텝 태클을 지시한다
  for (let i = 0; i < 60; i++) {
    tackler.setDecision(Action.TACKLE, carrier.position);
    engine.actions.update(engine, DT);
  }
  assert(attempts <= 2, `1초 동안 태클을 ${attempts}회 시도 — 회복 시간이 동작하지 않음`);
});

test('반칙은 규칙 엔진에 사건으로만 전달된다', () => {
  const engine = makeEngine({ seed: 12345 });
  const carrier = giveBall(engine, engine.homeTeam.players[9], new Vector2D(50, 34));
  carrier.velocity = new Vector2D(8, 0);
  const tackler = engine.awayTeam.players[3];
  // 등 뒤에서 빠르게 덤벼 반칙 위험을 높인다
  tackler.position = new Vector2D(48.5, 34);
  tackler.velocity = new Vector2D(9, 0);
  tackler.attributes.tackling = 15;

  const fouls = [];
  engine.eventBus.on('foulCommitted', (e) => fouls.push(e));

  for (let i = 0; i < 300; i++) {
    tackler.tackleRecovery = 0;
    tackler.setDecision(Action.TACKLE, carrier.position);
    engine.actions.update(engine, DT);
  }
  assert(fouls.length > 0, '반칙 위험이 높은 조건에서 반칙이 한 번도 발생하지 않음');
  // 반칙이 나도 경기 국면은 아직 바뀌지 않아야 한다 (규칙 엔진의 몫)
  assertEqual(engine.state.phase, Phase.IN_PLAY,
    '행동 시스템이 경기 국면을 직접 바꿈');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 8 — 패스 실행 오차');

test('패스 오차가 능력치에 따라 줄어든다', () => {
  const spread = (skill) => {
    const engine = makeEngine({ seed: 88 });
    const passer = giveBall(engine, engine.homeTeam.players[5], new Vector2D(40, 34));
    passer.attributes.passing = skill;
    passer.attributes.longPassing = skill;
    const receiver = engine.homeTeam.players[6];
    receiver.position = new Vector2D(60, 34);

    const planner = new PassPlanner(DT);
    const option = planner.plan(engine, passer);
    if (!option) return null;

    const angles = [];
    for (let i = 0; i < 300; i++) {
      const { angleError } = engine.actions._kickError(passer, option, engine.rng.pass);
      angles.push(angleError);
    }
    const mean = angles.reduce((a, b) => a + b, 0) / angles.length;
    const variance = angles.reduce((a, b) => a + (b - mean) ** 2, 0) / angles.length;
    return Math.sqrt(variance);
  };

  const good = spread(90);
  const poor = spread(25);
  assert(good !== null && poor !== null, '패스 후보가 없음');
  assert(good < poor, `능력치가 패스 오차에 반영되지 않음 (${good} vs ${poor})`);
  // 오차가 지나치게 크면 "가끔 엉뚱한 데로 차는" 엔진이 된다
  assert(poor < 0.12, `약한 선수의 각도 오차가 과도함 (${(poor * 180 / Math.PI).toFixed(1)}도)`);
});

test('실행된 패스가 계획된 방향에서 크게 벗어나지 않는다', () => {
  const engine = makeEngine({ seed: 202 });
  const passer = giveBall(engine, engine.homeTeam.players[5], new Vector2D(40, 34));
  passer.attributes.passing = 70;
  const receiver = engine.homeTeam.players[6];
  receiver.position = new Vector2D(62, 34);

  const planner = new PassPlanner(DT);
  const option = planner.plan(engine, passer);
  assert(option !== null, '패스 후보가 없음');

  passer.setDecision(Action.PASS, option.targetPosition, { payload: option });
  passer.touchCooldown = 0;
  engine.actions.update(engine, DT);

  const planned = option.solution.velocity.angle();
  const actual = engine.ball.velocity.angle();
  const diff = Math.abs(planned - actual);
  assert(diff < 0.15, `실행 방향이 계획에서 ${(diff * 180 / Math.PI).toFixed(1)}도 벗어남`);
  assertEqual(engine.ball.carrier, null, '패스했는데 캐리어가 남아 있음');
});

test('패스 이벤트가 발생한다', () => {
  const engine = makeEngine({ seed: 303 });
  const passer = giveBall(engine, engine.homeTeam.players[5], new Vector2D(40, 34));
  const receiver = engine.homeTeam.players[6];
  receiver.position = new Vector2D(58, 30);

  const events = [];
  engine.eventBus.on('pass', (e) => events.push(e));

  const planner = new PassPlanner(DT);
  const option = planner.plan(engine, passer);
  passer.setDecision(Action.PASS, option.targetPosition, { payload: option });
  passer.touchCooldown = 0;
  engine.actions.update(engine, DT);

  assertEqual(events.length, 1, '패스 이벤트가 발생하지 않음');
  assertEqual(events[0].from, passer);
  assertEqual(events[0].team, engine.homeTeam);
});
