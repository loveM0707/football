/**
 * PassReceiver - 패스 수신 반응 + 측면 인터셉트 공통 모듈
 *
 * 사용법:
 *   1. 패스가 차진 순간 arm() 호출
 *   2. 매 프레임 update(dt, player, getTarget) 호출
 *   3. 수신 완료 시 reset() 호출
 *
 * 반응 지연(REACTION_DELAY) 후 getTarget 콜백을 한 번 호출해 목표 {x,y}를 확정하고,
 * 수신자를 자신의 facing에 수직(측면) 방향으로 이동시킨다.
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
     * @param {Player}   player      수신자 (측면 방향으로만 이동)
     * @param {function} getTarget   () → {x, y}  반응 시 한 번 호출 → 인터셉트 목표 반환
     */
    update(dt, player, getTarget) {
        if (this._timer > 0) {
            this._timer -= dt;
            if (this._timer <= 0) {
                const target = getTarget();
                const rad    = player.angle * Math.PI / 180;
                const fwdX   = -Math.sin(rad);
                const fwdY   =  Math.cos(rad);
                // 측면(수직) 방향
                const perpX  = -fwdY;
                const perpY  =  fwdX;
                // 목표까지 벡터의 측면 성분
                const dx      = target.x - player.x;
                const dy      = target.y - player.y;
                const lateral = dx * perpX + dy * perpY;
                // 절대 목표 위치 (측면 이동만)
                this._targetX = player.x + lateral * perpX;
                this._targetY = player.y + lateral * perpY;
                this._speed   = PassMovement.interceptSpeed(Math.abs(lateral));
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
