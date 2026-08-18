/**
 * run-through-pass-audit.mjs
 *
 * 스루패스(지상 / 로빙) 성공·실패 원인 분석 시뮬레이션.
 *
 * 추적 대상:
 *   - 패스 kick 시점: passTargetPlayer + isThroughPass 플래그로 스루패스 식별
 *   - 결과 분류:
 *       SUCCESS          수신자가 볼 소유
 *       INTERCEPTED      상대가 볼 탈취 (interception 이벤트 또는 상대팀 소유)
 *       BLOCKED          블록 (block 이벤트)
 *       OUT_OF_BOUNDS    아웃 (코너/스로인/골킥)
 *       GK_SAVED         골키퍼 세이브
 *       BALL_STOPPED     볼이 멈추기 전에 아무도 못 받음 (거리 미달)
 *       RECEIVER_LATE    수신자가 도착했을 때 볼이 이미 지나쳐 있음
 *       DISPOSSESSED     받은 직후 태클 탈취
 *       OFFSIDE          오프사이드
 *       GOAL             골로 연결 (직접 득점)
 *       UNKNOWN          위 범주에 해당 없음
 */

import { Player }          from './js/entities/Player.js';
import { Team }            from './js/entities/Team.js';
import { EventBus }        from './js/core/EventBus.js';
import { MatchSimulator }  from './js/core/MatchSimulator.js';
import { Pitch }           from './js/entities/Pitch.js';
import { Vector2D }        from './js/entities/Vector2D.js';

// ── 선수 생성 (run-sim.mjs 동일) ──────────────────────────────────────────────
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
    return new Player({ name: `${prefix} ${idx + 1}`, number: idx + 1, role, attributes });
  });
}

// ── 분석 결과 누산 ────────────────────────────────────────────────────────────
const totals = {
  ground: { total: 0, outcome: {} },
  lofted: { total: 0, outcome: {} },
};

function inc(bucket, key) {
  bucket.total++;
  bucket.outcome[key] = (bucket.outcome[key] ?? 0) + 1;
}

// ── 패스 상황 기록 구조 ───────────────────────────────────────────────────────
/**
 * 스루패스 한 개를 추적하는 객체.
 * kick 이벤트 시점에 생성, 결과 이벤트에서 닫힌다.
 */
class ThroughPassTracker {
  constructor({ receiver, targetPos, isLofted, passerPos, kickTime }) {
    this.receiver    = receiver;   // 수신 예정 선수 (Player)
    this.targetPos   = targetPos;  // 목표 지점 (Vector2D | null)
    this.isLofted    = isLofted;
    this.passerPos   = passerPos;
    this.kickTime    = kickTime;
    this.resolved    = false;
    this.outcome     = null;
    this.detail      = '';
  }

  resolve(outcome, detail = '') {
    if (this.resolved) return;
    this.resolved = true;
    this.outcome  = outcome;
    this.detail   = detail;
  }
}

// ── 단일 게임 실행 ────────────────────────────────────────────────────────────
async function runOnce() {
  const homeTeam = new Team({ name: 'Home', side: 'home', color: '#3b6fd6', formationName: '4-4-2', players: buildRoster('Home', 6) });
  const awayTeam = new Team({ name: 'Away', side: 'away', color: '#d6483b', formationName: '4-3-3', players: buildRoster('Away', 6) });

  const eventBus   = new EventBus();
  const simulator  = new MatchSimulator({ homeTeam, awayTeam, eventBus });
  const ball       = simulator.ball;

  // 진행 중인 스루패스 추적 목록 (복수 동시 발생 가능)
  // key = receiver (Player 참조), value = ThroughPassTracker
  const active = new Map();
  let gameTime = 0;

  // ── 도우미 ─────────────────────────────────────────────────────────────────
  function resolveAll(outcome, detail) {
    for (const trk of active.values()) trk.resolve(outcome, detail);
  }

  function finalize(trk) {
    if (!trk.resolved) trk.resolve('UNKNOWN');
    const bucket = trk.isLofted ? totals.lofted : totals.ground;
    inc(bucket, trk.outcome);
  }

  // ── 이벤트 후킹 ───────────────────────────────────────────────────────────
  // [1] pass 이벤트: 스루패스이면 트래커 생성
  eventBus.on('pass', (e) => {
    if (!e.through) return;
    // 이전에 같은 수신자로 열린 트래커가 있으면 UNKNOWN으로 닫기
    const existing = active.get(e.to);
    if (existing) finalize(existing);

    const trk = new ThroughPassTracker({
      receiver:  e.to,
      targetPos: e.targetPos ? new Vector2D(e.targetPos.x, e.targetPos.y) : null,
      isLofted:  e.lofted,
      passerPos: e.from ? new Vector2D(e.from.position.x, e.from.position.y) : null,
      kickTime:  gameTime,
    });
    active.set(e.to, trk);
  });

  // [2] interception: 볼 궤적 위에서 상대가 가로챔
  eventBus.on('interception', (e) => {
    for (const [recv, trk] of active) {
      if (e.player && e.player.team !== recv.team) {
        trk.resolve('INTERCEPTED', `by ${e.player.role}`);
      }
    }
  });

  // [3] block: 블록
  eventBus.on('block', () => resolveAll('BLOCKED'));

  // [4] save: GK 세이브
  eventBus.on('save', () => resolveAll('GK_SAVED'));

  // [5] goal: 득점
  eventBus.on('goal', () => resolveAll('GOAL'));

  // [6] offside
  eventBus.on('offside', (e) => {
    const trk = active.get(e.player);
    if (trk) trk.resolve('OFFSIDE');
  });

  // [7] tackle: 태클
  eventBus.on('tackle', (e) => {
    // 공 소유자가 수신자이면 → DISPOSSESSED
    for (const [recv, trk] of active) {
      if (e.winner && e.winner.team !== recv.team) {
        // 태클 당한 사람이 수신자인지는 직접 알 수 없으므로,
        // 볼 소유자가 수신자일 때(이미 받은 뒤 태클) 또는 아직 받기 전(진행 중) 모두 체크
        if (ball.owner === recv) {
          trk.resolve('DISPOSSESSED', `by ${e.winner.role}`);
        }
      }
    }
  });

  // [8] restart(아웃): 코너·스로인·골킥 → 볼이 경계 밖으로 나감
  eventBus.on('restart', (e) => {
    if (e.type === 'CORNER' || e.type === 'THROW_IN' || e.type === 'GOAL_KICK') {
      resolveAll('OUT_OF_BOUNDS', e.type);
    }
    // 재시작 시점에 아직 미해결 트래커는 모두 닫음
    for (const trk of active.values()) {
      if (!trk.resolved) trk.resolve('OUT_OF_BOUNDS', e.type);
    }
  });

  // ── 메인 루프 ─────────────────────────────────────────────────────────────
  const dt    = Number(process.env.SIM_DT ?? 1 / 60);
  const steps = Math.round(5400 / dt);

  for (let i = 0; i < steps; i++) {
    gameTime += dt;
    simulator.tick(dt);

    // 매 틱마다 열린 트래커 상태 폴링
    for (const [recv, trk] of active) {
      if (trk.resolved) {
        finalize(trk);
        active.delete(recv);
        continue;
      }

      // ─ 볼 소유자가 수신자이면 SUCCESS ──────────────────────────────────
      if (ball.owner === recv) {
        trk.resolve('SUCCESS');
        finalize(trk);
        active.delete(recv);
        continue;
      }

      // ─ 볼 소유자가 상대팀이면 INTERCEPTED ─────────────────────────────
      if (ball.owner && ball.owner.team !== recv.team && ball.owner.role !== 'GK') {
        trk.resolve('INTERCEPTED', `by ${ball.owner.role} (owner)`);
        finalize(trk);
        active.delete(recv);
        continue;
      }

      // ─ GK가 볼을 잡았으면 GK_SAVED ────────────────────────────────────
      if (ball.owner && ball.owner.role === 'GK' && ball.owner.team !== recv.team) {
        trk.resolve('GK_SAVED');
        finalize(trk);
        active.delete(recv);
        continue;
      }

      // ─ 볼이 멈췄는데(속도 < 0.5m/s) 아무도 받지 못한 경우 ──────────────
      const ballStopped = ball.speed() < 0.5 && ball.height < 0.3;
      if (ballStopped && !ball.owner) {
        // 수신자와 볼 거리로 세부 원인 구분
        const distToBall = recv.position.sub(ball.position).length();
        if (distToBall > 8) {
          trk.resolve('BALL_STOPPED', `recv ${distToBall.toFixed(1)}m away`);
        } else {
          // 볼은 멈췄지만 수신자가 근처인 경우 — 루즈볼로 경합
          trk.resolve('BALL_STOPPED', `loose near recv ${distToBall.toFixed(1)}m`);
        }
        finalize(trk);
        active.delete(recv);
        continue;
      }

      // ─ 타임아웃: 킥 후 10초 이상 미해결 → UNKNOWN ─────────────────────
      if (gameTime - trk.kickTime > 10) {
        trk.resolve('UNKNOWN', 'timeout');
        finalize(trk);
        active.delete(recv);
      }
    }
  }

  // 루프 종료 시 남은 트래커 처리
  for (const trk of active.values()) finalize(trk);
  active.clear();
}

// ── 여러 게임 반복 ────────────────────────────────────────────────────────────
const RUNS = Number(process.env.SIM_RUNS ?? 4);
for (let r = 0; r < RUNS; r++) {
  process.stdout.write(`  게임 ${r + 1}/${RUNS} 시뮬레이션 중...\r`);
  await runOnce();
}
console.log('\n');

// ── 결과 출력 ─────────────────────────────────────────────────────────────────
function printSection(label, bucket) {
  if (bucket.total === 0) { console.log(`[${label}] 데이터 없음`); return; }
  console.log(`\n━━━ ${label} (총 ${bucket.total}회) ━━━`);
  const sorted = Object.entries(bucket.outcome).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) {
    const pct = (v / bucket.total * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(v / bucket.total * 30));
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)}회  ${pct.padStart(5)}%  ${bar}`);
  }
}

const gTotal = totals.ground.total + totals.lofted.total;
const gSuccess = (totals.ground.outcome.SUCCESS ?? 0) + (totals.lofted.outcome.SUCCESS ?? 0);
console.log(`\n${'═'.repeat(55)}`);
console.log(`  스루패스 종합 분석  (${RUNS}경기, 총 ${gTotal}회)`);
console.log(`  성공률: ${gTotal > 0 ? (gSuccess / gTotal * 100).toFixed(1) : '-'}%  (${gSuccess}/${gTotal})`);
console.log(`${'═'.repeat(55)}`);
printSection('지상 스루패스', totals.ground);
printSection('로빙 스루패스', totals.lofted);

// ── 원인 요약 (ground + lofted 합산) ─────────────────────────────────────────
console.log('\n━━━ 합산 원인 요약 ━━━');
const combined = {};
for (const bucket of [totals.ground, totals.lofted]) {
  for (const [k, v] of Object.entries(bucket.outcome)) {
    combined[k] = (combined[k] ?? 0) + v;
  }
}
const combinedTotal = Object.values(combined).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(combined).sort((a, b) => b[1] - a[1])) {
  const pct = (v / combinedTotal * 100).toFixed(1);
  console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)}회  ${pct.padStart(5)}%`);
}
