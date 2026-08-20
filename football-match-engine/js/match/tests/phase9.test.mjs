import { suite, test, assert, assertEqual, assertClose, assertRange } from './_harness.mjs';

import { computeTeamShape } from '../tactics/TeamShape.js';
import { TacticalEngine } from '../tactics/TacticalEngine.js';
import { PossessionModel, PossessionState } from '../sim/PossessionModel.js';
import { MatchEngine } from '../core/MatchEngine.js';
import { Phase } from '../core/MatchState.js';
import { Player, Action } from '../entities/Player.js';
import { Team, PossessionPhase } from '../entities/Team.js';
import { Role, Line, Duty } from '../tactics/RoleModel.js';
import { teamNX, toTeamY } from '../core/Coords.js';
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

function makeEngine({ seed = 900, homeFormation = '4-4-2', awayFormation = '4-4-2' } = {}) {
  const engine = new MatchEngine({
    homeTeam: makeTeam('home', homeFormation),
    awayTeam: makeTeam('away', awayFormation),
    seed,
  });
  engine.install({
    possession: new PossessionModel(),
    tactical: new TacticalEngine(),
  });
  engine.setPhase(Phase.IN_PLAY);
  engine.allPlayers.forEach((p, i) => {
    p.position = new Vector2D(20 + (i % 11) * 6, 10 + (i % 5) * 12);
    p.velocity = Vector2D.zero();
    p.setDecision(Action.IDLE, null);
  });
  return engine;
}

/** 팀 형태를 계산한다 (소유 국면 지정) */
function shapeFor(team, ballPos, phase = PossessionPhase.OUT_OF_POSSESSION) {
  team.setPhase(phase);
  const ball = { position: ballPos };
  return computeTeamShape(team, ball);
}

// ════════════════════════════════════════════════════════════
suite('PHASE 9 — 팀 형태: 라인');

test('수비 라인은 볼보다 뒤에 선다', () => {
  const team = makeTeam('home'); // 공격 방향 +x, 자기 골문은 x=0
  for (const ballX of [20, 40, 60, 85]) {
    const shape = shapeFor(team, new Vector2D(ballX, 34));
    const ballNX = ballX / Pitch.LENGTH;
    assert(shape.backLineNX < ballNX,
      `볼 x=${ballX}일 때 수비 라인(${shape.backLineNX.toFixed(2)})이 볼(${ballNX.toFixed(2)})보다 앞섬`);
  }
});

test('볼이 전진하면 수비 라인도 올라간다', () => {
  const team = makeTeam('home');
  const deep = shapeFor(team, new Vector2D(20, 34));
  const high = shapeFor(team, new Vector2D(80, 34));
  assert(high.backLineNX > deep.backLineNX,
    '볼 위치에 따라 수비 라인이 움직이지 않음');
});

test('수비 라인 지시가 실제 라인 높이에 반영된다', () => {
  const low = makeTeam('home');
  low.tactics.defensiveLineHeight = 0;
  const high = makeTeam('home');
  high.tactics.defensiveLineHeight = 1;

  const a = shapeFor(low, new Vector2D(55, 34));
  const b = shapeFor(high, new Vector2D(55, 34));
  assert(b.backLineNX > a.backLineNX,
    `수비 라인 지시가 반영되지 않음 (${a.backLineNX.toFixed(2)} vs ${b.backLineNX.toFixed(2)})`);
});

test('라인 순서가 항상 유지된다 (후방 < 중원 < 전방)', () => {
  for (const formation of ['4-4-2', '4-3-3', '4-2-3-1']) {
    const team = makeTeam('home', formation);
    for (const ballX of [10, 30, 52, 75, 95]) {
      for (const phase of [PossessionPhase.IN_POSSESSION, PossessionPhase.OUT_OF_POSSESSION]) {
        const s = shapeFor(team, new Vector2D(ballX, 34), phase);
        assert(s.backLineNX < s.midLineNX && s.midLineNX < s.attackLineNX,
          `${formation} 볼x=${ballX} ${phase}: 라인 순서가 뒤집힘 ` +
          `(${s.backLineNX.toFixed(2)}/${s.midLineNX.toFixed(2)}/${s.attackLineNX.toFixed(2)})`);
      }
    }
  }
});

test('공격 시 팀이 길어지고 수비 시 압축된다', () => {
  const team = makeTeam('home');
  const attacking = shapeFor(team, new Vector2D(60, 34), PossessionPhase.IN_POSSESSION);
  const defending = shapeFor(team, new Vector2D(60, 34), PossessionPhase.OUT_OF_POSSESSION);
  assert(attacking.teamLength > defending.teamLength,
    `공격 시 팀 길이가 늘지 않음 (${attacking.teamLength.toFixed(1)} vs ${defending.teamLength.toFixed(1)})`);
});

test('팀 길이가 실제 축구 범위 안에 있다', () => {
  const team = makeTeam('home');
  for (const ballX of [15, 35, 55, 75, 95]) {
    for (const phase of [PossessionPhase.IN_POSSESSION, PossessionPhase.OUT_OF_POSSESSION]) {
      const s = shapeFor(team, new Vector2D(ballX, 34), phase);
      assertRange(s.teamLength, 25, 56, `볼x=${ballX} ${phase} 팀 길이`);
    }
  }
});

test('컴팩트니스 지시가 팀 길이를 줄인다', () => {
  const loose = makeTeam('home');
  loose.tactics.compactness = 0;
  const tight = makeTeam('home');
  tight.tactics.compactness = 1;

  const a = shapeFor(loose, new Vector2D(50, 34));
  const b = shapeFor(tight, new Vector2D(50, 34));
  assert(b.teamLength < a.teamLength, '컴팩트니스가 반영되지 않음');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 9 — 팀 형태: 폭과 볼 사이드');

test('수비 시 폭이 좁아진다', () => {
  const team = makeTeam('home');
  const attacking = shapeFor(team, new Vector2D(60, 34), PossessionPhase.IN_POSSESSION);
  const defending = shapeFor(team, new Vector2D(60, 34), PossessionPhase.OUT_OF_POSSESSION);
  assert(defending.teamWidth < attacking.teamWidth,
    `수비 시 폭이 좁아지지 않음 (${defending.teamWidth.toFixed(1)} vs ${attacking.teamWidth.toFixed(1)})`);
});

test('폭 지시가 반영된다', () => {
  const narrow = makeTeam('home');
  narrow.tactics.width = 0;
  const wide = makeTeam('home');
  wide.tactics.width = 1;

  const a = shapeFor(narrow, new Vector2D(50, 34), PossessionPhase.IN_POSSESSION);
  const b = shapeFor(wide, new Vector2D(50, 34), PossessionPhase.IN_POSSESSION);
  assert(b.teamWidth > a.teamWidth, '폭 지시가 반영되지 않음');
});

test('약측 선수가 볼 쪽으로 전부 몰리지 않는다', () => {
  // Section 11: 볼사이드는 크게 이동, 약측은 폭을 유지해야 한다
  const team = makeTeam('home');
  team.setPhase(PossessionPhase.OUT_OF_POSSESSION);

  const centered = computeTeamShape(team, { position: new Vector2D(50, 34) });
  const shifted = computeTeamShape(team, { position: new Vector2D(50, 8) }); // 볼이 위쪽 측면

  // 아래쪽(약측) 채널 선수를 찾는다
  const weakSide = team.players.filter((p) => (p.slot?.channel ?? 0) > 0.5);
  assert(weakSide.length > 0, '약측 선수를 찾지 못함');

  for (const p of weakSide) {
    const before = centered.anchors.get(p);
    const after = shifted.anchors.get(p);
    const movement = Math.abs(after.y - before.y);
    assert(movement < 12,
      `약측 선수 ${p.id}가 볼 쪽으로 ${movement.toFixed(1)}m나 이동함 (반대편이 비게 됨)`);
  }
});

test('볼사이드 선수는 볼 쪽으로 더 많이 이동한다', () => {
  const team = makeTeam('home');
  team.setPhase(PossessionPhase.OUT_OF_POSSESSION);
  const centered = computeTeamShape(team, { position: new Vector2D(50, 34) });
  const shifted = computeTeamShape(team, { position: new Vector2D(50, 8) });

  const ballSide = team.players.filter((p) => (p.slot?.channel ?? 0) < -0.5);
  const weakSide = team.players.filter((p) => (p.slot?.channel ?? 0) > 0.5);

  const move = (list) => list.reduce((sum, p) =>
    sum + Math.abs(shifted.anchors.get(p).y - centered.anchors.get(p).y), 0) / list.length;

  assert(move(ballSide) > move(weakSide),
    `볼사이드가 약측보다 더 움직이지 않음 (${move(ballSide).toFixed(1)} vs ${move(weakSide).toFixed(1)})`);
});

test('기대 위치가 경기장 안에 있다', () => {
  for (const side of ['home', 'away']) {
    const team = makeTeam(side);
    for (const ballPos of [new Vector2D(5, 3), new Vector2D(100, 65), new Vector2D(52, 34)]) {
      for (const phase of [PossessionPhase.IN_POSSESSION, PossessionPhase.OUT_OF_POSSESSION]) {
        const s = shapeFor(team, ballPos, phase);
        for (const [player, anchor] of s.anchors) {
          assertRange(anchor.x, 0, Pitch.LENGTH, `${side} ${player.id} anchor.x`);
          assertRange(anchor.y, 0, Pitch.WIDTH, `${side} ${player.id} anchor.y`);
        }
      }
    }
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 9 — 좌우 대칭성 (홈/원정 동일 동작)');

test('원정팀도 자기 골문 기준으로 라인을 세운다', () => {
  const home = makeTeam('home'); // 자기 골문 x=0
  const away = makeTeam('away'); // 자기 골문 x=105

  // 각 팀 기준으로 "볼이 자기 진영 깊숙이" 있는 상황
  const homeShape = shapeFor(home, new Vector2D(20, 34));
  const awayShape = shapeFor(away, new Vector2D(85, 34));

  // 팀 상대 좌표로는 같은 값이 나와야 한다
  assertClose(homeShape.backLineNX, awayShape.backLineNX, 1e-9,
    '홈/원정의 팀 상대 라인 높이가 다름');

  // 월드 좌표에서는 서로 반대편에 있어야 한다
  assert(homeShape.backLineX < Pitch.LENGTH / 2, '홈 수비 라인이 자기 진영에 없음');
  assert(awayShape.backLineX > Pitch.LENGTH / 2, '원정 수비 라인이 자기 진영에 없음');
});

test('원정팀 최전방이 상대 골문 쪽을 향한다', () => {
  const away = makeTeam('away');
  const shape = shapeFor(away, new Vector2D(50, 34), PossessionPhase.IN_POSSESSION);

  const forwards = away.players.filter((p) => p.slot?.line === Line.ATTACK);
  for (const p of forwards) {
    const anchor = shape.anchors.get(p);
    // 원정은 x가 작아지는 방향으로 공격한다
    assert(anchor.x < Pitch.LENGTH / 2 + 15,
      `원정 최전방 ${p.id}가 자기 진영 쪽(x=${anchor.x.toFixed(1)})에 있음`);
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 9 — 임무 배정: 유일성 보장');

/** 소유 상태를 강제로 세팅한다 */
function setPossession(engine, state, team, player = null) {
  engine.possession.state = state;
  engine.possession.team = team;
  engine.possession.player = player;
}

test('수비 시 압박자는 정확히 한 명이다', () => {
  const engine = makeEngine();
  engine.ball.placeAt(new Vector2D(50, 34));
  const carrier = engine.homeTeam.players[6];
  carrier.position = new Vector2D(50, 34);
  engine.ball.carrier = carrier;
  setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);

  engine.tactical.update(engine, engine.awayTeam, DT);

  const pressers = engine.awayTeam.players.filter((p) => p.duty === Duty.PRESS);
  assertEqual(pressers.length, 1, `압박자가 ${pressers.length}명 — 정확히 1명이어야 함`);
  assertEqual(engine.awayTeam.assignment.presser, pressers[0]);
});

test('수비 시 커버도 정확히 한 명이다', () => {
  const engine = makeEngine();
  engine.ball.placeAt(new Vector2D(50, 34));
  const carrier = engine.homeTeam.players[6];
  carrier.position = new Vector2D(50, 34);
  engine.ball.carrier = carrier;
  setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);

  engine.tactical.update(engine, engine.awayTeam, DT);
  const covers = engine.awayTeam.players.filter((p) => p.duty === Duty.COVER);
  assertEqual(covers.length, 1, `커버가 ${covers.length}명`);
});

test('전원이 볼을 쫓지 않는다', () => {
  const engine = makeEngine();
  engine.ball.placeAt(new Vector2D(50, 34));
  const carrier = engine.homeTeam.players[6];
  carrier.position = new Vector2D(50, 34);
  engine.ball.carrier = carrier;
  setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);

  engine.tactical.update(engine, engine.awayTeam, DT);

  const chasing = engine.awayTeam.players.filter(
    (p) => p.duty === Duty.PRESS || p.duty === Duty.CHASE_LOOSE
  );
  assert(chasing.length <= 1, `${chasing.length}명이 동시에 볼로 달려감 (동네축구)`);

  // 나머지는 마크나 라인 유지를 맡아야 한다
  const structured = engine.awayTeam.players.filter(
    (p) => p.duty === Duty.MARK || p.duty === Duty.HOLD_LINE || p.duty === Duty.COVER
  );
  assert(structured.length >= 7, `구조를 유지하는 선수가 ${structured.length}명뿐`);
});

test('루즈볼은 팀당 한 명만 쫓는다', () => {
  const engine = makeEngine();
  engine.ball.placeAt(new Vector2D(52, 34));
  setPossession(engine, PossessionState.LOOSE, null);

  for (const team of engine.teams) {
    engine.tactical.update(engine, team, DT);
    const chasers = team.players.filter((p) => p.duty === Duty.CHASE_LOOSE);
    assertEqual(chasers.length, 1, `${team.side}: 루즈볼 추격자가 ${chasers.length}명`);
  }
});

test('제쳐진 수비수에게는 압박을 맡기지 않는다', () => {
  const engine = makeEngine();
  engine.ball.placeAt(new Vector2D(50, 34));
  const carrier = engine.homeTeam.players[6];
  carrier.position = new Vector2D(50, 34);
  engine.ball.carrier = carrier;
  setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);

  // 볼에 가장 가까운 원정 선수를 제쳐진 상태로 만든다
  const nearest = engine.awayTeam.players
    .filter((p) => p.role !== Role.GK)
    .sort((a, b) => a.position.sub(engine.ball.position).length() - b.position.sub(engine.ball.position).length())[0];
  nearest.beatenTimer = 1.0;

  engine.tactical.update(engine, engine.awayTeam, DT);
  assert(engine.awayTeam.assignment.presser !== nearest,
    '제쳐진 수비수가 압박자로 뽑힘');
});

test('마크 대상이 중복 배정되지 않는다', () => {
  const engine = makeEngine();
  engine.ball.placeAt(new Vector2D(50, 34));
  const carrier = engine.homeTeam.players[6];
  carrier.position = new Vector2D(50, 34);
  engine.ball.carrier = carrier;
  setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);

  engine.tactical.update(engine, engine.awayTeam, DT);

  const targets = [...engine.awayTeam.assignment.marks.values()];
  assertEqual(new Set(targets).size, targets.length, '같은 상대를 여러 명이 마크함');
});

// ════════════════════════════════════════════════════════════
suite('PHASE 9 — 임무 배정: 공격');

test('소유 중에는 폭을 유지하는 선수가 존재한다', () => {
  const engine = makeEngine();
  const carrier = engine.homeTeam.players[6];
  carrier.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50, 34));
  engine.ball.carrier = carrier;
  engine.homeTeam.setPhase(PossessionPhase.IN_POSSESSION);
  setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);

  engine.tactical.update(engine, engine.homeTeam, DT);

  const wide = engine.homeTeam.players.filter((p) => p.duty === Duty.HOLD_WIDTH);
  assert(wide.length >= 1, '폭을 유지하는 선수가 없음 — 공격이 중앙으로만 쏠린다');
});

test('공격 중에도 후방 잔류 인원이 남는다', () => {
  const engine = makeEngine();
  const carrier = engine.homeTeam.players[9];
  carrier.position = new Vector2D(75, 34);
  engine.ball.placeAt(new Vector2D(75, 34));
  engine.ball.carrier = carrier;
  engine.homeTeam.setPhase(PossessionPhase.IN_POSSESSION);
  setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);

  engine.tactical.update(engine, engine.homeTeam, DT);
  const rest = engine.homeTeam.players.filter((p) => p.duty === Duty.REST_DEFENCE);
  assert(rest.length >= 1, '레스트 디펜스가 없음 — 역습에 무방비');
});

test('공격적 멘탈리티는 후방 잔류를 줄인다', () => {
  const countRest = (mentality) => {
    const engine = makeEngine();
    engine.homeTeam.tactics.mentality = mentality;
    const carrier = engine.homeTeam.players[9];
    carrier.position = new Vector2D(70, 34);
    engine.ball.placeAt(new Vector2D(70, 34));
    engine.ball.carrier = carrier;
    engine.homeTeam.setPhase(PossessionPhase.IN_POSSESSION);
    setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);
    engine.tactical.update(engine, engine.homeTeam, DT);
    return engine.homeTeam.players.filter((p) => p.duty === Duty.REST_DEFENCE).length;
  };
  assert(countRest('attacking') <= countRest('defensive'),
    '멘탈리티가 후방 잔류 인원에 반영되지 않음');
});

test('임무가 매 틱 흔들리지 않는다', () => {
  const engine = makeEngine();
  const carrier = engine.homeTeam.players[6];
  carrier.position = new Vector2D(50, 34);
  engine.ball.placeAt(new Vector2D(50, 34));
  engine.ball.carrier = carrier;
  setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);

  engine.tactical.update(engine, engine.awayTeam, DT);
  const first = new Map(engine.awayTeam.players.map((p) => [p, p.duty]));

  let changes = 0;
  for (let i = 0; i < 20; i++) {
    engine.tactical.update(engine, engine.awayTeam, DT);
    for (const p of engine.awayTeam.players) {
      if (first.get(p) !== p.duty) changes++;
    }
  }
  assert(changes < 20, `임무가 ${changes}회 흔들림 — 플래핑`);
});

// ════════════════════════════════════════════════════════════
suite('PHASE 9 — 골키퍼 위치');

test('골키퍼는 자기 골문 앞에 선다', () => {
  for (const side of ['home', 'away']) {
    const team = makeTeam(side);
    const goalX = side === 'home' ? 0 : Pitch.LENGTH;
    const shape = shapeFor(team, new Vector2D(52, 34));
    const gk = team.goalkeeper;
    const anchor = shape.anchors.get(gk);
    const distance = Math.abs(anchor.x - goalX);
    assertRange(distance, 0, 20, `${side} 골키퍼 골문 거리`);
  }
});

test('볼이 다가오면 골키퍼가 각을 좁히러 나온다', () => {
  const team = makeTeam('home');
  const far = shapeFor(team, new Vector2D(80, 34));
  const near = shapeFor(team, new Vector2D(18, 34));
  const gk = team.goalkeeper;
  assert(near.anchors.get(gk).x > far.anchors.get(gk).x,
    '볼이 가까워져도 골키퍼가 나오지 않음');
});

test('골키퍼가 골문 폭을 크게 벗어나지 않는다', () => {
  const team = makeTeam('home');
  const [top, bottom] = Pitch.goalYRange();
  for (const ballY of [2, 20, 34, 50, 66]) {
    const shape = shapeFor(team, new Vector2D(25, ballY));
    const y = shape.anchors.get(team.goalkeeper).y;
    assertRange(y, top - 4, bottom + 4, `볼 y=${ballY}일 때 골키퍼 y`);
  }
});

// ════════════════════════════════════════════════════════════
suite('PHASE 9 — 결정론');

test('같은 상황은 같은 형태와 임무를 만든다', () => {
  const run = () => {
    const engine = makeEngine({ seed: 1357 });
    const carrier = engine.homeTeam.players[6];
    carrier.position = new Vector2D(48, 28);
    engine.ball.placeAt(new Vector2D(48, 28));
    engine.ball.carrier = carrier;
    setPossession(engine, PossessionState.DEFINITE, engine.homeTeam, carrier);

    for (const team of engine.teams) engine.tactical.update(engine, team, DT);

    return engine.allPlayers
      .map((p) => `${p.id}:${p.duty}:${p.anchor.x.toFixed(6)},${p.anchor.y.toFixed(6)}`)
      .join('|');
  };
  assertEqual(run(), run(), '같은 상황에서 형태·임무가 달라짐');
});
