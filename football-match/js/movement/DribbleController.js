/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 원칙: 볼은 절대 순간이동하지 않는다. 모든 이동은 lerp.
 *
 * 킥 사이클:
 *   WAIT : 볼이 frontPos에 붙어 있음. _kickInterval() 경과 후 킥 발동.
 *   KICK : 볼이 고정 목표(킥 시점의 frontPos + kickAhead)로 빠르게 이동.
 *          선수 frontPos가 킥 목표 지점에 도달하면 종료(따라잡음 판정).
 *   TURN : 방향전환 중. 볼을 선수 앞에 밀착 유지.
 *
 * catch 조건: dist(frontPos, kickTarget) < CATCH_RADIUS
 *
 * 속도 변화(setSpeed): WAIT 진입 시 적용. 킥 중 속도 변화 방지.
 *
 * KICK_INTERVAL = 20 / speed  (speed에 반비례)
 *   speed 50  → 0.40s / speed 100 → 0.20s / speed 150 → 0.13s
 *
 * kickAhead 스케일 (2차, speed=100 기준 30 SVG):
 *   speed 50  → ×0.25 ≈  7.5 SVG (거의 발에 붙음)
 *   speed 100 → ×1.00 = 30 SVG   (기준, 3단계)
 *   speed 150 → ×2.25 ≈ 67.5 SVG (크게 치고 달리기)
 *
 * 루프 호출 순서: PlayerMovement → DribbleController → BallMovement
 */
export class DribbleController {
    static KICK_AHEAD     = 30;   // 기준 킥 전진 거리 (speed=100 기준, SVG 단위)
    static KICK_SPEED_REF = 100;  // kickAhead 기준 속도 (3단계)
    static CATCH_RADIUS   = 5;    // frontPos ↔ kickTarget 도달 판정 거리 (SVG)

    static LERP_WAIT = 12; // 대기: 볼이 frontPos로 부드럽게 굴러옴
    static LERP_KICK = 7;  // 킥: 볼이 목표를 향해 자연스럽게 굴러감
    static LERP_TURN = 14; // 방향전환: 볼을 앞으로 당김

    constructor(playerMovement, ballMovement) {
        this.pm = playerMovement;
        this.bm = ballMovement;
        this._active       = false;
        this._kicking      = false;
        this._waitTimer    = 0;
        this._kickTargetX  = 0;
        this._kickTargetY  = 0;
        this._state        = 'WAIT'; // 'WAIT' | 'KICK' | 'TURN'
        this._pendingSpeed = null;
    }

    start() {
        this._active       = true;
        this._kicking      = false;
        this._waitTimer    = 0;
        this._state        = 'WAIT';
        this._pendingSpeed = null;
    }

    stop() {
        this._active       = false;
        this._kicking      = false;
        this._state        = 'WAIT';
        this._pendingSpeed = null;
        if (this.bm.owner) this.bm.snapToFront();
    }

    /**
     * 속도 변경 요청. WAIT 상태이면 즉시 반영, 아니면 다음 WAIT 진입 시 반영.
     * 킥 중 선수가 갑자기 느려지는 현상을 방지한다.
     */
    setSpeed(speed) {
        if (!this._active || this._state === 'WAIT') {
            this.pm.speed = speed;
        } else {
            this._pendingSpeed = speed;
        }
    }

    /** 현재 속도에 맞는 킥 전진 거리 (2차 스케일) */
    _calcKickAhead() {
        const r = this.pm.speed / DribbleController.KICK_SPEED_REF;
        return DribbleController.KICK_AHEAD * r * r;
    }

    /** 킥 사이 대기 시간 (속도에 반비례) */
    _kickInterval() {
        return 20 / this.pm.speed;
    }

    /** 보류된 속도를 적용하고 상태를 WAIT으로 전환 */
    _enterWait() {
        if (this._pendingSpeed !== null) {
            this.pm.speed      = this._pendingSpeed;
            this._pendingSpeed = null;
        }
        this._state = 'WAIT';
    }

    update(dt) {
        if (!this._active || !this.bm.owner) return;

        const turning = this.pm.isTurning();
        const { x: fx, y: fy, fwdX, fwdY } = this.bm.frontPos();

        let targetX, targetY, lerpRate;

        if (turning) {
            // TURN: 볼을 선수 앞에 밀착
            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_TURN;
            this._kicking   = false;
            this._waitTimer = 0;
            this._state     = 'TURN';

        } else if (this._kicking) {
            // KICK: 볼이 고정 킥 목표로 이동 중
            targetX  = this._kickTargetX;
            targetY  = this._kickTargetY;
            lerpRate = DribbleController.LERP_KICK;
            this._state = 'KICK';

            const dfk = Math.hypot(fx - this._kickTargetX, fy - this._kickTargetY);
            if (dfk < DribbleController.CATCH_RADIUS) {
                this._kicking   = false;
                this._waitTimer = 0;
                this._enterWait();
            }

        } else {
            // WAIT: 볼이 frontPos에 붙어 있음, 인터벌 후 다음 킥
            if (this._state !== 'WAIT') this._enterWait();

            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_WAIT;
            this._waitTimer += dt;

            if (this._waitTimer >= this._kickInterval()) {
                const kickAhead   = this._calcKickAhead();
                this._kickTargetX = fx + fwdX * kickAhead;
                this._kickTargetY = fy + fwdY * kickAhead;
                this._kicking     = true;
                this._waitTimer   = 0;
                this._state       = 'KICK';
            }
        }

        const t  = Math.min(1, lerpRate * dt);
        const bx = this.bm.ball.x;
        const by = this.bm.ball.y;
        this.bm.ball.setPosition(bx + (targetX - bx) * t, by + (targetY - by) * t);
    }
}
