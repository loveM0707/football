import { Player } from './js/entities/Player.js';
import { Team } from './js/entities/Team.js';
import { EventBus } from './js/core/EventBus.js';
import { MatchSimulator } from './js/core/MatchSimulator.js';

function rand(base, spread) {
  return Math.round(base + (Math.random() - 0.5) * 2 * spread);
}

const ROLE_ORDER = ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'];

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
    return new Player({
      name: `${prefix} ${idx + 1}`,
      number: idx + 1,
      role,
      attributes,
    });
  });
}

async function runOnce(seed) {
  if (seed !== undefined) Math.random = () => { const x = (seed * 9301 + 49297) % 233280 / 233280; seed = x; return x; };
  const homeTeam = new Team({ name: 'Home', side: 'home', color: '#3b6fd6', formationName: '4-4-2', players: buildRoster('Home', 6) });
  const awayTeam = new Team({ name: 'Away', side: 'away', color: '#d6483b', formationName: '4-3-3', players: buildRoster('Away', 6) });

  const eventBus = new EventBus();
  const simulator = new MatchSimulator({ homeTeam, awayTeam, eventBus });

  const stats = { shots: 0, onTarget: 0, goals: 0, saves: 0, parries: 0, passes: 0, interceptions: 0, blocks: 0, contests: 0, tackles: 0, dribbles: 0, fouls: 0, corners: 0, goalKicks: 0, throwIns: 0, savedHeld: 0, parried: 0, woodwork: 0 };
  eventBus.on('shot', (e) => { stats.shots++; if (e.onTarget) stats.onTarget++;
    globalThis.__shotSrc ??= {}; const k = e.header ? 'HEADER' : (e.src ?? 'NONE');
    globalThis.__shotSrc[k] = (globalThis.__shotSrc[k]||0)+1; });
  eventBus.on('woodwork', () => stats.woodwork++);
  eventBus.on('goal', () => stats.goals++);
  eventBus.on('save', (e) => { stats.saves++; if (e.held) stats.savedHeld++; else stats.parried++; });
  eventBus.on('pass', (e) => { stats.passes++;
    globalThis.__srcCount ??= {}; const k = e.header ? 'HEADER' : (e.src ?? 'NONE');
    globalThis.__srcCount[k] = (globalThis.__srcCount[k]||0)+1;
    if (e.through) {
      globalThis.__srcCount.THROUGH_TOTAL = (globalThis.__srcCount.THROUGH_TOTAL||0)+1;
      globalThis.__throughLoft ??= { ground: 0, lofted: 0 };
      if (e.lofted) globalThis.__throughLoft.lofted++; else globalThis.__throughLoft.ground++;
    } });
  eventBus.on('interception', () => stats.interceptions++);
  eventBus.on('block', () => stats.blocks++);
  eventBus.on('contest', () => stats.contests++);
  eventBus.on('tackle', () => stats.tackles++);
  eventBus.on('dribble', () => stats.dribbles++);
  eventBus.on('foul', () => stats.fouls++);
  eventBus.on('restart', (e) => {
    if (e.type === 'CORNER') stats.corners++;
    else if (e.type === 'GOAL_KICK') stats.goalKicks++;
    else if (e.type === 'THROW_IN') stats.throwIns++;
    else if (e.type === 'FREE_KICK' || e.type === 'PENALTY') stats.fouls++;
  });

  // dt는 브라우저와 동일한 1/60초가 기본이다. 굵은 틱(0.1s 이상)은 공이
  // BALL_CONTROL_RADIUS(1.15m)를 그대로 통과해 버려(터널링) 패스 수신이
  // 누락되고, 20m/s 슛이 선방/골대 판정을 건너뛴다. 즉 통계가 실제 플레이보다
  // 낙관적으로 나온다. 빠른 반복이 필요할 때만 SIM_DT로 굵게 조정한다.
  const dt = Number(process.env.SIM_DT ?? 1 / 60);
  const steps = Math.round(5400 / dt);
  for (let i = 0; i < steps; i++) {
    simulator.tick(dt);
  }

  return { score: simulator.matchState.score, stats, clock: `${simulator.matchState.displayMinute}:${Math.floor(simulator.matchState.displaySecond)}` };
}

let homeGoals = 0, awayGoals = 0, totalShots = 0, totalPasses = 0, totalSaves = 0, totalDribbles = 0, totalTackles = 0, totalOnTarget = 0, totalCorners = 0;
const runs = Number(process.env.SIM_RUNS ?? 5);
for (let i = 0; i < runs; i++) {
  const res = await runOnce();
  homeGoals += res.score.home;
  awayGoals += res.score.away;
  totalShots += res.stats.shots;
  totalOnTarget += res.stats.onTarget;
  totalCorners += res.stats.corners;
  totalPasses += res.stats.passes;
  totalSaves += res.stats.saves;
  totalDribbles += res.stats.dribbles;
  totalTackles += res.stats.tackles;
  console.log(`Run ${i+1}: ${res.score.home}-${res.score.away} | shots=${res.stats.shots}(OT ${res.stats.onTarget}) wood=${res.stats.woodwork} goals=${res.stats.goals} saves=${res.stats.saves}(held=${res.stats.savedHeld},parried=${res.stats.parried}) int=${res.stats.interceptions} blocks=${res.stats.blocks} contests=${res.stats.contests} tackles=${res.stats.tackles} dribbles=${res.stats.dribbles} fouls=${res.stats.fouls} corners=${res.stats.corners} gk=${res.stats.goalKicks} ti=${res.stats.throwIns} | passes=${res.stats.passes} | clock=${res.clock}`);
}
const totGoals = homeGoals + awayGoals;
console.log(`\n=== Summary (${runs} runs) ===`);
console.log(`Goals: ${totGoals} (home ${homeGoals}, away ${awayGoals})`);
console.log(`Total shots: ${totalShots} (on target ${totalOnTarget}) | Total saves: ${totalSaves} | Total corners: ${totalCorners}`);
console.log(`PER MATCH  shots/team: ${(totalShots/runs/2).toFixed(1)} | passes/team: ${(totalPasses/runs/2).toFixed(0)} | goals: ${(totGoals/runs).toFixed(2)}`);
console.log(`Total tackles: ${totalTackles} | Total successful dribbles: ${totalDribbles} (Duel win rate: ${(totalDribbles*100/(totalDribbles+totalTackles||1)).toFixed(1)}%)`);
console.log('SHOT SOURCES:', JSON.stringify(globalThis.__shotSrc));
console.log('PASS SOURCES:', JSON.stringify(globalThis.__srcCount));
console.log('THROUGH GROUND/LOFTED:', JSON.stringify(globalThis.__throughLoft));
console.log(`Shot conversion: ${totalShots ? (totGoals*100/totalShots).toFixed(1) : 0}%`);
console.log(`Saves vs shots: ${totalShots ? ((totalSaves)*100/totalShots).toFixed(1) : 0}% (lower = more goals get through)`);
