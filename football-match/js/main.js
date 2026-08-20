/**
 * main.js — 씬 매니저 (메뉴 + 시나리오 로딩)
 *
 * 각 시나리오는 js/scenarios/ 에 위치하며
 * run(layer, loop) → stopFn 인터페이스를 구현한다.
 */
import { GameLoop }    from './GameLoop.js';
import * as SoloDribble from './scenarios/SoloDribble.js';

// ── 등록된 시나리오 ──────────────────────────────────────
const SCENARIOS = [
    { id: 'solo-dribble', label: '1인 드리블', module: SoloDribble },
];

// ── DOM 레퍼런스 ─────────────────────────────────────────
const layer = document.getElementById('entities-layer');
const menuList = document.getElementById('menu-list');

// ── 게임 루프 ─────────────────────────────────────────────
const loop = new GameLoop();
loop.start();

// ── 씬 상태 ──────────────────────────────────────────────
let currentStop = null;   // 현재 시나리오 정지 콜백
let activeId    = null;   // 현재 활성 시나리오 id

// ── 씬 전환 ──────────────────────────────────────────────
function runScenario(id) {
    // 현재 씬 정지
    if (currentStop) { currentStop(); currentStop = null; }

    // 엔티티 레이어 초기화
    while (layer.firstChild) layer.removeChild(layer.firstChild);

    // 메뉴 활성 상태 갱신
    activeId = id;
    document.querySelectorAll('.menu-btn').forEach(btn => {
        btn.classList.toggle('menu-btn--active', btn.dataset.id === id);
    });

    // 새 시나리오 실행
    const scenario = SCENARIOS.find(s => s.id === id);
    if (scenario) currentStop = scenario.module.run(layer, loop);
}

// ── 메뉴 빌드 ─────────────────────────────────────────────
SCENARIOS.forEach(({ id, label }) => {
    const btn = document.createElement('button');
    btn.className = 'menu-btn';
    btn.dataset.id = id;
    btn.textContent = label;
    btn.addEventListener('click', () => runScenario(id));
    menuList.appendChild(btn);
});

// ── 첫 시나리오 자동 시작 ─────────────────────────────────
runScenario(SCENARIOS[0].id);
