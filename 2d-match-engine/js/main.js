import { Player } from './entities/Player.js';
import { Team } from './entities/Team.js';
import { Pitch } from './entities/Pitch.js';
import { EventBus } from './core/EventBus.js';
import { GameLoop } from './core/GameLoop.js';
import { MatchSimulator } from './core/MatchSimulator.js';
import { Renderer } from './render/Renderer.js';
import { Camera } from './render/Camera.js';
import { UIManager } from './render/UIManager.js';

function rand(base, spread) {
  return Math.round(base + (Math.random() - 0.5) * 2 * spread);
}

const ROLE_ORDER = ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'];

const ROLE_ATTR_PRESETS = {
  GK: { pace: 55, acceleration: 55, tackling: 40, passing: 55, shooting: 20, dribbling: 40, strength: 65, positioning: 75, reflexes: 78 },
  LB: { pace: 74, acceleration: 74, tackling: 72, passing: 68, shooting: 45, dribbling: 65, strength: 68, positioning: 68, reflexes: 40 },
  RB: { pace: 74, acceleration: 74, tackling: 72, passing: 68, shooting: 45, dribbling: 65, strength: 68, positioning: 68, reflexes: 40 },
  CB: { pace: 66, acceleration: 62, tackling: 80, passing: 62, shooting: 35, dribbling: 50, strength: 82, positioning: 78, reflexes: 40 },
  LM: { pace: 76, acceleration: 76, tackling: 55, passing: 74, shooting: 60, dribbling: 76, strength: 58, positioning: 65, reflexes: 40 },
  RM: { pace: 76, acceleration: 76, tackling: 55, passing: 74, shooting: 60, dribbling: 76, strength: 58, positioning: 65, reflexes: 40 },
  CM: { pace: 68, acceleration: 66, tackling: 65, passing: 80, shooting: 58, dribbling: 70, strength: 65, positioning: 72, reflexes: 40 },
  ST: { pace: 78, acceleration: 78, tackling: 35, passing: 60, shooting: 82, dribbling: 75, strength: 70, positioning: 74, reflexes: 40 },
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
canvas.width = Pitch.canvasWidth;
canvas.height = Pitch.canvasHeight;
const ctx = canvas.getContext('2d');
const renderer = new Renderer(ctx);
const camera = new Camera();
const uiManager = new UIManager({ eventBus, homeTeam, awayTeam });

function update(dt) {
  simulator.tick(dt);
  camera.update(simulator.ball, dt);
}

function render() {
  renderer.clear();
  ctx.save();
  camera.applyTransform(ctx);
  renderer.drawPitch();
  renderer.drawPlayers([...homeTeam.players, ...awayTeam.players]);
  renderer.drawBall(simulator.ball);
  ctx.restore();
  uiManager.update(simulator.matchState);
}

const gameLoop = new GameLoop({ update, render });
gameLoop.start();

// ---------- 컨트롤 UI 연결 ----------

const btnPlay = document.getElementById('btnPlay');
const btnReset = document.getElementById('btnReset');
const btnCamera = document.getElementById('btnCamera');
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

btnCamera.addEventListener('click', () => {
  camera.toggleMode();
  btnCamera.textContent = camera.mode === 'FULL' ? '카메라: 전체 화면' : '카메라: 공 따라가기';
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
