/**
 * DefenderAI - 수비수 추적 AI
 *
 * 목표(공/공격수)를 추적하며 거리 비례로 속도를 조절한다.
 * 볼 속도가 충분할 때 예측 위치를 블렌딩해 길목을 차단하는 동작을 만든다.
 * PlayerMovement를 직접 제어한다.
 *
 * @example
 *   const defAI = new DefenderAI(dpm, defender);
 *   defAI.start();
 *   // 매 프레임: defAI.update(dt, ball.x, ball.y, bm.vx, bm.vy)
 */
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

// 기본 거리→속도 매핑: [최소 거리, 속도]
const DEFAULT_SPEED_TABLE = [
    [280, SPEEDS[0]],  // dist > 280 → 50
    [180, SPEEDS[1]],  // dist > 180 → 75
    [80,  SPEEDS[1]],  // dist > 80  → 75
    [0,   SPEEDS[2]],  // else       → 100
];

// 예측 블렌드 파라미터
const PREDICT_LOOK_AHEAD  = 0.55; // 초 (볼이 어디로 갈지 예측하는 시간)
const PREDICT_BLEND_SPEED = 25;   // 볼 속도 이 이상일 때 예측 적용

export class DefenderAI {

    /**
     * @param {PlayerMovement} pm        수비수의 PlayerMovement
     * @param {Player}         defender  수비수 엔티티 (위치 참조용)
     * @param {object}         options
     *   retargetInterval {number}  재타게팅 기준 주기(초, 기본 0.4)
     *   speedTable       {Array}   [[distThreshold, speed], ...] 내림차순 정렬
     */
    constructor(pm, defender, options = {}) {
        this._pm       = pm;
        this._defender = defender;
        this._baseInterval     = options.retargetInterval ?? 0.4;
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
     * @param {number} targetX  볼 현재 X
     * @param {number} targetY  볼 현재 Y
     * @param {number} [ballVx] 볼 속도 X (선택)
     * @param {number} [ballVy] 볼 속도 Y (선택)
     */
    update(dt, targetX, targetY, ballVx = 0, ballVy = 0) {
        if (!this._active) return;
        this._pm.update(dt);

        this._timer -= dt;
        if (this._timer > 0) return;

        // 재타게팅 주기에 ±20% 지터 추가 — 일정한 리듬 제거
        this._timer = this._baseInterval * (0.8 + Math.random() * 0.4);

        const dist = Math.hypot(this._defender.x - targetX, this._defender.y - targetY);
        this._pm.speed = this._selectSpeed(dist);

        // 볼 속도가 충분하면 예측 위치를 블렌딩해 길목 차단
        const ballSpeed = Math.hypot(ballVx, ballVy);
        let moveX = targetX;
        let moveY = targetY;
        if (ballSpeed > PREDICT_BLEND_SPEED) {
            const ahead = Math.min(PREDICT_LOOK_AHEAD, dist / Math.max(this._pm.speed, 1));
            const predX = targetX + ballVx * ahead;
            const predY = targetY + ballVy * ahead;
            // 가까울수록 현재 위치 비중 ↑, 멀수록 예측 위치 비중 ↑
            const blend = Math.min(1, dist / 200);
            moveX = targetX + (predX - targetX) * blend;
            moveY = targetY + (predY - targetY) * blend;
        }

        this._pm.moveTo(moveX, moveY, () => {});
    }

    _selectSpeed(dist) {
        for (const [threshold, speed] of this._speedTable) {
            if (dist > threshold) return speed;
        }
        return SPEEDS[4];
    }
}
