/**
 * requestAnimationFrame 기반 루프. 실제 경과시간(dt)을 측정해 update(dtSimSeconds)와
 * render()를 호출한다. timeScale로 "경기 시간 압축 배속"을 조절하고, 탭 비활성 등으로
 * 큰 dt가 발생해도(스파이럴 오브 데스 방지) 최대치를 clamp한다.
 */
export class GameLoop {
  constructor({ update, render }) {
    this.update = update;
    this.render = render;
    this.running = false;
    this.timeScale = 6; // 1 실제초 = 6 경기초 (90분 경기를 약 15분에 시청 가능)
    this._lastTime = null;
    this._rafId = null;
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastTime = performance.now();
    this._rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  setTimeScale(scale) {
    this.timeScale = scale;
  }

  _tick(now) {
    if (!this.running) return;
    const realDt = Math.min(0.05, (now - this._lastTime) / 1000);
    this._lastTime = now;

    const simDt = realDt * this.timeScale;
    this.update(simDt);
    this.render();

    this._rafId = requestAnimationFrame(this._tick);
  }
}
