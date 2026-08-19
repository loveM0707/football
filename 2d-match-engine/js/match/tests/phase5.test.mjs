import { suite, test, assert, assertEqual, assertClose, assertRange } from './_harness.mjs';

import { MovementEngine } from '../sim/MovementEngine.js';
import { Player, Action } from '../entities/Player.js';
import { Team } from '../entities/Team.js';
import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';

const DT = 1 / 60;

/** 단일 선수 + 이동 엔진을 갖춘 최소 환경 */
function makeSolo(attrs = {}, start = new Vector2D(50, 34)) {
  const players = [];
  for (let i = 0; i < 11; i++) {
    players.push(new Player({ id: `p${i}`, name: `p${i}`, number: i + 1, attributes: attrs }));
  }
  const team = new Team({ name: 'T', side: 'home', color: '#000', players });
  const player = players[0];
  player.position = start.clone();

  // 나머지 선수는 멀리 치워 신체 충돌이 테스트에 끼어들지 않게 한다
  players.slice(1).forEach((p, i) => {
    p.position = new Vector2D(-50 - i * 3, -50);
  });

  const engine = { allPlayers: players };
  const movement = new MovementEngine();
  return { player, players, engine, movement, team };
}

/** n스텝 진행 */
function run(movement, engine, steps) {
  for (let i = 0; i < steps; i++) movement.update(engine, DT);
}

// ════════════════════════════════════════════════════════════
suite('PHASE 5 — 가속과 감속');

test('정지 상태에서 즉시 최고 속도가 되지 않는다', () => {
  const { player, engine, movement } = makeSolo({ pace: 80, acceleration: 80 });
  player.setDecision(Action.MOVE, new Vector2D(90, 34), { sprint: true });

  movement.update(engine, DT);
  const afterOneStep = player.velocity.length();
  assert(afterOneStep < player.maxSpeed * 0.25,
    `한 스텝 만에 속도가 ${afterOneStep.toFixed(2)} m/s까지 올랐음 (입자처럼 움직임)`);
});

test('가속 능력치가 높을수록 빨리 최고 속도에 도달한다', () => {
  const timeToTopSpeed = (accel) => {
    const { player, engine, movement } = makeSolo({ pace: 75, acceleration: accel });
    player.setDecision(Action.MOVE, new Vector2D(100, 34), { sprint: true });
    const target = player.maxSpeed * 0.95;
    for (let i = 0; i < 60 * 10; i++) {
      movement.update(engine, DT);
      if (player.velocity.length() >= target) return i * DT;
    }
    return Infinity;
  };
  const slow = timeToTopSpeed(30);
  const fast = timeToTopSpeed(90);
  assert(fast < slow, `가속 능력치가 반영되지 않음 (${fast}s vs ${slow}s)`);
  // 실제 선수는 최고 속도까지 대략 2~5초가 걸린다
  assertRange(fast, 1.0, 4.0, '가속이 빠른 선수의 최고속 도달 시간');
});

test('최고 속도 상한을 넘지 않는다', () => {
  const { player, engine, movement } = makeSolo({ pace: 90, acceleration: 90 });
  player.setDecision(Action.MOVE, new Vector2D(104, 34), { sprint: true });
  for (let i = 0; i < 60 * 8; i++) {
    movement.update(engine, DT);
    assert(player.velocity.length() <= player.maxSpeed + 1e-6,
      `최고 속도 초과: ${player.velocity.length()}`);
  }
});

test('목표에 도착하면 지나치지 않고 멈춘다', () => {
  const target = new Vector2D(70, 34);
  const { player, engine, movement } = makeSolo({ pace: 85, acceleration: 85 }, new Vector2D(40, 34));
  player.setDecision(Action.MOVE, target, { sprint: true });

  let maxOvershoot = 0;
  for (let i = 0; i < 60 * 15; i++) {
    movement.update(engine, DT);
    maxOvershoot = Math.max(maxOvershoot, player.position.x - target.x);
  }

  assert(maxOvershoot < 0.6, `목표를 ${maxOvershoot.toFixed(2)}m 지나침`);
  assert(player.position.sub(target).length() < 0.5, '목표에 도달하지 못함');
  assertClose(player.velocity.length(), 0, 0.1, '목표에서 멈추지 않음');
});

test('목표 주위에서 진동하지 않는다', () => {
  const target = new Vector2D(60, 34);
  const { player, engine, movement } = makeSolo({ pace: 90, acceleration: 90 }, new Vector2D(45, 34));
  player.setDecision(Action.MOVE, target, { sprint: true });

  run(movement, engine, 60 * 10);
  // 도착 후 충분한 시간이 지나면 완전히 정지해 있어야 한다
  const posBefore = player.position.clone();
  run(movement, engine, 60 * 2);
  assert(player.position.sub(posBefore).length() < 0.05,
    '도착 후에도 계속 미세하게 움직임 (진동)');
});

test('urgency가 낮으면 천천히 움직인다', () => {
  const speedAt = (urgency, sprint) => {
    const { player, engine, movement } = makeSolo({ pace: 80, acceleration: 80 });
    player.setDecision(Action.MOVE, new Vector2D(100, 34), { urgency, sprint });
    run(movement, engine, 60 * 6);
    return player.velocity.length();
  };
  const walk = speedAt(0, false);
  const jog = speedAt(0.5, false);
  const sprint = speedAt(1, true);
  assert(walk < jog && jog < sprint,
    `속도 단계가 구분되지 않음 (${walk.toFixed(2)} / ${jog.toFixed(2)} / ${sprint.toFixed(2)})`);
  assertRange(walk, 2.0, 4.5, '걷기 속도');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 5 — 선회 (사람다운 움직임의 핵심)');

test('전속력에서 즉시 방향을 꺾지 못한다', () => {
  const { player, engine, movement } = makeSolo({ pace: 85, acceleration: 85, agility: 60 });

  // 먼저 +x 방향으로 전속력까지 가속
  player.setDecision(Action.MOVE, new Vector2D(104, 34), { sprint: true });
  run(movement, engine, 60 * 5);
  const topSpeed = player.velocity.length();
  assert(topSpeed > 6, '가속이 충분하지 않아 테스트가 무의미함');

  // 갑자기 반대 방향(-x)으로 목표 변경
  player.setDecision(Action.MOVE, new Vector2D(0, 34), { sprint: true });
  movement.update(engine, DT);

  // 한 스텝 만에 속도 방향이 뒤집히면 안 된다
  assert(player.velocity.x > 0,
    '한 스텝 만에 진행 방향이 반전됨 (관성이 없음)');
});

test('빠를수록 회전 반경이 커진다', () => {
  // 직각으로 방향을 틀 때, 속도가 빠르면 더 크게 돌아야 한다
  const turnRadius = (approachSteps) => {
    const { player, engine, movement } = makeSolo(
      { pace: 85, acceleration: 85, agility: 60 }, new Vector2D(30, 34)
    );
    player.setDecision(Action.MOVE, new Vector2D(104, 34), { sprint: true });
    run(movement, engine, approachSteps);

    const entrySpeed = player.velocity.length();
    // 90도 꺾어 +y 방향으로
    player.setDecision(Action.MOVE, new Vector2D(player.position.x, 68), { sprint: true });

    const startY = player.position.y;
    let maxXDrift = 0;
    const startX = player.position.x;
    for (let i = 0; i < 60 * 3; i++) {
      movement.update(engine, DT);
      maxXDrift = Math.max(maxXDrift, player.position.x - startX);
      if (player.position.y - startY > 12) break;
    }
    return { entrySpeed, drift: maxXDrift };
  };

  const slow = turnRadius(12);   // 아직 느릴 때
  const fast = turnRadius(60 * 5); // 전속력일 때

  assert(fast.entrySpeed > slow.entrySpeed * 1.5, '두 경우의 속도 차이가 충분하지 않음');
  assert(fast.drift > slow.drift * 1.5,
    `속도가 빨라도 회전 반경이 커지지 않음 (느림 ${slow.drift.toFixed(1)}m, 빠름 ${fast.drift.toFixed(1)}m)`);
});

test('민첩성이 높으면 더 날카롭게 돈다', () => {
  const drift = (agility) => {
    const { player, engine, movement } = makeSolo(
      { pace: 85, acceleration: 85, agility }, new Vector2D(30, 34)
    );
    player.setDecision(Action.MOVE, new Vector2D(104, 34), { sprint: true });
    run(movement, engine, 60 * 5);

    player.setDecision(Action.MOVE, new Vector2D(player.position.x, 68), { sprint: true });
    const startX = player.position.x;
    const startY = player.position.y;
    let maxDrift = 0;
    for (let i = 0; i < 60 * 3; i++) {
      movement.update(engine, DT);
      maxDrift = Math.max(maxDrift, player.position.x - startX);
      if (player.position.y - startY > 12) break;
    }
    return maxDrift;
  };

  assert(drift(90) < drift(25),
    '민첩성이 회전 반경에 반영되지 않음');
});

test('궤적이 급격히 꺾이지 않고 이어진다', () => {
  const { player, engine, movement } = makeSolo({ pace: 80, acceleration: 80, agility: 55 });
  player.setDecision(Action.MOVE, new Vector2D(100, 34), { sprint: true });
  run(movement, engine, 60 * 4);

  // 매 스텝 속도 방향 변화가 물리적 한계 안에 있어야 한다
  player.setDecision(Action.MOVE, new Vector2D(20, 60), { sprint: true });
  let prevAngle = player.velocity.angle();
  let maxTurnPerStep = 0;
  for (let i = 0; i < 60 * 3; i++) {
    movement.update(engine, DT);
    if (player.velocity.length() < 0.5) break;
    const angle = player.velocity.angle();
    let d = Math.abs(angle - prevAngle);
    if (d > Math.PI) d = Math.PI * 2 - d;
    maxTurnPerStep = Math.max(maxTurnPerStep, d);
    prevAngle = angle;
  }
  // 1/60초에 30도 이상 꺾이면 비현실적
  assert(maxTurnPerStep < Math.PI / 6,
    `한 스텝에 ${(maxTurnPerStep * 180 / Math.PI).toFixed(1)}도 회전 — 너무 급격함`);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 5 — 신체 방향');

test('몸은 진행 방향을 따라간다', () => {
  const { player, engine, movement } = makeSolo({ agility: 70 });
  player.position = new Vector2D(50, 34);
  player.setDecision(Action.MOVE, new Vector2D(50, 68), { sprint: true });
  run(movement, engine, 60 * 3);

  // +y 방향 = 각도 π/2
  const diff = Math.abs(player.facingAngle - Math.PI / 2);
  assert(diff < 0.25, `몸이 진행 방향을 향하지 않음 (${player.facingAngle.toFixed(2)} rad)`);
});

test('몸의 방향 전환에도 한계가 있다', () => {
  const { player, engine, movement } = makeSolo({ agility: 50 });
  player.facingAngle = 0;
  player.setDecision(Action.MOVE, new Vector2D(50, 68), { sprint: true });

  movement.update(engine, DT);
  // 한 스텝(1/60초) 만에 90도를 돌 수는 없다
  assert(Math.abs(player.facingAngle) < Math.PI / 3,
    `한 스텝에 몸이 ${(player.facingAngle * 180 / Math.PI).toFixed(0)}도 돌아감`);
});

test('신체 각도가 무한히 누적되지 않는다', () => {
  const { player, engine, movement } = makeSolo({ agility: 80 });
  // 목표를 계속 회전시키며 여러 바퀴 돌게 한다
  for (let i = 0; i < 60 * 30; i++) {
    const angle = (i / 60) * 2;
    player.setDecision(Action.MOVE,
      player.position.add(Vector2D.fromAngle(angle, 10)), { sprint: true });
    movement.update(engine, DT);
    assert(Math.abs(player.facingAngle) <= Math.PI + 1e-9,
      `각도가 정규화되지 않음: ${player.facingAngle}`);
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 5 — 경계와 충돌');

test('선수가 경기장 밖으로 멀리 벗어나지 않는다', () => {
  const { player, engine, movement } = makeSolo({ pace: 90, acceleration: 90 });
  player.setDecision(Action.MOVE, new Vector2D(500, 500), { sprint: true });
  run(movement, engine, 60 * 20);

  assert(player.position.x <= Pitch.LENGTH + 3.1, `x가 경기장을 크게 벗어남: ${player.position.x}`);
  assert(player.position.y <= Pitch.WIDTH + 3.1, `y가 경기장을 크게 벗어남: ${player.position.y}`);
});

test('선수들이 같은 자리에 겹치지 않는다', () => {
  const { players, engine, movement } = makeSolo();
  // 전원을 한 점에 모아놓고 분리되는지 본다
  for (const p of players) {
    p.position = new Vector2D(50, 34);
    p.setDecision(Action.IDLE, null);
  }
  run(movement, engine, 60);

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const d = players[i].position.sub(players[j].position).length();
      assert(d > 0.5, `선수 ${i}와 ${j}가 ${d.toFixed(2)}m로 겹쳐 있음`);
    }
  }
});

test('겹침 해소가 결정론적이다', () => {
  const snapshot = () => {
    const { players, engine, movement } = makeSolo();
    for (const p of players) {
      p.position = new Vector2D(50, 34);
      p.setDecision(Action.IDLE, null);
    }
    run(movement, engine, 30);
    return players.map((p) => `${p.position.x.toFixed(6)},${p.position.y.toFixed(6)}`).join('|');
  };
  assertEqual(snapshot(), snapshot(), '같은 초기 조건에서 결과가 달라짐');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 5 — 볼 소유와 체력');

test('볼을 몰면 느려진다', () => {
  const topSpeed = (hasBall) => {
    const { player, engine, movement } = makeSolo({ pace: 80, acceleration: 80, dribbling: 60 });
    player.hasBall = hasBall;
    player.setDecision(Action.MOVE, new Vector2D(104, 34), { sprint: true });
    run(movement, engine, 60 * 6);
    return player.velocity.length();
  };
  const free = topSpeed(false);
  const carrying = topSpeed(true);
  assert(carrying < free * 0.95,
    `볼을 몰아도 속도가 그대로임 (${carrying.toFixed(2)} vs ${free.toFixed(2)})`);
});

test('드리블 능력이 높으면 볼을 몰고도 빠르다', () => {
  const carrySpeed = (dribbling) => {
    const { player, engine, movement } = makeSolo({ pace: 80, acceleration: 80, dribbling });
    player.hasBall = true;
    player.setDecision(Action.MOVE, new Vector2D(104, 34), { sprint: true });
    run(movement, engine, 60 * 6);
    return player.velocity.length();
  };
  assert(carrySpeed(90) > carrySpeed(30), '드리블 능력이 캐리 속도에 반영되지 않음');
});

test('스프린트를 지속하면 체력이 줄어든다', () => {
  const { player, engine, movement } = makeSolo({ pace: 80, acceleration: 80, stamina: 55 });
  const before = player.energy;

  // 목표에 도착해 쉬어버리면 체력이 회복되므로, 계속 달리도록 왕복시킨다
  for (let i = 0; i < 60 * 300; i++) {
    const goRight = Math.floor(i / (60 * 10)) % 2 === 0;
    player.setDecision(Action.MOVE, new Vector2D(goRight ? 100 : 5, 34), { sprint: true });
    movement.update(engine, DT);
  }

  assert(player.energy < before, '체력이 전혀 줄지 않음');
  assert(player.energy > 0.3, `5분 만에 체력이 과도하게 고갈됨 (${player.energy.toFixed(2)})`);
});

test('쉬면 체력이 회복된다', () => {
  const { player, engine, movement } = makeSolo({ stamina: 60 });
  player.energy = 0.5;
  player.setDecision(Action.IDLE, null);
  run(movement, engine, 60 * 120); // 2분간 정지
  assert(player.energy > 0.5, '정지 상태인데 체력이 회복되지 않음');
  assert(player.energy <= 1, '체력이 상한을 넘음');
});

test('90분 경기 강도에서 체력이 현실적으로 남는다', () => {
  // 평균 강도(약 0.55)로 90분을 뛰면 절반 남짓 남아야 한다
  const player = new Player({ id: 'x', name: 'x', number: 1, attributes: { stamina: 60 } });
  for (let i = 0; i < 90 * 60 * 60; i++) player.updateEnergy(DT, 0.55);
  assertRange(player.energy, 0.45, 0.85, '90분 후 잔여 체력');
});

test('IDLE 상태에서는 움직이지 않는다', () => {
  const { player, engine, movement } = makeSolo();
  const start = player.position.clone();
  player.setDecision(Action.IDLE, null);
  run(movement, engine, 60 * 5);
  assertClose(player.position.sub(start).length(), 0, 1e-9, 'IDLE인데 움직임');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 5 — 결정론');

test('같은 초기 조건은 같은 궤적을 만든다', () => {
  const trace = () => {
    const { player, engine, movement } = makeSolo({ pace: 78, acceleration: 66, agility: 71 });
    const out = [];
    for (let i = 0; i < 300; i++) {
      const angle = (i / 60) * 1.7;
      player.setDecision(Action.MOVE,
        new Vector2D(50 + Math.cos(angle) * 25, 34 + Math.sin(angle) * 18), { sprint: true });
      movement.update(engine, DT);
      out.push(`${player.position.x.toFixed(9)},${player.position.y.toFixed(9)}`);
    }
    return out.join('|');
  };
  assertEqual(trace(), trace(), '같은 입력에서 궤적이 달라짐');
});
