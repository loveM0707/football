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

// ── 등록된 시나리오 ──────────────────────────────────────
const SCENARIOS = [
    { id: 'solo-dribble',     label: '1인 드리블',     module: SoloDribble },
    { id: 'drive-to-goal',   label: '골까지 드리블',   module: DriveToGoal },
    { id: 'dribble-defense', label: '드리블 수비',     module: DribbleDefense },
];

// ── DOM 레퍼런스 ─────────────────────────────────────────
const layer        = document.getElementById('entities-layer');
const menuEl       = document.getElementById('play-menu');
const triggerBtn   = document.getElementById('menu-trigger');
const currentLabel = document.getElementById('menu-current-label');
const menuList     = document.getElementById('menu-list');

// ── 게임 루프 ─────────────────────────────────────────────
const loop = new GameLoop();
loop.start();

// ── 씬 상태 ──────────────────────────────────────────────
let currentStop = null;
let activeId    = null;

// ── 씬 전환 ──────────────────────────────────────────────
function runScenario(id) {
    if (currentStop) { currentStop(); currentStop = null; }

    // 엔티티 레이어 초기화
    while (layer.firstChild) layer.removeChild(layer.firstChild);

    activeId = id;
    const scenario = SCENARIOS.find(s => s.id === id);
    if (!scenario) return;

    // 트리거 버튼 레이블 갱신
    currentLabel.textContent = scenario.label;

    // 메뉴 버튼 활성 상태 갱신
    document.querySelectorAll('.menu-btn').forEach(btn => {
        btn.classList.toggle('menu-btn--active', btn.dataset.id === id);
    });

    currentStop = scenario.module.run(layer, loop);

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

// ── 첫 시나리오 자동 시작 ─────────────────────────────────
runScenario(SCENARIOS[0].id);
