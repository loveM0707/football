/**
 * SpeedController - 가속/감속 커브 모듈
 *
 * 이산 속도 단계 간 즉시 전환 대신 물리적 가감속을 적용한다.
 * 축구 선수의 실제 가속/감속 특성을 반영:
 *   - 가속: 저속에서 빠르고 고속에서 느려진다
 *   - 감속: 가속보다 빠르다 (브레이크)
 *   - 급정지(목표 속도 ≈ 0): 감속보다 더 빠르다
 *
 * 사용:
 *   PlayerMovement가 내부적으로 사용한다. pm.speed = X 로 목표 속도를 설정하면
 *   update() 에서 가감속 커브를 적용해 실제 이동 속도를 산출한다.
 *
 * 단위: SVG/s (10 SVG = 1m)
 */

const ACCEL_RATE = 40;   // 가속률 (SVG/s²) — 약 4.0 m/s²
const DECEL_RATE = 65;   // 감속률 (SVG/s²) — 약 6.5 m/s², 가속보다 빠르다
const BRAKE_RATE = 100;  // 급정지률 (SVG/s²) — 약 10 m/s²
const SNAP_THRESHOLD = 0.5; // 이 차이 이하면 즉시 도달 처리

export { ACCEL_RATE, DECEL_RATE, BRAKE_RATE };

export class SpeedController {
    /**
     * @param {object} [options]
     *   initialSpeed {number}  초기 속도 (기본 100)
     *   accelRate    {number}  가속률 오버라이드
     *   decelRate    {number}  감속률 오버라이드
     *   brakeRate    {number}  급정지률 오버라이드
     */
    constructor(options = {}) {
        this._current = options.initialSpeed ?? 100;
        this._target  = this._current;
        this._accel   = options.accelRate ?? ACCEL_RATE;
        this._decel   = options.decelRate ?? DECEL_RATE;
        this._brake   = options.brakeRate ?? BRAKE_RATE;
    }

    get current() { return this._current; }
    get target()  { return this._target; }

    /** 목표 속도 설정 — 가감속 커브를 따라 도달한다 */
    setTarget(speed) { this._target = speed; }

    /** 즉시 속도 설정 — 가감속 없이 현재 속도를 변경한다 (하위 호환) */
    setInstant(speed) {
        this._current = speed;
        this._target  = speed;
    }

    /**
     * 매 프레임 호출. 현재 속도를 목표를 향해 가감속한다.
     * @param {number} dt  프레임 시간 (초)
     * @returns {number} 갱신된 현재 속도
     */
    update(dt) {
        const diff = this._target - this._current;
        if (Math.abs(diff) < SNAP_THRESHOLD) {
            this._current = this._target;
            return this._current;
        }

        let rate;
        if (diff > 0) {
            // 가속 — 고속 영역에서 가속이 느려진다 (공기저항·근력 한계)
            const factor = 1 - (this._current / 200) * 0.3;
            rate = this._accel * Math.max(0.5, factor);
        } else {
            // 감속 — 목표가 매우 낮으면 급정지 모드
            rate = this._target < 15 ? this._brake : this._decel;
        }

        const change = Math.sign(diff) * rate * dt;
        // 오버슈트 방지
        if (Math.abs(change) >= Math.abs(diff)) {
            this._current = this._target;
        } else {
            this._current += change;
        }

        return this._current;
    }

    /** 현재 가속 중인지 반환 */
    get accelerating() { return this._current < this._target - SNAP_THRESHOLD; }

    /** 현재 감속 중인지 반환 */
    get decelerating() { return this._current > this._target + SNAP_THRESHOLD; }

    /** 속도 전환 중인지 (가속 또는 감속) */
    get transitioning() { return this.accelerating || this.decelerating; }
}
