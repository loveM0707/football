/**
 * PassReceiver - 패스 수신 반응 + Y축 인터셉트 공통 모듈
 *
 * 사용법:
 *   1. 패스가 차진 순간 arm() 호출
 *   2. 매 프레임 update(dt, player, getTargetY) 호출
 *   3. 수신 완료 시 reset() 호출
 *
 * 반응 지연(REACTION_DELAY) 후 getTargetY 콜백을 한 번 호출해 목표 Y를 확정하고,
 * 이후 수신자를 그 Y로 이동시킨다 (X축 고정, PlayerMovement 불필요).
 *
 * getTargetY 콜백 예시:
 *   숏패스: () => PassMovement.interceptPoint(bm, receiver, {...}).y
 *   롱패스: () => landY   (롱패스 착지 Y)
 */
import { PassMovement } from './PassMovement.js';

export class PassReceiver {

    constructor() {
        this._timer   = 0;
        this._active  = false;
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
     * @param {Player}   player       수신자 (Y축만 이동)
     * @param {function} getTargetY   () → number  반응 시 한 번 호출 → 목표 Y 반환
     */
    update(dt, player, getTargetY) {
        if (this._timer > 0) {
            this._timer -= dt;
            if (this._timer <= 0) {
                this._active  = true;
                this._targetY = getTargetY();
                this._speed   = PassMovement.interceptSpeed(Math.abs(this._targetY - player.y));
            }
        }
        if (this._active) {
            const dy    = this._targetY - player.y;
            const distY = Math.abs(dy);
            if (distY > 0.5) {
                const step = Math.min(this._speed * dt, distY);
                player.setPosition(player.x, player.y + Math.sign(dy) * step);
            }
        }
    }
}
