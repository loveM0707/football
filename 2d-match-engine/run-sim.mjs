import { Player } from './js/entities/Player.js';
import { Team } from './js/entities/Team.js';
import { EventBus } from './js/core/EventBus.js';
import { MatchSimulator } from './js/core/MatchSimulator.js';

function rand(base, spread) {
  return Math.round(base + (Math.random() - 0.5) * 2 * spread);
}

const ROLE_ORDER = ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'];

const ROLE_ATTR_PRESETS = {
  GK: { pace: 55, acceleration: 55, tackling: 40, passing: 55, shooting: 20, dribbling: 40, strength: 65, positioning: 75, reflexes: 78, vision: 70, agility: 45, interception: 20, passSpeed: 65, shotSpeed: 50, decisionMaking: 72, power: 62 },
  LB: { pace: 74, acceleration: 74, tackling: 72, passing: 68, shooting: 45, dribbling: 65, strength: 68, positioning: 68, reflexes: 40, vision: 62, agility: 72, interception: 68, passSpeed: 66, shotSpeed: 52, decisionMaking: 65, power: 70 },
  RB: { pace: 74, acceleration: 74, tackling: 72, passing: 68, shooting: 45, dribbling: 65, strength: 68, positioning: 68, reflexes: 40, vision: 62, agility: 72, interception: 68, passSpeed: 66, shotSpeed: 52, decisionMaking: 65, power: 70 },
  CB: { pace: 66, acceleration: 62, tackling: 80, passing: 62, shooting: 35, dribbling: 50, strength: 82, positioning: 78, reflexes: 40, vision: 58, agility: 55, interception: 78, passSpeed: 60, shotSpeed: 48, decisionMaking: 68, power: 82 },
  LM: { pace: 76, acceleration: 76, tackling: 55, passing: 74, shooting: 60, dribbling: 76, strength: 58, positioning: 65, reflexes: 40, vision: 72, agility: 78, interception: 48, passSpeed: 74, shotSpeed: 70, decisionMaking: 70, power: 58 },
  RM: { pace: 76, acceleration: 76, tackling: 55, passing: 74, shooting: 60, dribbling: 76, strength: 58, positioning: 65, reflexes: 40, vision: 72, agility: 78, interception: 48, passSpeed: 74, shotSpeed: 70, decisionMaking: 70, power: 58 },
  CM: { pace: 68, acceleration: 66, tackling: 65, passing: 80, shooting: 58, dribbling: 70, strength: 65, positioning: 72, reflexes: 40, vision: 80, agility: 66, interception: 55, passSpeed: 80, shotSpeed: 64, decisionMaking: 82, power: 65 },
  ST: { pace: 78, acceleration: 78, tackling: 35, passing: 60, shooting: 82, dribbling: 75, strength: 70, positioning: 74, reflexes: 40, vision: 68, agility: 74, interception: 30, passSpeed: 65, shotSpeed: 84, decisionMaking: 72, power: 72 },
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

  const stats = { shots: 0, goals: 0, saves: 0, parries: 0, passes: 0, interceptions: 0, blocks: 0, contests: 0, tackles: 0, dribbles: 0, fouls: 0, corners: 0, goalKicks: 0, throwIns: 0, savedHeld: 0, parried: 0 };
  eventBus.on('shot', () => stats.shots++);
  eventBus.on('goal', () => stats.goals++);
  eventBus.on('save', (e) => { stats.saves++; if (e.held) stats.savedHeld++; else stats.parried++; });
  eventBus.on('pass', () => stats.passes++);
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

  const dt = 0.5;
  for (let i = 0; i < 10800; i++) {
    simulator.tick(dt);
  }

  return { score: simulator.matchState.score, stats, clock: `${simulator.matchState.displayMinute}:${Math.floor(simulator.matchState.displaySecond)}` };
}

let homeGoals = 0, awayGoals = 0, totalShots = 0, totalPasses = 0, totalSaves = 0, totalDribbles = 0, totalTackles = 0;
const runs = 3;
for (let i = 0; i < runs; i++) {
  const res = await runOnce();
  homeGoals += res.score.home;
  awayGoals += res.score.away;
  totalShots += res.stats.shots;
  totalPasses += res.stats.passes;
  totalSaves += res.stats.saves;
  totalDribbles += res.stats.dribbles;
  totalTackles += res.stats.tackles;
  console.log(`Run ${i+1}: ${res.score.home}-${res.score.away} | shots=${res.stats.shots} goals=${res.stats.goals} saves=${res.stats.saves}(held=${res.stats.savedHeld},parried=${res.stats.parried}) int=${res.stats.interceptions} blocks=${res.stats.blocks} contests=${res.stats.contests} tackles=${res.stats.tackles} dribbles=${res.stats.dribbles} fouls=${res.stats.fouls} corners=${res.stats.corners} gk=${res.stats.goalKicks} ti=${res.stats.throwIns} | passes=${res.stats.passes} | clock=${res.clock}`);
}
const totGoals = homeGoals + awayGoals;
console.log(`\n=== Summary (${runs} runs) ===`);
console.log(`Goals: ${totGoals} (home ${homeGoals}, away ${awayGoals})`);
console.log(`Total shots: ${totalShots} | Total saves: ${totalSaves} | Total passes: ${totalPasses}`);
console.log(`Total tackles: ${totalTackles} | Total successful dribbles: ${totalDribbles} (Duel win rate: ${(totalDribbles*100/(totalDribbles+totalTackles||1)).toFixed(1)}%)`);
console.log(`Shot conversion: ${totalShots ? (totGoals*100/totalShots).toFixed(1) : 0}%`);
console.log(`Saves vs shots: ${totalShots ? ((totalSaves)*100/totalShots).toFixed(1) : 0}% (lower = more goals get through)`);
