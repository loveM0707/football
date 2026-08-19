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

// 역할별 스피드/피지컬 성향: 측면 선수(LM/RM/LB/RB)는 페이스가 빠른 편이고,
// 중앙 공격수(ST)는 드리블 스피드(dribbling)와 피지컬이 가장 높다.
// 피지컬(physical)은 몸싸움 볼 소유 유지율과 헤딩 경합 승률에 직결되며
// 센터백·중앙 공격수가 평균적으로 높다.
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

// ── 두 팀의 기본 전술 (경기 시작 시 프리셋) ────────────────────
// 양팀 모두 균형(balanced) 기본값으로 시작한다.
// 기초 동작을 먼저 검증한 뒤 세부 옵션을 조정하기 위함이다.
const HOME_DEFAULT_TACTICS = {
  mentality: 'balanced',
  width: 0.5,
  attackDirectness: 0.5,
  tempo: 0.5,
  passingDirectness: 0.5,
  defensiveLineHeight: 0.5,
  pressing: 0.5,
  tackleAggression: 0.5,
  gkDistribution: 0.5,
};

const AWAY_DEFAULT_TACTICS = {
  mentality: 'balanced',
  width: 0.5,
  attackDirectness: 0.5,
  tempo: 0.5,
  passingDirectness: 0.5,
  defensiveLineHeight: 0.5,
  pressing: 0.5,
  tackleAggression: 0.5,
  gkDistribution: 0.5,
};

const homeTeam = new Team({
  name: '서울 유나이티드',
  side: 'home',
  color: '#3b6fd6',
  formationName: '4-4-2',
  players: buildRoster('서울', 6),
  tacticsOptions: HOME_DEFAULT_TACTICS,
});

const awayTeam = new Team({
  name: '부산 아틀레틱',
  side: 'away',
  color: '#d6483b',
  formationName: '4-3-3',
  players: buildRoster('부산', 6),
  tacticsOptions: AWAY_DEFAULT_TACTICS,
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
// 경기는 자동으로 시작하지 않는다 — 홈/원정 전술을 설정한 뒤 '경기 시작' 버튼을
// 눌러야 킥오프된다. 그 전까지는 초기 대형만 한 번 그려서 보여준다.
render();

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

// ---------- 전술 패널 연결 (홈/원정 공통) ----------
// 각 항목은 세 단계(0 / 0.5 / 1, 멘탈리티는 문자열)로 구성된다. 극단적인
// on/off가 아니라 AI 유틸리티 점수에 배율/가산치로 섞여 들어가므로, 지시와
// 다른 상황(빈 공간, 확실한 찬스 등)에서는 여전히 유연하게 다른 선택을 한다.
const TACTICS_FIELDS = [
  { key: 'mentality', label: '팀 전술', type: 'enum', options: [
    ['defensive', '수비적'], ['balanced', '균형'], ['attacking', '공격적'],
  ], default: 'balanced' },
  { key: 'width', label: '좌우 폭', type: 'range3', options: [
    [0, '좁음'], [0.5, '균형'], [1, '넓음'],
  ], default: 0.5 },
  { key: 'attackDirectness', label: '공격 방향', type: 'range3', options: [
    [0, '측면'], [0.5, '혼합'], [1, '중앙'],
  ], default: 0.5 },
  { key: 'tempo', label: '패스 템포', type: 'range3', options: [
    [0, '느림'], [0.5, '보통'], [1, '빠름'],
  ], default: 0.5 },
  { key: 'passingDirectness', label: '패스 유형', type: 'range3', options: [
    [0, '짧게'], [0.5, '혼합'], [1, '길게'],
  ], default: 0.5 },
  { key: 'defensiveLineHeight', label: '수비 라인', type: 'range3', options: [
    [0, '깊음'], [0.5, '균형'], [1, '높음'],
  ], default: 0.5 },
  { key: 'pressing', label: '압박', type: 'range3', options: [
    [0, '물러서기'], [0.5, '하프라인'], [1, '전원수비'],
  ], default: 0.5 },
  { key: 'tackleAggression', label: '태클', type: 'range3', options: [
    [0, '신중하게'], [0.5, '보통'], [1, '헌신적'],
  ], default: 0.5 },
  { key: 'gkDistribution', label: '골키퍼 배급', type: 'range3', options: [
    [0, '짧은 패스'], [0.5, '혼합'], [1, '긴 패스'],
  ], default: 0.5 },
];

function nearestOptionValue(field, current) {
  if (field.type === 'enum') return current;
  let best = field.options[0][0];
  let bestDiff = Infinity;
  for (const [val] of field.options) {
    const diff = Math.abs(val - current);
    if (diff < bestDiff) { bestDiff = diff; best = val; }
  }
  return best;
}

function buildTacticsPanel(gridEl, team) {
  gridEl.innerHTML = TACTICS_FIELDS.map((field) => {
    const current = nearestOptionValue(field, team.tactics[field.key] ?? field.default);
    const opts = field.options.map(([val, text]) => {
      const selected = val === current ? ' selected' : '';
      return `<option value="${val}"${selected}>${text}</option>`;
    }).join('');
    return `<label class="field-row"><span>${field.label}</span><select data-field="${field.key}">${opts}</select></label>`;
  }).join('');

  gridEl.querySelectorAll('select[data-field]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const field = TACTICS_FIELDS.find((f) => f.key === sel.dataset.field);
      const value = field.type === 'enum' ? sel.value : Number(sel.value);
      team.applyTacticsChange({ [field.key]: value });
    });
  });
}

buildTacticsPanel(document.getElementById('homeTacticsGrid'), homeTeam);
buildTacticsPanel(document.getElementById('awayTacticsGrid'), awayTeam);
document.getElementById('tacticsTeamNameHome').textContent = homeTeam.name;
document.getElementById('tacticsTeamNameAway').textContent = awayTeam.name;

// ---------- 경기 시작 게이팅 ----------
// 홈/원정 전술을 모두 설정한 뒤 '경기 시작' 버튼을 눌러야 킥오프된다.
const kickoffOverlay = document.getElementById('kickoffOverlay');
const btnStartMatch = document.getElementById('btnStartMatch');
btnStartMatch.addEventListener('click', () => {
  kickoffOverlay.classList.add('hidden');
  btnPlay.disabled = false;
  gameLoop.start();
}, { once: true });

// 디버깅/자동 테스트용 훅(런타임 상태 점검 목적, UI에는 영향 없음)
window.__match = { homeTeam, awayTeam, simulator, gameLoop };
