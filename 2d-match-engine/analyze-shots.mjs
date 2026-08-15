import { Player } from './js/entities/Player.js';
import { Team } from './js/entities/Team.js';
import { EventBus } from './js/core/EventBus.js';
import { MatchSimulator } from './js/core/MatchSimulator.js';
import { Pitch } from './js/entities/Pitch.js';
import { Vector2D } from './js/entities/Vector2D.js';

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
    return new Player({ name: `${prefix} ${idx + 1}`, number: idx + 1, role, attributes });
  });
}

// ---- 헬퍼 ----
function segmentPointInfo(p, a, b) {
  const ab = b.sub(a);
  const lenSq = ab.lengthSq();
  const t = Math.max(0, Math.min(1, p.sub(a).dot(ab) / Math.max(lenSq, 1e-6)));
  const proj = a.add(ab.scale(t));
  return { dist: p.sub(proj).length(), t };
}

function goalAngleOpen(pos, goalX) {
  const [topY, bottomY] = Pitch.goalYRange();
  const a = new Vector2D(goalX - pos.x, topY - pos.y);
  const b = new Vector2D(goalX - pos.x, bottomY - pos.y);
  return Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y));
}

function countBlockers(pos, opponentTeam, goalX) {
  const goalCenter = new Vector2D(goalX, Pitch.WIDTH / 2);
  let blockers = 0;
  for (const o of opponentTeam.players) {
    if (o.role === 'GK') continue;
    const { dist, t } = segmentPointInfo(o.position, pos, goalCenter);
    if (dist < 1.8 && t > 0.05 && t < 0.97) blockers++;
  }
  return blockers;
}

function classifyPass(from, to, intent, header) {
  if (header) return 'HEADER_PASS';
  const fromPos = from.position;
  const toPos = to.position;
  const attackDir = from.team.attackingDirection;
  const oppGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
  const dist = fromPos.sub(toPos).length();
  const lofted = !!(intent && intent.lofted);
  const targetPos = intent && intent.targetPos;
  const onFlank = fromPos.y < 14 || fromPos.y > Pitch.WIDTH - 14;
  const receiverNearGoal = Math.abs(toPos.x - oppGoalX) < Pitch.PENALTY_BOX_LENGTH + 8;
  const movingToGoal = Math.abs(toPos.x - oppGoalX) < Math.abs(fromPos.x - oppGoalX);

  if (lofted && onFlank && receiverNearGoal) return 'CROSS';
  if (targetPos && movingToGoal) return 'THROUGH';
  if (dist > 30) return 'LONG';
  if (lofted) return 'LOFTED';
  return 'GROUND';
}

function zoneOf(dist) {
  if (dist < 5.5) return '0~5.5m (6야드박스)';
  if (dist < 11) return '5.5~11m (골에어리어 인근)';
  if (dist < 16.5) return '11~16.5m (페널티박스)';
  if (dist < 25) return '16.5~25m (박스 근처)';
  return '25m 이상 (장거리)';
}

const PATTERN_LABEL = {
  SET_PIECE_HEADER: '세트피스 헤딩슛 (코너/프리킥)',
  SET_PIECE_DIRECT: '세트피스 직접슛 (프리킥)',
  CROSS_HEADER: '크로스 헤딩슛',
  CROSS_FOOT: '크로스 연계 슛',
  THROUGH: '스루패스 후 슛',
  DRIBBLE: '드리블 침투 후 슛',
  PASS_COMBO: '연계 패스 후 슛',
  LONG_BALL: '롱패스 직결 슛',
  LOOSE_BALL: '루즈볼/리바운드 슛',
  HEADER_LOOSE: '공중볼 헤딩슛',
};

function patternName(pat) {
  return PATTERN_LABEL[pat] || pat;
}

// ---- 경기 분석기 (이벤트 로그 기반) ----
class MatchAnalyzer {
  constructor(simulator) {
    this.sim = simulator;
    this.shots = [];
    this.lastShot = null;
    this.passLog = [];       // { clock, team, from, to, toPos, type, dist }
    this.dribbleLog = [];    // { clock, team, player, outcome }
    this.regainLog = [];     // { clock, team, pos, kind }  가로채기/태클/세이브로 공 뺏음
    this.restartLog = [];    // { clock, type, team }
    this.clearLog = [];      // { clock, team }
    this.gainPosByPlayer = new Map(); // playerId -> { pos, clock } 선수가 이번 소유권을 얻은 지점
    this.prevOwner = null;
  }

  clock() {
    const st = this.sim.matchState;
    return (st.half - 1) * 2700 + st.matchSeconds;
  }

  onPass(e) {
    const intent = e.from.brainMemory && e.from.brainMemory.lastIntent;
    this.passLog.push({
      clock: this.clock(),
      team: e.team,
      from: e.from,
      to: e.to,
      toPos: e.to.position.clone(),
      fromPos: e.from.position.clone(),
      type: classifyPass(e.from, e.to, intent, e.header),
      dist: e.from.position.sub(e.to.position).length(),
    });
    if (this.passLog.length > 2000) this.passLog.splice(0, 500);
  }

  onDribble(e) {
    this.dribbleLog.push({ clock: this.clock(), team: e.winner.team, player: e.winner, outcome: e.outcome });
    if (this.dribbleLog.length > 500) this.dribbleLog.splice(0, 200);
  }

  onRegain(e) {
    const team = e.team;
    const pos = e.pos || e.player.position;
    this.regainLog.push({ clock: this.clock(), team, pos: pos.clone(), kind: e.kind });
    if (this.regainLog.length > 500) this.regainLog.splice(0, 200);
  }

  onRestart(e) {
    this.restartLog.push({ clock: this.clock(), type: e.type, team: e.team });
    if (this.restartLog.length > 200) this.restartLog.splice(0, 50);
  }

  onClear(e) {
    this.clearLog.push({ clock: this.clock(), team: e.team });
    if (this.clearLog.length > 200) this.clearLog.splice(0, 50);
  }

  onShot(e) {
    const st = this.sim.matchState;
    const shooter = e.by;
    const team = shooter.team;
    const clock = this.clock();
    const oppGoalX = team.attackingDirection === 1 ? Pitch.LENGTH : 0;
    const goalCenter = new Vector2D(oppGoalX, Pitch.WIDTH / 2);
    const pos = shooter.position.clone();
    const dist = pos.sub(goalCenter).length();
    const angle = goalAngleOpen(pos, oppGoalX);
    const opponent = team === this.sim.homeTeam ? this.sim.awayTeam : this.sim.homeTeam;
    const blockers = countBlockers(pos, opponent, oppGoalX);

    const phase = st.phase;
    const header = !!e.header;
    const setPiecePhase = phase === 'CORNER_KICK' || phase === 'FREE_KICK';

    // 이 슛 전 8초 동안의 같은 팀 패스 체인
    const chain = this.passLog.filter(
      (p) => p.team === team && p.clock > clock - 8 && p.clock <= clock
    );

    // 마지막 슛 조성 패스 탐색 (크로스/스루 우선, 슈터에게 연결된 패스)
    let srcPass = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const p = chain[i];
      if (p.type === 'CROSS' || p.type === 'THROUGH' || p.type === 'LONG' || p.type === 'LOFTED') {
        if (p.to === shooter || p.toPos.sub(pos).length() < 14) { srcPass = p; break; }
      }
    }
    if (!srcPass) {
      for (let i = chain.length - 1; i >= 0; i--) {
        const p = chain[i];
        if (p.to === shooter || p.toPos.sub(pos).length() < 6) { srcPass = p; break; }
      }
    }

    // 패턴 분류
    let pattern;
    const quickAfterPass = srcPass && (clock - srcPass.clock) < 2.5;

    if (header) {
      if (srcPass && srcPass.type === 'CROSS' && !setPiecePhase) pattern = 'CROSS_HEADER';
      else if (setPiecePhase || (srcPass && srcPass.type === 'CROSS')) pattern = 'SET_PIECE_HEADER';
      else pattern = 'HEADER_LOOSE';
    } else if (setPiecePhase) {
      pattern = 'SET_PIECE_DIRECT';
    } else if (quickAfterPass && srcPass) {
      if (srcPass.type === 'CROSS') pattern = 'CROSS_FOOT';
      else if (srcPass.type === 'THROUGH') pattern = 'THROUGH';
      else if (srcPass.type === 'LONG') pattern = 'LONG_BALL';
      else if (srcPass.type === 'LOFTED') pattern = 'PASS_COMBO';
      else pattern = 'PASS_COMBO';
    } else {
      // 슈터가 직접 운반한 경우
      const possTime = shooter.brainMemory.possessionTimer || 0;
      const gain = this.gainPosByPlayer.get(shooter.id);
      const carry = (gain && clock - gain.clock < 10) ? pos.sub(gain.pos).length() : 0;
      if (carry > 8 || possTime > 2.5) pattern = 'DRIBBLE';
      else pattern = 'LOOSE_BALL';
    }

    // 역습 판정
    const ownHalf = team.attackingDirection === 1 ? pos.x < Pitch.LENGTH * 0.5 : pos.x > Pitch.LENGTH * 0.5;
    const chainStartPos = chain.length ? chain[0].fromPos : pos;
    const chainStartOwnHalf = team.attackingDirection === 1
      ? chainStartPos.x < Pitch.LENGTH * 0.5
      : chainStartPos.x > Pitch.LENGTH * 0.5;
    const recentRegain = this.regainLog.some(
      (r) => r.team === team && clock - r.clock < 6 && (team.attackingDirection === 1 ? r.pos.x < Pitch.LENGTH * 0.55 : r.pos.x > Pitch.LENGTH * 0.45)
    );
    const isCounter = chain.length <= 3 && (chainStartOwnHalf || ownHalf) && recentRegain;

    // 공격 시작 유형
    let start;
    const restart = this.restartLog.filter((r) => r.team === team && clock - r.clock < 4).pop();
    if (restart) {
      start = restart.type === 'KICKOFF' ? '킥오프'
        : restart.type === 'CORNER' ? '코너킥 재개'
        : restart.type === 'FREE_KICK' ? '프리킥 재개'
        : restart.type === 'GOAL_KICK' ? '골킥 빌드업'
        : '스로인 재개';
    } else {
      const regain = this.regainLog.filter((r) => r.team === team && clock - r.clock < 6).pop();
      start = regain
        ? (regain.kind === 'interception' ? '가로채기 전환'
          : regain.kind === 'tackle' ? '태클 탈취 전환'
          : 'GK 캐치 후 전환')
        : '점유 빌드업';
    }

    const shot = {
      clock,
      matchMinute: `${st.half === 1 ? '' : '45+'}${st.displayMinute}:${String(st.displaySecond).padStart(2, '0')}`,
      team: team.side,
      teamName: team.name,
      player: shooter,
      role: shooter.role,
      dist,
      angle,
      blockers,
      header,
      phase,
      pattern,
      isCounter,
      buildup: chain.length,
      start,
      result: 'MISS (골대밖)',
      x: pos.x,
      y: pos.y,
    };
    this.shots.push(shot);
    this.lastShot = shot;
  }

  onGoal() {
    if (this.lastShot) this.lastShot.result = 'GOAL';
  }

  onSave(e) {
    if (this.lastShot) this.lastShot.result = e.held ? 'SAVE (GK 캐치)' : 'SAVE (GK 파리)';
  }

  onBlock() {
    // 슛 직후 3초 내 블록만 슛 차단으로 집계 (패스 굴절 제외)
    if (this.lastShot && this.clock() - this.lastShot.clock < 3 &&
        !this.lastShot.result.startsWith('SAVE') && !this.lastShot.result.startsWith('GOAL')) {
      this.lastShot.result = 'BLOCK (수비 차단)';
    }
  }

  postTick() {
    const st = this.sim.matchState;
    const owner = this.sim.ball.owner;
    if (owner && owner !== this.prevOwner) {
      this.gainPosByPlayer.set(owner.id, { pos: owner.position.clone(), clock: this.clock() });
    }
    this.prevOwner = owner;
  }
}

async function runOnce(runIndex) {
  const homeTeam = new Team({ name: 'Home', side: 'home', color: '#3b6fd6', formationName: '4-4-2', players: buildRoster('Home', 6) });
  const awayTeam = new Team({ name: 'Away', side: 'away', color: '#d6483b', formationName: '4-3-3', players: buildRoster('Away', 6) });
  const eventBus = new EventBus();
  const simulator = new MatchSimulator({ homeTeam, awayTeam, eventBus });

  const analyzer = new MatchAnalyzer(simulator);

  eventBus.on('shot', (e) => { analyzer.onShot(e); });
  eventBus.on('goal', (e) => analyzer.onGoal());
  eventBus.on('save', (e) => { analyzer.onSave(e); analyzer.onRegain({ team: e.gk.team, pos: e.gk.position, kind: 'save' }); });
  eventBus.on('block', () => analyzer.onBlock());
  eventBus.on('pass', (e) => analyzer.onPass(e));
  eventBus.on('dribble', (e) => analyzer.onDribble(e));
  eventBus.on('interception', (e) => analyzer.onRegain({ team: e.player.team, pos: e.player.position, kind: 'interception' }));
  eventBus.on('tackle', (e) => { if (e.winner && !e.loose) analyzer.onRegain({ team: e.winner.team, pos: e.winner.position, kind: 'tackle' }); });
  eventBus.on('restart', (e) => analyzer.onRestart(e));
  eventBus.on('clear', (e) => analyzer.onClear(e));

  const dt = 0.5;
  for (let i = 0; i < 10800; i++) {
    simulator.tick(dt);
    analyzer.postTick();
  }

  return { runIndex, score: `${simulator.matchState.score.home}-${simulator.matchState.score.away}`, shots: analyzer.shots };
}

// ---- 집계 ----
function aggregate(results) {
  const allShots = results.flatMap((r) => r.shots);

  const playerAgg = {};
  for (const s of allShots) {
    const key = `${s.teamName}|${s.player.name}|${s.role}`;
    if (!playerAgg[key]) playerAgg[key] = { teamName: s.teamName, team: s.team, name: s.player.name, role: s.role, shots: 0, goals: 0, saved: 0, blocked: 0, miss: 0, distSum: 0, distN: 0 };
    const a = playerAgg[key];
    a.shots++;
    if (s.result === 'GOAL') a.goals++;
    else if (s.result.startsWith('SAVE')) a.saved++;
    else if (s.result.startsWith('BLOCK')) a.blocked++;
    else a.miss++;
    a.distSum += s.dist; a.distN++;
  }

  const patternAgg = {};
  for (const s of allShots) {
    if (!patternAgg[s.pattern]) patternAgg[s.pattern] = { shots: 0, goals: 0, distSum: 0, distN: 0, angleSum: 0, angleN: 0, blockersSum: 0, blockersN: 0, buildupSum: 0, buildupN: 0, counter: 0 };
    const a = patternAgg[s.pattern];
    a.shots++;
    if (s.result === 'GOAL') a.goals++;
    a.distSum += s.dist; a.distN++;
    a.angleSum += s.angle; a.angleN++;
    a.blockersSum += s.blockers; a.blockersN++;
    a.buildupSum += s.buildup; a.buildupN++;
    if (s.isCounter) a.counter++;
  }

  const zoneAgg = {};
  for (const s of allShots) {
    const z = zoneOf(s.dist);
    if (!zoneAgg[z]) zoneAgg[z] = { shots: 0, goals: 0 };
    zoneAgg[z].shots++;
    if (s.result === 'GOAL') zoneAgg[z].goals++;
  }

  const startAgg = {};
  for (const s of allShots) {
    if (!startAgg[s.start]) startAgg[s.start] = { shots: 0, goals: 0 };
    startAgg[s.start].shots++;
    if (s.result === 'GOAL') startAgg[s.start].goals++;
  }

  const buildupAgg = { '0회(일발슛)': 0, '1~2회': 0, '3~5회': 0, '6회 이상': 0 };
  for (const s of allShots) {
    if (s.buildup === 0) buildupAgg['0회(일발슛)']++;
    else if (s.buildup <= 2) buildupAgg['1~2회']++;
    else if (s.buildup <= 5) buildupAgg['3~5회']++;
    else buildupAgg['6회 이상']++;
  }

  return { allShots, playerAgg, patternAgg, zoneAgg, startAgg, buildupAgg };
}

function pct(n, d) {
  return d ? ((n * 100) / d).toFixed(1) + '%' : '-';
}

function renderReport(results) {
  const { allShots, playerAgg, patternAgg, zoneAgg, startAgg, buildupAgg } = aggregate(results);
  const goals = allShots.filter((s) => s.result === 'GOAL').length;
  const saves = allShots.filter((s) => s.result.startsWith('SAVE')).length;
  const blocks = allShots.filter((s) => s.result.startsWith('BLOCK')).length;
  const misses = allShots.filter((s) => s.result.startsWith('MISS')).length;

  console.log(`\n═══════════ 슈팅 통계 · ${results.length}경기 ═══════════`);
  console.log(`총 슈팅: ${allShots.length} | 골: ${goals} | 세이브: ${saves} | 수비 차단: ${blocks} | 골대밖/벗어남: ${misses}`);
  console.log(`골 전환율: ${pct(goals, allShots.length)} | 유효슛 비율(골+세이브): ${pct(goals + saves, allShots.length)}`);

  for (const side of ['home', 'away']) {
    const teamShots = allShots.filter((s) => s.team === side);
    const teamGoals = teamShots.filter((s) => s.result === 'GOAL').length;
    const teamSaves = teamShots.filter((s) => s.result.startsWith('SAVE')).length;
    const teamName = side === 'home' ? 'Home (4-4-2)' : 'Away (4-3-3)';
    console.log(`\n── ${teamName} ──`);
    console.log(`  슈팅 ${teamShots.length}회 · 골 ${teamGoals} (${pct(teamGoals, teamShots.length)}) · 유효슛 ${pct(teamShots.filter(s => s.result === 'GOAL' || s.result.startsWith('SAVE')).length, teamShots.length)} · 세이브 당함 ${teamSaves}`);
    console.log(`  평균 슛 거리: ${(teamShots.reduce((a, s) => a + s.dist, 0) / (teamShots.length || 1)).toFixed(1)}m · 평균 시야각: ${(teamShots.reduce((a, s) => a + s.angle, 0) / (teamShots.length || 1) * 180 / Math.PI).toFixed(1)}°`);

    const players = Object.values(playerAgg).filter((p) => p.team === side).sort((a, b) => b.shots - a.shots);
    console.log(`  선수별 슈팅:`);
    for (const p of players) {
      const avgDist = (p.distSum / (p.distN || 1)).toFixed(1);
      console.log(`    ${p.role.padEnd(2)} ${p.name.padEnd(8)} ${p.shots}회 | 골 ${p.goals} (${pct(p.goals, p.shots)}) | 세이브 ${p.saved} 차단 ${p.blocked} 빗나감 ${p.miss} | 평균거리 ${avgDist}m`);
    }
  }

  console.log(`\n── 슈팅 발생 공격 패턴 ──`);
  const patterns = Object.entries(patternAgg).sort((a, b) => b[1].shots - a[1].shots);
  for (const [pat, a] of patterns) {
    const avgDist = (a.distSum / (a.distN || 1)).toFixed(1);
    const avgAngle = ((a.angleSum / (a.angleN || 1)) * 180 / Math.PI).toFixed(1);
    const avgBlockers = (a.blockersSum / (a.blockersN || 1)).toFixed(1);
    const avgBuildup = (a.buildupSum / (a.buildupN || 1)).toFixed(1);
    console.log(`  ${patternName(pat).padEnd(26)} ${String(a.shots).padStart(3)}회 (${pct(a.shots, allShots.length)}) | 골 ${a.goals} (${pct(a.goals, a.shots)}) | 평균 ${avgDist}m / 각도 ${avgAngle}° / 차단 ${avgBlockers}명 / 빌드업 ${avgBuildup}패스${a.counter ? ` | 역습 ${a.counter}회` : ''}`);
  }

  console.log(`\n── 슈팅 위치(거리) 분포 ──`);
  const zones = Object.entries(zoneAgg).sort((x, y) => x[0].localeCompare(y[0]));
  for (const [z, a] of zones) {
    console.log(`  ${z.padEnd(22)} ${String(a.shots).padStart(3)}회 (${pct(a.shots, allShots.length)}) | 골 ${a.goals} (${pct(a.goals, a.shots)})`);
  }

  console.log(`\n── 슛으로 이어진 공격 시작 유형 ──`);
  const starts = Object.entries(startAgg).sort((a, b) => b[1].shots - a[1].shots);
  for (const [s, a] of starts) {
    console.log(`  ${s.padEnd(14)} ${String(a.shots).padStart(3)}회 (${pct(a.shots, allShots.length)}) | 골 ${a.goals} (${pct(a.goals, a.shots)})`);
  }

  console.log(`\n── 슛 전 빌드업 패스 수 분포 ──`);
  for (const [b, cnt] of Object.entries(buildupAgg)) {
    console.log(`  ${b.padEnd(10)} ${String(cnt).padStart(3)}회 (${pct(cnt, allShots.length)})`);
  }

  const counterShots = allShots.filter((s) => s.isCounter).length;
  console.log(`\n역습(카운터)로 인한 슈팅: ${counterShots}회 (${pct(counterShots, allShots.length)})`);
}

function renderProblems(results) {
  const { allShots, patternAgg, zoneAgg } = aggregate(results);
  const issues = [];
  const goals = allShots.filter((s) => s.result === 'GOAL').length;
  const N = allShots.length || 1;

  const conversion = goals / N;
  if (conversion < 0.12) issues.push(`골 전환율이 ${pct(goals, N)}로 매우 낮음 — 슈팅은 있는데 마무리 질이 떨어짐.`);

  const longZone = zoneAgg['25m 이상 (장거리)'] || { shots: 0, goals: 0 };
  const boxZone = zoneAgg['11~16.5m (페널티박스)'] || { shots: 0, goals: 0 };
  const sixZone = zoneAgg['0~5.5m (6야드박스)'] || { shots: 0, goals: 0 };
  const nearZone = zoneAgg['5.5~11m (골에어리어 인근)'] || { shots: 0, goals: 0 };
  if (longZone.shots / N > 0.25) {
    issues.push(`장거리 슛(25m+) 비중 ${pct(longZone.shots, N)} (골 ${pct(longZone.goals, longZone.shots)}) — 무리한 중거리 슛이 많음.`);
  }
  const closeShots = boxZone.shots + sixZone.shots + nearZone.shots;
  if (closeShots / N < 0.3) {
    issues.push(`페널티박스 내부+인근(11m 이내) 슛 비중이 ${pct(sixZone.shots + nearZone.shots, N)}, 페널티박스 포함 시 ${pct(closeShots, N)} — 결정적 기회(빅찬스) 창출 부족, 박스 근처까지 침투 못 함.`);
  }

  const saved = allShots.filter((s) => s.result.startsWith('SAVE')).length;
  if (saved / N > 0.45) issues.push(`슈팅 ${pct(saved, N)}가 골키퍼 정면으로 가고 있음 (세이브 비중 과다).`);

  const crossHeader = (patternAgg['CROSS_HEADER'] || { shots: 0 }).shots;
  const crossFoot = (patternAgg['CROSS_FOOT'] || { shots: 0 }).shots;
  const setPieceHeader = (patternAgg['SET_PIECE_HEADER'] || { shots: 0 }).shots;
  const crossTotal = crossHeader + crossFoot + setPieceHeader;
  if (crossTotal / N > 0.35) {
    issues.push(`크로스(코너 포함) 의존도가 ${pct(crossTotal, N)} — 측면 단조 공격. 크로스는 차단/세이브에 취약.`);
  }

  const throughShots = (patternAgg['THROUGH'] || { shots: 0 }).shots;
  if (throughShots / N < 0.08) {
    issues.push(`스루패스로 만든 슈팅이 ${pct(throughShots, N)}에 불과 — 수비 뒷공간 공략이 부족.`);
  }

  const highPressure = allShots.filter((s) => s.blockers >= 2).length;
  if (highPressure / N > 0.35) {
    issues.push(`슈팅 중 ${pct(highPressure, N)}가 차단자 2명 이상이 막고 있는 상황에서 시도 — 압박 속 무리한 슛이 많음.`);
  }

  const lowAngle = allShots.filter((s) => s.angle < 0.25).length;
  if (lowAngle / N > 0.3) {
    issues.push(`좁은 각도(시야각 <14°) 슛 비중 ${pct(lowAngle, N)} — 위치선정 없이 꽉 막힌 각에서 슛.`);
  }

  const avgBuildup = allShots.reduce((a, s) => a + s.buildup, 0) / N;
  if (avgBuildup < 3) {
    issues.push(`슛 전 평균 빌드업 패스 수 ${avgBuildup.toFixed(1)}회 — 조직적 빌드업보다 일발 슛/개인기 위주.`);
  }

  const parried = allShots.filter((s) => s.result === 'SAVE (GK 파리)').length;
  if (parried / N > 0.2) {
    issues.push(`GK가 파리(못잡고 튕김)한 슛 ${pct(parried, N)} — 세컨볼 처리가 약해 재공격 기회를 놓침.`);
  }

  // 팀별 슈팅 불균형
  const homeShots = allShots.filter((s) => s.team === 'home').length;
  const awayShots = allShots.filter((s) => s.team === 'away').length;
  const total = homeShots + awayShots;
  if (Math.abs(homeShots - awayShots) / total > 0.3) {
    const weak = homeShots < awayShots ? 'Home(4-4-2)' : 'Away(4-3-3)';
    const strong = homeShots < awayShots ? 'Away(4-3-3)' : 'Home(4-4-2)';
    issues.push(`슈팅 수 불균형: ${weak} ${homeShots}회 vs ${strong} ${awayShots}회 (${pct(Math.max(homeShots, awayShots), total)}) — ${weak}의 공격 창출력이 크게 부족.`);
  }

  console.log(`\n═══════════ 공격 문제점 진단 ═══════════`);
  if (issues.length === 0) {
    console.log('특별히 두드러지는 문제점 없음. (샘플이 적어 해석에 주의)');
  } else {
    issues.forEach((t, i) => console.log(`${i + 1}. ${t}`));
  }
}

// ---- 메인 ----
const runs = Number(process.argv[2] || 3);
const results = [];
for (let i = 0; i < runs; i++) {
  const r = await runOnce(i);
  results.push(r);
  console.log(`Run ${i + 1}: ${r.score} | 슈팅 ${r.shots.length}회 | Home ${r.shots.filter(s => s.team === 'home').length}회 / Away ${r.shots.filter(s => s.team === 'away').length}회`);
}

renderReport(results);
renderProblems(results);