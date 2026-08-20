/**
 * BallMovement - 공 물리·소유 모듈
 *
 * 두 상태:
 *   - 자유(free): 속도·마찰로 굴러감
 *   - 소유(possessed): DribbleController가 위치를 제어
 *                       (이 모듈은 update에서 free 상태만 처리)
 *
 * 나중에 패스, 슈팅, 몸에 맞은 공 등 추가 상태를 이 모듈 또는
 * 별도 모듈(PassMovement, ShotMovement 등)에서 확장한다.
 */
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
    }

    get owner() { return this._owner; }
    get offset() { return this._offset; }

    /** 선수가 공을 소유한다. */
    possess(player, offset) {
        this._owner = player;
        this._offset = offset;
        this.vx = 0;
        this.vy = 0;
        this.snapToFront();
    }

    /**
     * 소유를 해제하고 공에 속도를 준다 (패스, 슈팅 등).
     * @param {number} vx  SVG 단위/초
     * @param {number} vy
     */
    release(vx, vy) {
        this._owner = null;
        this.vx = vx;
        this.vy = vy;
    }

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
        const rad = this._owner.angle * Math.PI / 180;
        const fwdX = Math.sin(rad);
        const fwdY = Math.cos(rad);
        return {
            x: this._owner.x + fwdX * (this._offset + extra),
            y: this._owner.y + fwdY * (this._offset + extra),
            fwdX,
            fwdY,
        };
    }

    /** 매 프레임 호출 — 자유 상태일 때만 물리 처리 */
    update(dt) {
        if (this._owner) return; // 소유 중: DribbleController가 위치 관리

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
