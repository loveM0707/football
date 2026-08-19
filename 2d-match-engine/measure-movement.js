// 측정 하니스 — 현재 이동 시스템의 실제 목표 좌표를 계측한다.
// 사용법: node measure-movement.js
// (설계 목적: 리포팅 전 "현재 동작"을 숫자로 확보하고, 수정 후 회귀 확인용)

import { Player } from './js/entities/Player.js';
import { Team } from './js/entities/Team.js';
import { Pitch } from './js/entities/Pitch.js';
import { MatchSimulator } from './js/core/MatchSimulator.js';
import { computeDefensiveSupport } from './js/ai/OffTheBallMovement.js';
import { computeDefensiveTarget } from './js/ai/Defending.js';
import { EventBus } from './js/core/EventBus.js';

const ROLE_ORDER = ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'];

function rand(base, spread) {
  return Math.round(base + (Math.random() - 0.5) * 2 * spread);
}

const ROLE_ATTR_PRESETS = {
  GK: { pace: 55, acceleration: 55, tackling: 40, passing: 55, shooting: 20, dribbling: 40, strength: 65, positioning: 75, reflexes: 78, vision: 70, agility: 45, interception: 20, passSpeed: 65, shotSpeed: 50, decisionMaking: 72, power: 62, physical: 60 },
  LB: { pace: 77, acceleration: 76, tackling: 72, passing: 68, shooting: 45, dribbling: 65, strength: 68, positioning: 68, reflexes: 40, vision: 62, agility: 74, interception: 68, passSpeed: 66, shotSpeed: 52, decisionMaking: 65, power: 70, physical: 68 },
  RB: { pace: 77, acceleration: 76, tackling: 72, passing: 68, shooting: 45, dribbling: 65, strength: 68, positioning: 68, reflexes: 40, vision: 62, agility: 74, interception: 68, passSpeed: 66, shotSpeed: 52, decisionMaking: 65, power: 70, physical: 68 },
  CB: { pace: 64, acceleration: 60, tackling: 80, passing: 62, shooting: 35, dribbling: 48, strength: 82, positioning: 78, reflexes: 40, vision: 58, agility: 53, interception: 78, passSpeed: 60, shotSpeed: 48, decisionMaking: 68, power: 82, physical: 85 },
  LM: { pace: 82, acceleration: 80, tackling: 55, passing: 74, shooting: 60, dribbling: 78, strength: 58, positioning: 65, reflexes: 40, vision: 72, agility: 80, interception: 48, passSpeed: 74, shotSpeed: 70, decisionMaking: 70, power: 58, physical: 56 },
  RM: { pace: 82, acceleration: 80, tackling: 55, passing: 74, shooting: 60, dribbling: 78, strength: 58, positioning: 65, reflexes: 40, vision: 72, agility: 80, interception: 48, passSpeed: 74, shotSpeed: 70, decisionMaking: 70, power: 58, physical: 56 },
  CM: { pace: 68, acceleration: 66, tackling: 65, passing: 80, shooting: 58, dribbling: 70, strength: 65, positioning: 72, reflexes: 40, vision: 80, agility: 66, interception: 55, passSpeed: 80, shotSpeed: 64, decisionMaking: 82, power: 65, physical: 64 },
  ST: { pace: 76, acceleration: 78, tackling: 35, passing: 60, shooting: 82, dribbling: 83, strength: 70, positioning: 74, reflexes: 40, vision: 68, agility: 74, interception: 30, passSpeed: 65, shotSpeed: 84, decisionMaking: 72, power: 72, physical: 80 },
};

function buildRoster(prefix, spread) {
  return ROLE_ORDER.map((role, idx) => {
    const preset = ROLE_ATTR_PRESETS[role];
    const attributes = Object.fromEntries(
      Object.entries(preset).map(([k, v]) => [k, Math.max(20, Math.min(99, rand(v, spread)))])
    );
    return new Player({ name: `${prefix} ${idx + 1}`, number: idx + 1, role, attributes });
  });
}

function makeTeam(name, side, formationName, tacticsOptions) {
  return new Team({ name, side, color: '#fff', formationName, players: buildRoster(name, 6), tacticsOptions });
}

const DT = 0.016;
const L = Pitch.LENGTH;
const H = Pitch.WIDTH;

function setBall(ball, x, y) {
  ball.position.x = x;
  ball.position.y = y;
  ball.velocity.x = 0;
  ball.velocity.y = 0;
  ball.owner = null;
  ball.height = 0;
}

function giveBall(ball, player) {
  ball.owner = player;
  player.hasBall = true;
  ball.velocity.x = 0;
  ball.velocity.y = 0;
  ball.height = 0;
}

function clearAllBall(team) {
  team.players.forEach((p) => (p.hasBall = false));
}

// 측정 간 팀 상태 초기화 — 이전 시나리오의 잔여 상태가 다음 측정을 오염하지 않도록
function resetTeamState(team) {
  team._possGrace = 0;
  team._tacticalPossession = undefined;
  team._pressers = null;
  team._lineIsolated = false;
  team._counterPressTimer = 0;
  team._gridTimer = 0;
  team._spaceGrid = null;
  team._reservations = null;
  team._mc_len = undefined;
  for (const p of team.players) {
    const mem = p.brainMemory;
    mem.offBallMode = null;
    mem.offBallModeTarget = null;
    mem.offBallTarget = null;
    mem.commitTimer = 0;
    mem.justPassedTimer = 0;
    mem.defendBehavior = null;
    mem.pressTarget = null;
  }
}

// ── 공격 측정: 각 역할의 최종 오프볼 목표 X를 mc.update로 읽는다 ──
function measureAttack(homeTeam, awayTeam, sim, ballX, ballY) {
  const ball = sim.ball;
  clearAllBall(homeTeam);
  clearAllBall(awayTeam);
  resetTeamState(homeTeam);
  resetTeamState(awayTeam);
  // 소유자: 홈 ST (비수신자만 측정)
  const holder = homeTeam.players.find((p) => p.role === 'ST' && p.name.endsWith('11'));
  setBall(ball, ballX, ballY);
  holder.position.x = ballX;
  holder.position.y = ballY - 8;
  giveBall(ball, holder);

  const mc = sim._homeMC;
  const out = homeTeam.players.filter((p) => p !== holder && p.role !== 'GK');
  // 정상 상태 측정: 클램프(팀 길이)가 후방 라인 위치에 의존하므로,
  // 선수들을 목표로 부드럽게 수렴시켜 블록이 실제로 전진한 뒤 목표를 읽는다.
  for (let iter = 0; iter < 18; iter++) {
    mc.refreshRoles(homeTeam, awayTeam, ball, DT); // 팀 점유 상태를 틱당 1회 확정
    for (const p of out) {
      mc.update(p, homeTeam, awayTeam, ball, DT);
      const t = p.brainMemory.offBallTarget;
      if (t) {
        p.position.x += (t.x - p.position.x) * 0.6;
        p.position.y += (t.y - p.position.y) * 0.6;
      }
    }
  }
  const rows = [];
  for (const p of out) {
    mc.update(p, homeTeam, awayTeam, ball, DT);
    const t = p.brainMemory.offBallTarget;
    const x = t ? Math.round(t.x) : null;
    const y = t ? Math.round(t.y) : null;
    rows.push({ role: p.role, mode: p.brainMemory.offBallMode ?? '-', tx: x, ty: y });
  }
  // 소유자 복구
  holder.hasBall = false;
  ball.owner = null;
  return rows;
}

// ── 수비 측정: computeDefensiveSupport + computeDefensiveTarget 최종 목표 X ──
function measureDefense(homeTeam, awayTeam, sim, ballX, ballY) {
  const ball = sim.ball;
  clearAllBall(homeTeam);
  clearAllBall(awayTeam);
  resetTeamState(homeTeam);
  resetTeamState(awayTeam);
  const carrier = awayTeam.players.find((p) => p.role === 'ST' && p.name.endsWith('11'));
  setBall(ball, ballX, ballY);
  carrier.position.x = ballX;
  carrier.position.y = ballY;
  giveBall(ball, carrier);

  const mc = sim._homeMC;
  const out = homeTeam.players.filter((p) => p.role !== 'GK');
  mc.refreshRoles(homeTeam, awayTeam, ball, DT); // 팀 점유 상태를 틱당 1회 확정
  const rows = [];
  for (const p of out) {
    mc.update(p, homeTeam, awayTeam, ball, DT); // brainMemory 등 초기화
    const baseTarget = computeDefensiveSupport({ player: p, team: homeTeam, opponentTeam: awayTeam, ball });
    const def = computeDefensiveTarget({ player: p, team: homeTeam, opponentTeam: awayTeam, ball, baseTarget });
    const t = def.target;
    rows.push({ role: p.role, tx: Math.round(t.x), ty: Math.round(t.y) });
  }
  carrier.hasBall = false;
  ball.owner = null;
  return rows;
}

function table(label, rows) {
  console.log(`\n== ${label} ==`);
  const byRole = {};
  for (const r of rows) {
    if (!byRole[r.role]) byRole[r.role] = [];
    byRole[r.role].push(r);
  }
  for (const [role, list] of Object.entries(byRole)) {
    for (const r of list) {
      console.log(`  ${role.padEnd(3)} ${String(r.mode ?? '').padEnd(12)} target=(${r.tx}, ${r.ty})`);
    }
  }
}

function setLineHeight(team, lh) {
  team.tactics.defensiveLineHeight = lh;
  team.tactics.pressing = lh >= 0.5 ? 1 : 0.25;
}

function lineTest(sim, lh) {
  const homeTeam = sim.homeTeam;
  const awayTeam = sim.awayTeam;
  setLineHeight(homeTeam, lh);
  awayTeam.applyFormationBasePositions();
  homeTeam.applyFormationBasePositions();
  // 수비(홈): 상대(어웨이)가 75m 부근 소유
  console.log(`\n======== HOME 수비  lh=${lh}  (ball@75m, away 소유) ========`);
  const defRows = measureDefense(homeTeam, awayTeam, sim, 75, H / 2);
  table('DEFENSE', defRows);
  // 공격(홈): 홈이 52.5m 소유
  console.log(`\n======== HOME 공격  lh=${lh}  (ball@52.5m, home 소유) ========`);
  const atkRows = measureAttack(homeTeam, awayTeam, sim, 52.5, H / 2);
  table('ATTACK', atkRows);
  const fronts = atkRows.map((r) => r.tx).filter((x) => x !== null);
  console.log(`  → 공격 시 최전방 목표 X = ${Math.max(...fronts)}m (하프라인 ${L / 2}m)`);
}

// ── TEST C: 패스 비행 중 은혜 기간이 얼마나 빨리 소멸하는가 ──
function graceTest(sim) {
  const homeTeam = sim.homeTeam;
  const awayTeam = sim.awayTeam;
  const ball = sim.ball;
  homeTeam.applyFormationBasePositions();
  awayTeam.applyFormationBasePositions();
  clearAllBall(homeTeam);
  clearAllBall(awayTeam);

  // 홈 패스 비행 중: passTargetPlayer = 홈 CM, lastTouchedTeam = home
  const receiver = homeTeam.players.find((p) => p.role === 'CM');
  setBall(ball, 45, H / 2);
  ball.lastTouchedTeam = homeTeam;
  ball.passTargetPlayer = receiver;
  ball.kicker = homeTeam.players.find((p) => p.role === 'CB');
  ball.velocity.x = 12;
  ball.velocity.y = 0;
  ball.height = 0.4;
  // 직전까지 우리 팀이 소유했다고 가정 (은혜 1.5초에서 시작)
  homeTeam._possGrace = 1.5;

  const mc = sim._homeMC;
  console.log(`\n======== TEST C: 패스 비행 중 소유 은혜 소멸 속도 ========`);
  console.log(`  초기 _possGrace = ${homeTeam._possGrace}`);
  let broke = false;
  for (let f = 1; f <= 120; f++) {
    mc.refreshRoles(homeTeam, awayTeam, ball, DT); // 팀당 1회 상태 갱신
    for (const p of homeTeam.players) {
      if (p.role !== 'GK') mc.update(p, homeTeam, awayTeam, ball, DT);
    }
    const mode = homeTeam.players.find((p) => p.role === 'LM').brainMemory.offBallMode;
    const stillAttack = !!(homeTeam._possGrace > 0) || ball.owner?.team === homeTeam;
    if (!stillAttack && !broke) {
      broke = true;
      console.log(`  → 은혜 소멸: ${f}프레임 후 (실시간 ${(f * DT).toFixed(2)}s). LM의 offBallMode=${mode ?? '(loose로 전환)'}`);
    }
  }
  if (!broke) console.log(`  → 120프레임 동안 은혜 유지 (이상 없음)`);
  console.log(`  최종 _possGrace = ${homeTeam._possGrace.toFixed(3)}`);
  ball.passTargetPlayer = null;
  ball.kicker = null;
  ball.owner = null;
  ball.lastTouchedTeam = null;
}

const homeTeam = makeTeam('H', 'home', '4-4-2', { defensiveLineHeight: 1, mentality: 'attacking', pressing: 1 });
const awayTeam = makeTeam('A', 'away', '4-4-2', { defensiveLineHeight: 0, mentality: 'defensive', pressing: 0 });
const sim = new MatchSimulator({ homeTeam, awayTeam, eventBus: new EventBus() });
sim.matchState.phase = 'IN_PLAY';

for (const lh of [0, 0.5, 1]) {
  lineTest(sim, lh);
}

// ── TEST D: 파이널 서드 / 빌드업 공격 형태 ──
console.log(`\n======== TEST D: 파이널 서드 (ball@75m, home 소유) ========`);
setLineHeight(homeTeam, 0.5);
awayTeam.applyFormationBasePositions();
homeTeam.applyFormationBasePositions();
const d1 = measureAttack(homeTeam, awayTeam, sim, 75, H / 2);
table('FINAL_THIRD', d1);
console.log(`\n======== TEST D2: 빌드업 (ball@30m, home 소유) ========`);
const d2 = measureAttack(homeTeam, awayTeam, sim, 30, H / 2);
table('BUILD_UP', d2);

// ── TEST F: 상실 직후 카운터프레스 창 ──
console.log(`\n======== TEST F: 점유 상실 → 카운터프레스 ========`);
setLineHeight(homeTeam, 0.5);
homeTeam.applyFormationBasePositions();
awayTeam.applyFormationBasePositions();
clearAllBall(homeTeam);
clearAllBall(awayTeam);
const hST = homeTeam.players.find((p) => p.role === 'ST' && p.name.endsWith('11'));
const aST = awayTeam.players.find((p) => p.role === 'ST' && p.name.endsWith('11'));
const mc = sim._homeMC;
setBall(sim.ball, 45, H / 2);
giveBall(sim.ball, hST);
mc.refreshRoles(homeTeam, awayTeam, sim.ball, DT);
console.log(`  소유 직후 상태 = ${homeTeam._tacticalPossession}`);
giveBall(sim.ball, aST);
aST.position.x = 46; aST.position.y = H / 2;
mc.refreshRoles(homeTeam, awayTeam, sim.ball, DT);
console.log(`  상실 직후 상태 = ${homeTeam._tacticalPossession} (counterPress=${homeTeam._counterPressTimer.toFixed(2)}s)`);
for (let f = 0; f < 8; f++) mc.refreshRoles(homeTeam, awayTeam, sim.ball, DT);
console.log(`  0.16s 후 상태 = ${homeTeam._tacticalPossession} (counterPress=${homeTeam._counterPressTimer.toFixed(2)}s)`);
sim.ball.owner = null;

graceTest(sim);
console.log('\n--- 방향 미러 검증 (하프타임 전후 home attackingDirection) ---');
console.log('전반 home.dir =', sim.homeTeam.attackingDirection);
sim.homeTeam.flipAttackingDirection();
sim.awayTeam.flipAttackingDirection();
sim.homeTeam.applyFormationBasePositions();
sim.awayTeam.applyFormationBasePositions();
console.log('후반 home.dir =', sim.homeTeam.attackingDirection);
const hb = sim.homeTeam.players.find((p) => p.role === 'CB');
console.log('후반 홈 CB basePosition.x =', Math.round(hb.basePosition.x), '(홈이 왼쪽 공격 → CB는 오른쪽 83m 부근이어야 함)');