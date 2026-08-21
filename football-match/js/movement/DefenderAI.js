/**
 * DefenderAI - 수비수 추적 AI
 *
 * 목표(공/공격수)를 추적하며 거리 비례로 속도를 조절한다.
 * PlayerMovement를 직접 제어한다.
 *
 * @example
 *   const defAI = new DefenderAI(dpm, defender);
 *   defAI.start();
 *   // 매 프레임: defAI.update(dt, ball.x, ball.y)
 */
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

// 기본 거리→속도 매핑: [최소 거리, 속도] — 4인 패스(수비) 3회 이상 보장 위해 상한 하향
const DEFAULT_SPEED_TABLE = [
    [280, SPEEDS[0]],  // dist > 280 → 50 (매우 느림)
    [180, SPEEDS[1]],  // dist > 180 → 75 (조깅)
    [80,  SPEEDS[1]],  // dist > 80  → 75
    [0,   SPEEDS[2]],  // else       → 100 (최대 100, 기존 150 대비 -33%)
];

export class DefenderAI {

    /**
     * @param {PlayerMovement} pm        수비수의 PlayerMovement
     * @param {Player}         defender  수비수 엔티티 (위치 참조용)
     * @param {object}         options
     *   retargetInterval {number}  재타게팅 주기(초, 기본 0.25)
     *   speedTable       {Array}   [[distThreshold, speed], ...] 내림차순 정렬
     */
    constructor(pm, defender, options = {}) {
        this._pm       = pm;
        this._defender = defender;
        this._retargetInterval = options.retargetInterval ?? 0.4;
        this._speedTable       = options.speedTable       ?? DEFAULT_SPEED_TABLE;
        this._timer  = 0;
        this._active = false;
    }

    start() { this._active = true; }

    stop() {
        this._active = false;
        this._pm.stop();
    }

    /**
     * 매 프레임 호출.
     * @param {number} dt
     * @param {number} targetX  추적 목표 X (보통 ball.x)
     * @param {number} targetY  추적 목표 Y (보통 ball.y)
     */
    update(dt, targetX, targetY) {
        if (!this._active) return;
        this._pm.update(dt);

        this._timer -= dt;
        if (this._timer > 0) return;
        this._timer = this._retargetInterval;

        const dist = Math.hypot(this._defender.x - targetX, this._defender.y - targetY);
        this._pm.speed = this._selectSpeed(dist);
        this._pm.moveTo(targetX, targetY, () => {});
    }

    _selectSpeed(dist) {
        for (const [threshold, speed] of this._speedTable) {
            if (dist > threshold) return speed;
        }
        return SPEEDS[4];
    }
}
