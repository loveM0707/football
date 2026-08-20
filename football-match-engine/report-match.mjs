// 경기 현실성 리포트 — Section 35.
// 사용법: node report-match.mjs [분] [시드] [홈포메이션] [원정포메이션]
import { makeScenarioEngine } from './js/match/debug/ScenarioRunner.js';
import { checkRealismReport, validatePassTrajectories } from './js/match/debug/Diagnostics.js';

const DT = 1 / 60;
const minutes = Number(process.argv[2] ?? 90);
const seed = Number(process.argv[3] ?? Date.now() % 100000);
const homeFormation = process.argv[4] ?? '4-4-2';
const awayFormation = process.argv[5] ?? '4-3-3';

console.log(`패스 궤적 검증(Section 34) 먼저 실행...`);
const trajectory = validatePassTrajectories(DT);
console.log(`  ${trajectory.total}건 중 실패 ${trajectory.failures.length}건`);
for (const f of trajectory.failures) console.log(`  ✗ ${f.class} ${f.distance}m → ${f.reason}`);

console.log(`\n${minutes}분 경기 시뮬레이션 (시드 ${seed}, ${homeFormation} vs ${awayFormation})...`);
const engine = makeScenarioEngine({ seed, homeFormation, awayFormation });
engine.rules.kickOff(engine, engine.homeTeam);

const t0 = Date.now();
for (let i = 0; i < 60 * 60 * minutes; i++) engine.step(DT);
const ms = Date.now() - t0;

const summary = engine.statistics.summary(engine);
const warnings = checkRealismReport(summary);

const f90 = (n) => Math.round((n * 90) / minutes);

console.log(`\n=== 스코어 ${summary.score.home} : ${summary.score.away} ===`);
console.log(`시뮬레이션 시간 ${(minutes * 60 * 1000 / ms).toFixed(0)}배속 상당 (${ms}ms)\n`);

console.log('지표(90분 환산)         홈       원정');
const row = (label, key, suffix = '') =>
  console.log(`  ${label.padEnd(18)} ${String(f90(summary.home[key]) + suffix).padStart(8)} ${String(f90(summary.away[key]) + suffix).padStart(8)}`);
console.log(`  점유율             ${String(summary.home.possessionPct + '%').padStart(8)} ${String(summary.away.possessionPct + '%').padStart(8)}`);
row('패스 시도', 'passesAttempted');
console.log(`  평균 패스 거리(m)  ${String(summary.home.avgPassLength).padStart(8)} ${String(summary.away.avgPassLength).padStart(8)}`);
console.log(`  롱패스 비율(%)     ${String(summary.home.longPassPct).padStart(8)} ${String(summary.away.longPassPct).padStart(8)}`);
console.log(`  스루패스 비율(%)   ${String(summary.home.throughPassPct).padStart(8)} ${String(summary.away.throughPassPct).padStart(8)}`);
row('슛', 'shots');
row('유효슈팅', 'shotsOnTarget');
row('득점', 'goals');
row('태클', 'tackles');
row('파울', 'fouls');
row('오프사이드', 'offsides');
row('코너킥', 'corners');
row('스로인', 'throwIns');
row('골킥', 'goalKicks');
row('세이브', 'saves');
row('턴오버', 'turnovers');
console.log(`  평균 팀 길이(m)    ${String(summary.home.avgTeamLength).padStart(8)} ${String(summary.away.avgTeamLength).padStart(8)}`);
console.log(`  평균 수비라인(nx)  ${String(summary.home.avgDefensiveLineNX).padStart(8)} ${String(summary.away.avgDefensiveLineNX).padStart(8)}`);

console.log(`\n=== 현실성 경고 (Section 35) ===`);
if (warnings.length === 0) {
  console.log('  구조적 이상 없음');
} else {
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
