/**
 * main.js — 씬 매니저 (상단 바 드롭다운 + 시나리오 로딩)
 *
 * 각 시나리오는 js/scenarios/ 에 위치하며
 * run(layer, loop) → stopFn 인터페이스를 구현한다.
 */
import { GameLoop }         from './GameLoop.js';
import * as SoloDribble     from './scenarios/SoloDribble.js';
import * as DriveToGoal     from './scenarios/DriveToGoal.js';
import * as DribbleDefense  from './scenarios/DribbleDefense.js';
import * as TwoPlayerPass   from './scenarios/TwoPlayerPass.js';
import * as FourPlayerPass        from './scenarios/FourPlayerPass.js';
import * as FourPlayerPassDefense from './scenarios/FourPlayerPassDefense.js';
import * as FourPlayerPassCoopDefense from './scenarios/FourPlayerPassCoopDefense.js';
import * as ThroughPass     from './scenarios/ThroughPass.js';
import * as ThroughPassDefense from './scenarios/ThroughPassDefense.js';
import * as LobbedThroughPass from './scenarios/LobbedThroughPass.js';
import * as Shooting         from './scenarios/Shooting.js';
import * as ShootingWithGoalkeeper from './scenarios/ShootingWithGoalkeeper.js';
import * as HeadingPass from './scenarios/HeadingPass.js';
import * as HeadingShot from './scenarios/HeadingShot.js';
import * as CrossHeader from './scenarios/CrossHeader.js';
import * as OneVsOne from './scenarios/OneVsOne.js';
import * as TwoVsTwo from './scenarios/TwoVsTwo.js';
import * as ThreeVsThree from './scenarios/ThreeVsThree.js';

// ── 등록된 시나리오 ──────────────────────────────────────
const SCENARIOS = [
    { id: 'solo-dribble',            label: '1인 드리블',      module: SoloDribble },
    { id: 'drive-to-goal',          label: '골까지 드리블',    module: DriveToGoal },
    { id: 'dribble-defense',        label: '드리블 돌파',      module: DribbleDefense },
    { id: 'two-player-pass',        label: '2인 패스',         module: TwoPlayerPass },
    { id: 'four-player-pass',       label: '4인 패스',         module: FourPlayerPass },
    { id: 'four-player-pass-defense', label: '4인 패스(수비)', module: FourPlayerPassDefense },
    { id: 'four-player-pass-coop-defense', label: '4인 패스(협력수비)', module: FourPlayerPassCoopDefense },
    { id: 'through-pass',            label: '스루패스',          module: ThroughPass },
    { id: 'through-pass-defense',    label: '스루패스(수비)',     module: ThroughPassDefense },
    { id: 'lobbed-through-pass',     label: '로빙 스루패스',      module: LobbedThroughPass },
    { id: 'shooting',                label: '슈팅',               module: Shooting },
    { id: 'shooting-with-goalkeeper', label: '슈팅(골키퍼)',      module: ShootingWithGoalkeeper },
    { id: 'heading-pass',            label: '헤딩 패스',         module: HeadingPass },
    { id: 'heading-shot',            label: '헤딩 슛',           module: HeadingShot },
    { id: 'cross-header',             label: '크로스-헤딩',       module: CrossHeader },
    { id: 'one-vs-one',                label: '1:1',               module: OneVsOne },
    { id: 'two-vs-two',                label: '2:2',               module: TwoVsTwo },
    { id: 'three-vs-three',            label: '3:3',               module: ThreeVsThree },
];

// ── DOM 레퍼런스 ─────────────────────────────────────────
const layer        = document.getElementById('entities-layer');
const menuEl       = document.getElementById('play-menu');
const triggerBtn   = document.getElementById('menu-trigger');
const currentLabel = document.getElementById('menu-current-label');
const menuList     = document.getElementById('menu-list');
const resetBtn     = document.getElementById('reset-btn');
const resultEl     = document.getElementById('match-result');

const RESULT_LABELS = {
    goal: '골',
    save: '세이브',
    'miss-wide': '노골 · 옆으로 빗나감',
    'miss-high': '노골 · 골대 위',
    post: '골대 맞음',
    crossbar: '크로스바 맞음',
    complete: '완료',
    'post-rebound': '골대 맞음',
    out: '라인 아웃',
    defend: '수비 성공',
};

// ── 게임 루프 ─────────────────────────────────────────────
const loop = new GameLoop();
loop.start();

// ── 씬 상태 ──────────────────────────────────────────────
let currentStop  = null;
let activeId     = null;
let resetTimer   = null; // 자동 리셋 타이머

// ── 씬 전환 ──────────────────────────────────────────────
function runScenario(id) {
    // 대기 중인 자동 리셋 취소
    if (resetTimer !== null) { clearTimeout(resetTimer); resetTimer = null; }

    if (currentStop) { currentStop(); currentStop = null; }

    // 엔티티 레이어 초기화
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    resultEl.textContent = '';
    delete resultEl.dataset.visible;

    activeId = id;
    const scenario = SCENARIOS.find(s => s.id === id);
    if (!scenario) return;

    // 트리거 버튼 레이블 갱신
    currentLabel.textContent = scenario.label;

    // 메뉴 버튼 활성 상태 갱신
    document.querySelectorAll('.menu-btn').forEach(btn => {
        btn.classList.toggle('menu-btn--active', btn.dataset.id === id);
    });

    // 시나리오 완료 시 2초 후 자동 리셋
    function onComplete(result = null) {
        if (result !== null && RESULT_LABELS[result]) {
            resultEl.textContent = RESULT_LABELS[result];
            resultEl.dataset.visible = '';
        }
        resetTimer = setTimeout(() => {
            resetTimer = null;
            runScenario(activeId);
        }, 2000);
    }

    currentStop = scenario.module.run(layer, loop, onComplete);

    // 드롭다운 닫기
    closeMenu();
}

// ── 드롭다운 열기/닫기 ────────────────────────────────────
function openMenu() {
    menuEl.dataset.open = '';
    triggerBtn.setAttribute('aria-expanded', 'true');
}

function closeMenu() {
    delete menuEl.dataset.open;
    triggerBtn.setAttribute('aria-expanded', 'false');
}

function toggleMenu() {
    if ('open' in menuEl.dataset) closeMenu();
    else openMenu();
}

// 트리거 클릭
triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
});

// 바깥 클릭 시 닫기
document.addEventListener('click', () => closeMenu());

// 드롭다운 내부 클릭은 이벤트 버블 차단
menuList.addEventListener('click', (e) => e.stopPropagation());

// Escape 키로 닫기
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
});

// ── 메뉴 빌드 ─────────────────────────────────────────────
SCENARIOS.forEach(({ id, label }) => {
    const li  = document.createElement('li');
    li.setAttribute('role', 'menuitem');
    const btn = document.createElement('button');
    btn.className    = 'menu-btn';
    btn.dataset.id   = id;
    btn.textContent  = label;
    btn.addEventListener('click', () => runScenario(id));
    li.appendChild(btn);
    menuList.appendChild(li);
});

// 리셋 버튼
resetBtn.addEventListener('click', () => {
    if (activeId) runScenario(activeId);
});

// ── 첫 시나리오 자동 시작 ─────────────────────────────────
runScenario(SCENARIOS[0].id);
