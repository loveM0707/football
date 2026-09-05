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
import * as OneVsOneDuel from './scenarios/OneVsOneDuel.js';
import * as TwoVsOne from './scenarios/TwoVsOne.js';
import * as TwoVsTwo from './scenarios/TwoVsTwo.js';
import * as ThreeVsThree from './scenarios/ThreeVsThree.js';

// ── 등록된 시나리오 ──────────────────────────────────────
// category: 서랍 메뉴 그룹. 신규 메뉴 추가 시 해당 그룹명만 지정하면 자동 분류된다.
const SCENARIOS = [
    { id: 'solo-dribble',            label: '1인 드리블',      category: '드리블', module: SoloDribble },
    { id: 'drive-to-goal',          label: '골까지 드리블',    category: '드리블', module: DriveToGoal },
    { id: 'dribble-defense',        label: '드리블 돌파',      category: '드리블', module: DribbleDefense },
    { id: 'two-player-pass',        label: '2인 패스',         category: '패스',   module: TwoPlayerPass },
    { id: 'four-player-pass',       label: '4인 패스',         category: '패스',   module: FourPlayerPass },
    { id: 'four-player-pass-defense', label: '4인 패스(수비)', category: '패스',   module: FourPlayerPassDefense },
    { id: 'four-player-pass-coop-defense', label: '4인 패스(협력수비)', category: '패스', module: FourPlayerPassCoopDefense },
    { id: 'through-pass',            label: '스루패스',          category: '패스',   module: ThroughPass },
    { id: 'through-pass-defense',    label: '스루패스(수비)',     category: '패스',   module: ThroughPassDefense },
    { id: 'lobbed-through-pass',     label: '로빙 스루패스',      category: '패스',   module: LobbedThroughPass },
    { id: 'shooting',                label: '슈팅',               category: '슈팅',   module: Shooting },
    { id: 'shooting-with-goalkeeper', label: '슈팅(골키퍼)',      category: '슈팅',   module: ShootingWithGoalkeeper },
    { id: 'heading-pass',            label: '헤딩 패스',         category: '헤딩',   module: HeadingPass },
    { id: 'heading-shot',            label: '헤딩 슛',           category: '헤딩',   module: HeadingShot },
    { id: 'cross-header',             label: '크로스-헤딩',       category: '헤딩',   module: CrossHeader },
    { id: 'one-vs-one',                label: '1:1',               category: '경기',   module: OneVsOne },
    { id: 'one-vs-one-duel',           label: '1:1 듀얼',            category: '경기',   module: OneVsOneDuel },
    { id: 'two-vs-one',                 label: '2:1',                 category: '경기',   module: TwoVsOne },
    { id: 'two-vs-two',                label: '2:2',               category: '경기',   module: TwoVsTwo },
    { id: 'three-vs-three',            label: '3:3',               category: '경기',   module: ThreeVsThree },
];

// 그룹 표시 순서. 신규 카테고리는 여기에 추가하면 원하는 위치에 표시된다.
const CATEGORY_ORDER = ['드리블', '패스', '슈팅', '헤딩', '경기'];

// ── DOM 레퍼런스 ─────────────────────────────────────────
const layer        = document.getElementById('entities-layer');
const drawerEl     = document.getElementById('play-menu');
const scrimEl      = document.getElementById('drawer-scrim');
const menuOpenBtn  = document.getElementById('menu-open-btn');
const menuCloseBtn = document.getElementById('menu-close-btn');
const menuSearch   = document.getElementById('menu-search');
const currentLabel = document.getElementById('menu-current-label');
const menuList     = document.getElementById('menu-list');
const pauseBtn     = document.getElementById('pause-btn');
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

    // 전환 시 일시정지 상태면 해제 (루프가 멈춘 채로 시작되는 것 방지)
    // ※ runScenario 첫 호출은 paused 선언 이후에 일어나므로 TDZ 문제 없음
    if (paused) togglePause();

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

    // 서랍 닫기
    closeMenu();
}

// ── 서랍 열기/닫기 ────────────────────────────────────────
function openMenu() {
    drawerEl.dataset.open = '';
    scrimEl.dataset.visible = '';
    menuOpenBtn.setAttribute('aria-expanded', 'true');
    menuSearch.value = '';
    applySearchFilter('');
    // 다음 열 때 바로 타이핑 가능하도록
    setTimeout(() => menuSearch.focus(), 60);
}

function closeMenu() {
    delete drawerEl.dataset.open;
    delete scrimEl.dataset.visible;
    menuOpenBtn.setAttribute('aria-expanded', 'false');
    menuSearch.blur();
}

menuOpenBtn.addEventListener('click', openMenu);
menuCloseBtn.addEventListener('click', closeMenu);
scrimEl.addEventListener('click', closeMenu);

// Escape 키로 닫기
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
    // Space: 일시정지 토글 (검색 입력 중이 아닐 때)
    if (e.key === ' ' && document.activeElement !== menuSearch
        && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '')) {
        e.preventDefault();
        togglePause();
    }
});

// ── 메뉴 빌드 (카테고리 그룹) ─────────────────────────────
const categoryGroups = new Map(); // category -> section element
const itemButtons = [];           // 검색 필터 대상 { id, label, category, btn, group }

function buildMenu() {
    const order = new Map(CATEGORY_ORDER.map((name, i) => [name, i]));
    const sorted = [...SCENARIOS].sort((a, b) =>
        (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99));

    for (const { id, label, category } of sorted) {
        let group = categoryGroups.get(category);
        if (!group) {
            const section = document.createElement('section');
            section.className = 'menu-group';
            section.dataset.category = category;

            const header = document.createElement('h2');
            header.className = 'menu-group__title';
            header.textContent = category;

            const list = document.createElement('div');
            list.className = 'menu-group__list';
            list.setAttribute('role', 'menu');

            section.appendChild(header);
            section.appendChild(list);
            menuList.appendChild(section);

            group = { section, list };
            categoryGroups.set(category, group);
        }

        const btn = document.createElement('button');
        btn.className = 'menu-btn';
        btn.dataset.id = id;
        btn.setAttribute('role', 'menuitem');
        btn.textContent = label;
        btn.addEventListener('click', () => runScenario(id));
        group.list.appendChild(btn);

        itemButtons.push({ id, label, category, btn, group: group.section });
    }
}
buildMenu();

// ── 검색 필터 ─────────────────────────────────────────────
function applySearchFilter(keyword) {
    const q = keyword.trim().toLowerCase();
    for (const item of itemButtons) {
        const hit = q === '' || item.label.toLowerCase().includes(q)
            || item.category.toLowerCase().includes(q);
        item.btn.style.display = hit ? '' : 'none';
    }
    // 빈 그룹 숨기기
    for (const { section, list } of categoryGroups.values()) {
        const visible = [...list.children].some(b => b.style.display !== 'none');
        section.style.display = visible ? '' : 'none';
    }
}
menuSearch.addEventListener('input', () => applySearchFilter(menuSearch.value));

// ── 일시정지 ──────────────────────────────────────────────
let paused = false;

function togglePause() {
    paused = !paused;
    if (paused) {
        loop.stop();
        pauseBtn.textContent = '▶';
        pauseBtn.setAttribute('aria-label', '재생');
        pauseBtn.classList.add('pause-btn--paused');
    } else {
        loop.start();
        pauseBtn.textContent = '⏸';
        pauseBtn.setAttribute('aria-label', '일시정지');
        pauseBtn.classList.remove('pause-btn--paused');
    }
}
pauseBtn.addEventListener('click', togglePause);

// 시나리오 전환 시 일시정지 해제 (runScenario 내부 선두에서 처리)

// 리셋 버튼
resetBtn.addEventListener('click', () => {
    if (activeId) runScenario(activeId);
});

// ── 첫 시나리오 자동 시작 ─────────────────────────────────
runScenario(SCENARIOS[0].id);
