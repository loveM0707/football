/**
 * BallMovement - 공 물리·소유 모듈
 *
 * 세 상태:
 *   - 자유(free): 속도·마찰로 굴러감
 *   - 소유(possessed): DribbleController가 위치를 제어
 *   - 공중(aerial): 포물선 비행, 마찰 없음, setHeight()로 시각 표현
 *
 * 나중에 패스, 슈팅, 몸에 맞은 공 등 추가 상태를 이 모듈 또는
 * 별도 모듈(PassMovement, ShotMovement 등)에서 확장한다.
 */
import { forwardVector } from './Direction.js';

export class BallMovement {
    static FRICTION = 380; // 감속 (SVG 단위/초²)

    /** 선수 앞에서 공이 붙는 거리 (선수 반지름 + 공 반지름 + 여유) */
    static possessionOffset(playerRadius, ballRadius) {
        return playerRadius + ballRadius + 3;
    }

    constructor(ball) {
        this.ball = ball;
        this.vx = 0;
        this.vy = 0;
        this._owner = null;   // Player | null
        this._offset = 0;     // 소유 시 선수 앞 거리
        this._aerial = false;
        this._aerialVx = 0;
        this._aerialVy = 0;
        this._aerialDuration = 0;
        this._aerialTimer = 0;
        this._aerialMaxH = 1;
        this._aerialOnLand = null;
    }

    get owner() { return this._owner; }
    get offset() { return this._offset; }

    /** 선수가 공을 소유한다. 위치 전환은 DribbleController의 lerp에 맡긴다. */
    possess(player, offset) {
        this._owner = player;
        this._offset = offset;
        this.vx = 0;
        this.vy = 0;
        // 여기서 snapToFront() 호출 금지 — 순간이동 방지
    }

    /**
     * 소유를 해제하고 공에 속도를 준다 (패스, 슈팅 등).
     * @param {number} vx  SVG 단위/초
     * @param {number} vy
     */
    release(vx, vy) {
        this._owner = null;
        this._aerial = false;
        this.vx = vx;
        this.vy = vy;
    }

    /**
     * 공중 패스: 포물선 비행. 마찰 없이 일정 속도로 이동하며 높이만 포물선.
     * @param {number}   vx          수평 속도 (SVG/s)
     * @param {number}   vy          수직 속도 (SVG/s)
     * @param {number}   duration    비행 시간 (초)
     * @param {number}   [maxH=1]    최고 높이 (Ball.setHeight 0~1 스케일)
     * @param {function} [onLand]    착지 시 콜백
     */
    releaseAerial(vx, vy, duration, maxH = 1, onLand = null) {
        this._owner = null;
        this._aerial = true;
        this._aerialVx = vx;
        this._aerialVy = vy;
        this._aerialDuration = duration;
        this._aerialTimer = 0;
        this._aerialMaxH = maxH;
        this._aerialOnLand = onLand;
        this.vx = 0;
        this.vy = 0;
    }

    /** 현재 공중 비행 중이면 true */
    get isAerial() { return this._aerial; }

    /** 공을 소유자 앞 위치로 즉시 이동 */
    snapToFront() {
        if (!this._owner) return;
        const { x, y } = this.frontPos();
        this.ball.setPosition(x, y);
    }

    /**
     * 소유자 앞 위치 좌표를 반환.
     * @param {number} [extra=0] 기본 offset에 추가할 거리
     */
    frontPos(extra = 0) {
        const fwd = forwardVector(this._owner.angle);
        return {
            x: this._owner.x + fwd.x * (this._offset + extra),
            y: this._owner.y + fwd.y * (this._offset + extra),
            fwdX: fwd.x,
            fwdY: fwd.y,
        };
    }

    /** 매 프레임 호출 — 자유 상태일 때만 물리 처리 */
    update(dt) {
        if (this._owner) return; // 소유 중: DribbleController가 위치 관리

        // 공중 비행 처리
        if (this._aerial) {
            const remaining = this._aerialDuration - this._aerialTimer;
            const useDt = Math.min(dt, remaining);
            this._aerialTimer += useDt;
            const progress = this._aerialTimer / this._aerialDuration;
            const h = this._aerialMaxH * 4 * progress * (1 - progress);
            this.ball.setHeight(h);
            this.ball.setPosition(
                this.ball.x + this._aerialVx * useDt,
                this.ball.y + this._aerialVy * useDt,
            );
            if (this._aerialTimer >= this._aerialDuration) {
                this._aerial = false;
                this.ball.setHeight(0);
                const onLand = this._aerialOnLand;
                this._aerialOnLand = null;
                if (onLand) onLand();
            }
            return;
        }

        const speed = Math.hypot(this.vx, this.vy);
        if (speed < 1) {
            this.vx = 0;
            this.vy = 0;
            return;
        }

        const decel = BallMovement.FRICTION * dt;
        const newSpeed = Math.max(0, speed - decel);
        const ratio = newSpeed / speed;
        this.vx *= ratio;
        this.vy *= ratio;

        this.ball.setPosition(
            this.ball.x + this.vx * dt,
            this.ball.y + this.vy * dt
        );
    }
}
