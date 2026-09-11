/**
 * GameLoop - requestAnimationFrame 기반 게임 루프
 * 핸들러를 등록하면 매 프레임 dt(초)를 인자로 호출한다.
 *
 * 타임스케일: 전 메뉴 공통 경기 페이스 (기본 MATCH_PACE).
 * dt 자체를 스케일하므로 선수 이동·볼 물리·쿨다운·타이머가 전부 같은
 * 비율로 느려져 밸런스(추격·태클 타이밍 비율)가 깨지지 않는다.
 * 선수 속도만 낮추면 압박자가 못 따라잡아 난이도가 바뀌므로,
 * "느리게 보기"는 타임스케일이 정석이다.
 * 개별 시나리오가 속도를 강제하지 않는다 — 페이스는 이 모듈이 소유한다.
 */
export class GameLoop {
    static MAX_DT = 0.05; // 최대 dt (탭 비활성 등 대형 점프 방지)
    static MATCH_PACE = 0.8; // 전 메뉴 공통 재생 속도 (20% 슬로모션)

    constructor() {
        this._handlers = [];
        this._running = false;
        this._lastTime = 0;
        this._rafId = null;
        this._timeScale = GameLoop.MATCH_PACE;
    }

    /** 재생 속도 설정 (기본 MATCH_PACE, 1 = 정상). 0보다 커야 한다. */
    setTimeScale(v) {
        if (typeof v === 'number' && v > 0) this._timeScale = v;
    }

    get timeScale() { return this._timeScale; }

    /** 매 프레임 호출할 핸들러 추가. fn(dt: number) */
    add(fn) {
        this._handlers.push(fn);
        return this;
    }

    remove(fn) {
        this._handlers = this._handlers.filter(h => h !== fn);
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._lastTime = performance.now();
        this._rafId = requestAnimationFrame(this._tick.bind(this));
    }

    stop() {
        this._running = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    _tick(timestamp) {
        const rawDt = Math.min((timestamp - this._lastTime) / 1000, GameLoop.MAX_DT);
        const dt = rawDt * this._timeScale;
        this._lastTime = timestamp;
        for (const fn of this._handlers) fn(dt);
        if (this._running) {
            this._rafId = requestAnimationFrame(this._tick.bind(this));
        }
    }
}
