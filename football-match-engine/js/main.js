// ── UI 진입점 (어댑터) ──────────────────────────────────────────
// index.html / css / Renderer / UIManager는 그대로 두고, 그 아래의
// 시뮬레이션만 새 엔진(js/match/**)으로 교체한다. 이 파일은 새 엔진의
// 데이터 모델을 기존 렌더러가 기대하는 형태로 연결하는 역할만 한다.

import { Pitch } from './entities/Pitch.js';
import { Vector2D } from './entities/Vector2D.js';
import { Renderer } from './render/Renderer.js';
import { UIManager } from './render/UIManager.js';
import { GameLoop } from './core/GameLoop.js';

import { MatchEngine } from './match/core/MatchEngine.js';
import { Phase } from './match/core/MatchState.js';
import { Player, PlayerAttributes } from './match/entities/Player.js';
import { Team } from './match/entities/Team.js';
import { Role } from './match/tactics/RoleModel.js';

import { PossessionModel } from './match/sim/PossessionModel.js';
import { MovementEngine } from './match/sim/MovementEngine.js';
import { ActionSystem } from './match/sim/ActionSystem.js';
import { BallPhysics } from './match/ball/BallPhysics.js';
import { TacticalEngine } from './match/tactics/TacticalEngine.js';
import { DecisionEngine } from './match/ai/DecisionEngine.js';
import { RulesEngine } from './match/rules/RulesEngine.js';
import { RestartEngine } from './match/rules/RestartEngine.js';
import { MatchStatistics } from './match/stats/MatchStatistics.js';

const SIM_STEP = 1 / 60;

// ── 선수 능력치 프리셋 (역할별) ──────────────────────────────────
// 새 엔진의 PlayerAttributes 필드(js/match/entities/Player.js)에 맞춘 값이다.
// 포메이션이 실제 역할을 배정(Team._bindPlayers)하므로, 선수를 만들 때는
// 임시 역할로 두고 팀 생성 후 역할별 프리셋을 다시 입힌다.
const ROLE_ATTR_PRESETS = {
  [Role.GK]: { pace: 55, acceleration: 55, agility: 60, balance: 65, stamina: 65, strength: 65, dribbling: 35, firstTouch: 55, passing: 55, crossing: 20, longPassing: 50, vision: 60, decisionMaking: 65, positioning: 78, reactions: 78, shooting: 15, finishing: 15, shotPower: 40, heading: 40, tackling: 30, interceptions: 35 },
  [Role.CB]: { pace: 64, acceleration: 60, agility: 55, balance: 65, stamina: 70, strength: 82, dribbling: 48, firstTouch: 55, passing: 62, crossing: 35, longPassing: 58, vision: 58, decisionMaking: 68, positioning: 78, reactions: 62, shooting: 30, finishing: 25, shotPower: 55, heading: 75, tackling: 80, interceptions: 78 },
  [Role.FB]: { pace: 77, acceleration: 76, agility: 74, balance: 66, stamina: 78, strength: 68, dribbling: 65, firstTouch: 64, passing: 68, crossing: 70, longPassing: 60, vision: 62, decisionMaking: 65, positioning: 66, reactions: 64, shooting: 40, finishing: 35, shotPower: 50, heading: 50, tackling: 72, interceptions: 66 },
  [Role.DM]: { pace: 64, acceleration: 62, agility: 60, balance: 66, stamina: 80, strength: 74, dribbling: 60, firstTouch: 65, passing: 75, crossing: 40, longPassing: 70, vision: 68, decisionMaking: 74, positioning: 74, reactions: 64, shooting: 45, finishing: 35, shotPower: 55, heading: 58, tackling: 76, interceptions: 74 },
  [Role.CM]: { pace: 68, acceleration: 66, agility: 66, balance: 64, stamina: 80, strength: 65, dribbling: 70, firstTouch: 70, passing: 80, crossing: 55, longPassing: 74, vision: 80, decisionMaking: 80, positioning: 70, reactions: 66, shooting: 58, finishing: 52, shotPower: 60, heading: 52, tackling: 60, interceptions: 58 },
  [Role.AM]: { pace: 72, acceleration: 74, agility: 76, balance: 68, stamina: 72, strength: 58, dribbling: 80, firstTouch: 80, passing: 78, crossing: 60, longPassing: 65, vision: 82, decisionMaking: 78, positioning: 68, reactions: 70, shooting: 68, finishing: 65, shotPower: 62, heading: 48, tackling: 40, interceptions: 42 },
  [Role.WINGER]: { pace: 84, acceleration: 82, agility: 82, balance: 66, stamina: 74, strength: 56, dribbling: 80, firstTouch: 76, passing: 68, crossing: 78, longPassing: 55, vision: 68, decisionMaking: 68, positioning: 62, reactions: 70, shooting: 64, finishing: 58, shotPower: 60, heading: 45, tackling: 35, interceptions: 38 },
  [Role.ST]: { pace: 78, acceleration: 78, agility: 72, balance: 70, stamina: 70, strength: 72, dribbling: 76, firstTouch: 78, passing: 60, crossing: 40, longPassing: 45, vision: 62, decisionMaking: 70, positioning: 76, reactions: 74, shooting: 82, finishing: 82, shotPower: 78, heading: 68, tackling: 30, interceptions: 28 },
};

function rand(base, spread) {
  return Math.max(15, Math.min(99, Math.round(base + (Math.random() - 0.5) * 2 * spread)));
}

/** 프리셋에 개인차(spread)를 준 능력치 객체를 만든다 */
function rolledAttributes(role, spread) {
  const preset = ROLE_ATTR_PRESETS[role] ?? ROLE_ATTR_PRESETS[Role.CM];
  return Object.fromEntries(
    Object.entries(preset).map(([k, v]) => [k, rand(v, spread)])
  );
}

/** 11명의 선수를 만든다. 역할은 임시값이며 팀 생성 시 포메이션이 실제 역할을 배정한다. */
function buildRoster(prefix, spread) {
  const players = [];
  for (let i = 0; i < 11; i++) {
    players.push(new Player({
      id: `${prefix}-${i}`,
      name: `${prefix} ${i + 1}`,
      number: i + 1,
      role: Role.CM,
      attributes: rolledAttributes(Role.CM, spread),
    }));
  }
  return players;
}

/** 팀 생성 후(=포메이션이 실제 역할을 배정한 후) 역할별 능력치 프리셋을 입힌다 */
function applyRolePresets(team, spread) {
  for (const player of team.players) {
    player.attributes = new PlayerAttributes(rolledAttributes(player.role, spread));
  }
}

// ── 팀 구성 ──────────────────────────────────────────────────
const HOME_DEFAULT_TACTICS = {
  mentality: 'balanced', width: 0.5, compactness: 0.5, defensiveLineHeight: 0.5,
  pressingIntensity: 0.5, tackleAggression: 0.5, buildUpRisk: 0.5,
  attackDirectness: 0.5, passingDirectness: 0.5, tempo: 0.5, gkDistribution: 0.5,
};
const AWAY_DEFAULT_TACTICS = { ...HOME_DEFAULT_TACTICS };

const homeTeam = new Team({
  name: '서울 유나이티드', side: 'home', color: '#3b6fd6',
  formationName: '4-4-2', players: buildRoster('서울', 6), tactics: HOME_DEFAULT_TACTICS,
});
const awayTeam = new Team({
  name: '부산 아틀레틱', side: 'away', color: '#d6483b',
  formationName: '4-3-3', players: buildRoster('부산', 6), tactics: AWAY_DEFAULT_TACTICS,
});
applyRolePresets(homeTeam, 6);
applyRolePresets(awayTeam, 6);

// ── 엔진 구성 ──────────────────────────────────────────────────
const engine = new MatchEngine({ homeTeam, awayTeam, seed: Date.now() >>> 0, step: SIM_STEP });
const restarts = new RestartEngine(SIM_STEP);
const rules = new RulesEngine(restarts).attach(engine);
const statistics = new MatchStatistics().attach(engine);
engine.install({
  possession: new PossessionModel(),
  tactical: new TacticalEngine(),
  decisions: new DecisionEngine(SIM_STEP),
  actions: new ActionSystem(SIM_STEP),
  movement: new MovementEngine(),
  physics: new BallPhysics(SIM_STEP),
  rules, restarts, statistics,
});

const eventBus = engine.eventBus;

// 킥오프 전 초기 대형을 한 번 계산해 정지 화면으로 보여준다
engine.ball.placeAt(Pitch.center());
for (const team of engine.teams) {
  engine.tactical.update(engine, team, SIM_STEP);
  for (const player of team.players) player.position = player.anchor.clone();
}

const canvas = document.getElementById('field');
canvas.width = Pitch.renderWidth;
canvas.height = Pitch.renderHeight;
const ctx = canvas.getContext('2d');
const renderer = new Renderer(ctx);
const uiManager = new UIManager({ eventBus, homeTeam, awayTeam });

// 패스 라인 시각화: 새 엔진의 pass 이벤트 필드(distance/targetPos/type)를
// 렌더러가 기대하는 형태(dist/toPos/through)로 변환한다.
eventBus.on('pass', ({ from, to, type, lofted, distance, targetPos }) => {
  const through = type === 'THROUGH';
  renderer.recordPass({
    fromPos: from.position.clone(),
    toPos: (through && targetPos) ? targetPos.clone() : to.position.clone(),
    through,
    lofted: !!lofted,
    dist: distance ?? from.position.sub(to.position).length(),
  });
});

function update(dt) {
  // dt는 GameLoop가 이미 배속을 곱한 시뮬레이션 시간이다. MatchEngine.advance는
  // 이를 고정 스텝(1/60초)으로 잘라 실행한다 — 배속은 스텝 크기가 아니라
  // 스텝 "횟수"를 바꾸므로 물리 궤적은 배속과 무관하게 동일하다.
  engine.advance(dt, 1);
}

function render() {
  renderer.clear();
  renderer.drawPitch();
  renderer.drawPassLines();
  renderer.drawPlayers([...homeTeam.players, ...awayTeam.players], engine.ball);
  renderer.drawBall(engine.ball);
  uiManager.update(engine.state);
}

const gameLoop = new GameLoop({ update, render });
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
  gameLoop.stop();
  btnPlay.textContent = '재생';
  btnPlay.disabled = true;

  engine.state.reset();
  statistics.reset();
  for (const team of engine.teams) {
    team.resetState();
    team.possessionSeconds = 0;
  }
  engine.ball.reset();
  engine.ball.placeAt(Pitch.center());
  renderer._passLines = []; // 이전 경기의 잔상 패스 궤적 제거
  for (const team of engine.teams) {
    engine.tactical.update(engine, team, SIM_STEP);
    for (const player of team.players) {
      player.position = player.anchor.clone();
      player.velocity = Vector2D.zero();
      player.energy = 1;
    }
  }
  render();
  kickoffOverlay.classList.remove('hidden');
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
// on/off가 아니라 팀 전술 파라미터(TeamTactics)에 실수로 반영되므로, 지시와
// 다른 상황(빈 공간, 확실한 찬스 등)에서는 여전히 유연하게 다른 선택을 한다.
const TACTICS_FIELDS = [
  { key: 'mentality', label: '팀 전술', type: 'enum', options: [
    ['defensive', '수비적'], ['balanced', '균형'], ['attacking', '공격적'],
  ], default: 'balanced' },
  { key: 'width', label: '좌우 폭', type: 'range3', options: [[0, '좁음'], [0.5, '균형'], [1, '넓음']], default: 0.5 },
  { key: 'compactness', label: '컴팩트니스', type: 'range3', options: [[0, '느슨'], [0.5, '균형'], [1, '밀집']], default: 0.5 },
  { key: 'attackDirectness', label: '공격 방향', type: 'range3', options: [[0, '측면'], [0.5, '혼합'], [1, '중앙']], default: 0.5 },
  { key: 'tempo', label: '패스 템포', type: 'range3', options: [[0, '느림'], [0.5, '보통'], [1, '빠름']], default: 0.5 },
  { key: 'passingDirectness', label: '패스 유형', type: 'range3', options: [[0, '짧게'], [0.5, '혼합'], [1, '길게']], default: 0.5 },
  { key: 'buildUpRisk', label: '빌드업 리스크', type: 'range3', options: [[0, '안전'], [0.5, '균형'], [1, '과감']], default: 0.5 },
  { key: 'defensiveLineHeight', label: '수비 라인', type: 'range3', options: [[0, '깊음'], [0.5, '균형'], [1, '높음']], default: 0.5 },
  { key: 'pressingIntensity', label: '압박', type: 'range3', options: [[0, '물러서기'], [0.5, '하프라인'], [1, '전원수비']], default: 0.5 },
  { key: 'tackleAggression', label: '태클', type: 'range3', options: [[0, '신중하게'], [0.5, '보통'], [1, '헌신적']], default: 0.5 },
  { key: 'gkDistribution', label: '골키퍼 배급', type: 'range3', options: [[0, '짧은 패스'], [0.5, '혼합'], [1, '긴 패스']], default: 0.5 },
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

// 감독 지시 전달 시간(2~5초) 연출 — index.html 안내 문구와 일치시킨다.
// 즉시 적용하면 슬라이더를 만지자마자 팀이 순간이동하듯 반응해 부자연스럽다.
function scheduleTacticsApply(team, patch) {
  const delay = 2000 + Math.random() * 3000;
  setTimeout(() => team.tactics.apply(patch), delay);
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
      scheduleTacticsApply(team, { [field.key]: value });
    });
  });
}

buildTacticsPanel(document.getElementById('homeTacticsGrid'), homeTeam);
buildTacticsPanel(document.getElementById('awayTacticsGrid'), awayTeam);
document.getElementById('tacticsTeamNameHome').textContent = homeTeam.name;
document.getElementById('tacticsTeamNameAway').textContent = awayTeam.name;

// ---------- 경기 시작 게이팅 ----------
// 홈/원정 전술을 모두 설정한 뒤 '경기 시작' 버튼을 눌러야 킥오프된다.
// 리셋 후 오버레이가 다시 뜨면 같은 버튼으로 재킥오프할 수 있어야 하므로
// {once:true}를 쓰지 않고, 재생 중일 때만 무시하도록 막는다.
const kickoffOverlay = document.getElementById('kickoffOverlay');
const btnStartMatch = document.getElementById('btnStartMatch');
btnStartMatch.addEventListener('click', () => {
  if (gameLoop.running) return;
  kickoffOverlay.classList.add('hidden');
  btnPlay.disabled = false;
  rules.kickOff(engine, homeTeam);
  gameLoop.start();
  btnPlay.textContent = '일시정지';
});

// 디버깅/자동 테스트용 훅(런타임 상태 점검 목적, UI에는 영향 없음)
window.__match = { homeTeam, awayTeam, engine, gameLoop, statistics };
