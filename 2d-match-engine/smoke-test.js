// 스모크 테스트 — 전술 변경 후 전체 시뮬레이션 틱 루프가 무결함인지 확인
// 사용법: node smoke-test.js
import { Player } from './js/entities/Player.js';
import { Team } from './js/entities/Team.js';
import { MatchSimulator } from './js/core/MatchSimulator.js';
import { EventBus } from './js/core/EventBus.js';

const ROLE_ORDER = ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'];
function buildRoster(prefix) {
  return ROLE_ORDER.map((role, idx) => new Player({
    name: `${prefix} ${idx + 1}`, number: idx + 1, role,
    attributes: { pace: 70, acceleration: 70, passing: 70, shooting: 70, tackling: 70, positioning: 70, dribbling: 70, strength: 70, vision: 70, agility: 70, interception: 60, passSpeed: 70, shotSpeed: 70, decisionMaking: 70, power: 70, physical: 70 },
  }));
}

const homeTeam = new Team({ name: 'H', side: 'home', formationName: '4-4-2', players: buildRoster('H'), tacticsOptions: { mentality: 'attacking', defensiveLineHeight: 1, pressing: 1 } });
const awayTeam = new Team({ name: 'A', side: 'away', formationName: '4-3-3', players: buildRoster('A'), tacticsOptions: { mentality: 'defensive', defensiveLineHeight: 0, pressing: 0 } });
const sim = new MatchSimulator({ homeTeam, awayTeam, eventBus: new EventBus() });

// 전술 변경 지연(2~5초) 적용 — 즉시 반영
homeTeam.tactics.defensiveLineHeight = 1;
awayTeam.tactics.defensiveLineHeight = 0;

let errors = 0;
let moves = 0;
let inPlayMoves = 0;
let inPlayTicks = 0;
const dt = 0.02;
const N = 300; // 6초 시뮬
for (let i = 0; i < N; i++) {
  try {
    sim.tick(dt);
    const inPlay = sim.matchState.phase === 'IN_PLAY';
    if (i % 50 === 0) console.log(`  t=${(i * dt).toFixed(1)}s phase=${sim.matchState.phase} ball=(${sim.ball.position.x.toFixed(1)},${sim.ball.position.y.toFixed(1)}) owner=${sim.ball.owner?.name ?? '-'}`);
    // 모든 선수 위치가 유효 범위인지
    for (const p of [...homeTeam.players, ...awayTeam.players]) {
      if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.y)) {
        console.error(`  위치 NaN: ${p.name}`, p.position);
        errors++;
      }
      if (Math.abs(p.position.x) > 200 || Math.abs(p.position.y) > 200) {
        console.error(`  위치 이상: ${p.name} (${p.position.x.toFixed(1)}, ${p.position.y.toFixed(1)})`);
        errors++;
      }
      if (p.velocity.length() > 8) {
        console.error(`  속도 이상: ${p.name} ${p.velocity.length().toFixed(1)}`);
        errors++;
      }
      moves += p.velocity.length() > 0.1 ? 1 : 0;
      if (inPlay) { inPlayMoves += p.velocity.length() > 0.1 ? 1 : 0; inPlayTicks++; }
    }
  } catch (e) {
    console.error(`  tick ${i} 예외:`, e);
    errors++;
    break;
  }
}

console.log(`\n틱 ${N}회 완료. 이동 중 선수 수 평균 ≈ ${(moves / N / 22).toFixed(1)}/22, 오류 ${errors}건`);
console.log(`IN_PLAY 중 평균 이동 ≈ ${(inPlayMoves / Math.max(1, inPlayTicks)).toFixed(1)}/22`);
console.log(`공 위치: (${sim.ball.position.x.toFixed(1)}, ${sim.ball.position.y.toFixed(1)}) 소유자: ${sim.ball.owner?.name ?? '없음'}`);
if (errors === 0) console.log('SMOKE OK'); else console.log('SMOKE FAIL');