import { Player } from './entities/Player.js';
import { Team } from './entities/Team.js';
import { Pitch } from './entities/Pitch.js';
import { EventBus } from './core/EventBus.js';
import { GameLoop } from './core/GameLoop.js';
import { MatchSimulator } from './core/MatchSimulator.js';
import { Renderer } from './render/Renderer.js';
import { UIManager } from './render/UIManager.js';

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

const homeTeam = new Team({
  name: '서울 유나이티드',
  side: 'home',
  color: '#3b6fd6',
  formationName: '4-4-2',
  players: buildRoster('서울', 6),
});

const awayTeam = new Team({
  name: '부산 아틀레틱',
  side: 'away',
  color: '#d6483b',
  formationName: '4-3-3',
  players: buildRoster('부산', 6),
});

const eventBus = new EventBus();
const simulator = new MatchSimulator({ homeTeam, awayTeam, eventBus });

const canvas = document.getElementById('field');
canvas.width = Pitch.renderWidth;
canvas.height = Pitch.renderHeight;
const ctx = canvas.getContext('2d');
const renderer = new Renderer(ctx);
const uiManager = new UIManager({ eventBus, homeTeam, awayTeam });

// 패스 라인 시각화: 패스 이벤트를 수신해 렌더러에 궤적 데이터 전달
eventBus.on('pass', ({ from, to, through, lofted, dist, targetPos }) => {
  renderer.recordPass({
    fromPos: from.position.clone(),
    toPos: (through && targetPos) ? targetPos.clone() : to.position.clone(),
    through: !!through,
    lofted: !!lofted,
    dist: dist ?? from.position.sub(to.position).length(),
  });
});

function update(dt) {
  simulator.tick(dt);
}

function render() {
  renderer.clear();
  renderer.drawPitch();
  renderer.drawPassLines();
  renderer.drawPlayers([...homeTeam.players, ...awayTeam.players], simulator.ball);
  renderer.drawBall(simulator.ball);
  uiManager.update(simulator.matchState);
}

const gameLoop = new GameLoop({ update, render });
gameLoop.start();

// ---------- 컨트롤 UI 연결 ----------

const btnPlay = document.getElementById('btnPlay');
const btnReset = document.getElementById('btnReset');
const speedSelect = document.getElementById('speedSelect');

btnPlay.addEventListener('click', () => {
  if (gameLoop.running) {
    gameLoop.stop();
    btnPlay.textContent = '재생';
  } else {
    gameLoop.start();
    btnPlay.textContent = '일시정지';
  }
});

btnReset.addEventListener('click', () => {
  simulator.reset();
});

const aiDebugCheck = document.getElementById('aiDebugCheck');
aiDebugCheck.addEventListener('change', () => {
  renderer.showAI = aiDebugCheck.checked;
});

speedSelect.addEventListener('change', () => {
  gameLoop.setTimeScale(Number(speedSelect.value));
});
gameLoop.setTimeScale(Number(speedSelect.value));

// ---------- 홈팀 전술 패널 연결 ----------

function bindSlider(id, onChange) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => onChange(Number(el.value) / 100));
}

document.getElementById('mentalitySelect').addEventListener('change', (e) => {
  homeTeam.tactics.mentality = e.target.value;
});
bindSlider('tempoSlider', (v) => (homeTeam.tactics.tempo = v));
bindSlider('widthSlider', (v) => (homeTeam.tactics.width = v));
bindSlider('pressingSlider', (v) => (homeTeam.tactics.pressing = v));
bindSlider('directnessSlider', (v) => (homeTeam.tactics.passingDirectness = v));
bindSlider('lineHeightSlider', (v) => (homeTeam.tactics.defensiveLineHeight = v));

// 디버깅/자동 테스트용 훅(런타임 상태 점검 목적, UI에는 영향 없음)
window.__match = { homeTeam, awayTeam, simulator };
