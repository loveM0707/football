/**
 * PassReceiver - 패스 수신 반응 + 인터셉트 공통 모듈
 *
 * 사용법:
 *   1. 패스가 차진 순간 arm() 호출
 *   2. 매 프레임 update(dt, player, getTarget) 호출
 *   3. 수신 완료 시 reset() 호출
 *
 * 반응 지연(REACTION_DELAY) 후 getTarget 콜백을 한 번 호출해 목표 {x,y}를 확정하고,
 * 이후 수신자를 그 위치까지 이동시킨다.
 * 수신자는 볼 방향으로 조금씩 마중 나오며, 자연스럽게 볼을 받는다.
 *
 * getTarget 콜백 예시:
 *   숏패스: () => PassMovement.interceptPoint(bm, receiver)
 *   롱패스: () => ({ x: landX, y: landY })
 */
import { PassMovement } from './PassMovement.js';

export class PassReceiver {

    constructor() {
        this._timer   = 0;
        this._active  = false;
        this._targetX = 0;
        this._targetY = 0;
        this._speed   = 0;
    }

    /**
     * 패스가 차진 직후 호출 — 반응 대기를 시작한다.
     * @param {number} [delay]  반응 지연(초). 기본값: PassMovement.REACTION_DELAY
     */
    arm(delay = PassMovement.REACTION_DELAY) {
        this._timer  = delay;
        this._active = false;
    }

    /** 수신 완료 시 호출 */
    reset() {
        this._timer  = 0;
        this._active = false;
    }

    /**
     * 매 프레임 호출.
     * @param {number}   dt
     * @param {Player}   player      수신자
     * @param {function} getTarget   () → {x, y}  반응 시 한 번 호출 → 인터셉트 목표 반환
     */
    update(dt, player, getTarget) {
        if (this._timer > 0) {
            this._timer -= dt;
            if (this._timer <= 0) {
                const target  = getTarget();
                const dx      = target.x - player.x;
                const dy      = target.y - player.y;
                this._targetX = target.x;
                this._targetY = target.y;
                this._speed   = PassMovement.interceptSpeed(Math.hypot(dx, dy));
                this._active  = true;
            }
        }
        if (this._active) {
            const dx   = this._targetX - player.x;
            const dy   = this._targetY - player.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 0.5) {
                const step = Math.min(this._speed * dt, dist);
                player.setPosition(
                    player.x + (dx / dist) * step,
                    player.y + (dy / dist) * step,
                );
            }
        }
    }
}
