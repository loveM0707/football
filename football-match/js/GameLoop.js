/**
 * GameLoop - requestAnimationFrame 기반 게임 루프
 * 핸들러를 등록하면 매 프레임 dt(초)를 인자로 호출한다.
 */
export class GameLoop {
    static MAX_DT = 0.05; // 최대 dt (탭 비활성 등 대형 점프 방지)

    constructor() {
        this._handlers = [];
        this._running = false;
        this._lastTime = 0;
        this._rafId = null;
    }

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
        const dt = Math.min((timestamp - this._lastTime) / 1000, GameLoop.MAX_DT);
        this._lastTime = timestamp;
        for (const fn of this._handlers) fn(dt);
        if (this._running) {
            this._rafId = requestAnimationFrame(this._tick.bind(this));
        }
    }
}
