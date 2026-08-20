/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 원칙: 볼은 절대 순간이동하지 않는다. 모든 이동은 lerp.
 *
 * 킥 사이클:
 *   WAIT   : 볼이 frontPos에 붙어 있음. _kickInterval() 경과 후 킥 발동.
 *   KICKING: 볼이 고정 목표(킥 시점의 frontPos + kickAhead)로 빠르게 이동.
 *            선수 frontPos가 킥 목표 지점에 도달하면 종료(따라잡음 판정).
 *   TURN   : 방향전환 중. 볼을 선수 앞에 밀착 유지.
 *
 * catch 조건: dist(frontPos, kickTarget) < CATCH_RADIUS
 *   → 킥 시작 시점엔 frontPos↔kickTarget = kickAhead(≥12)이므로 즉시 트리거 없음.
 *   → 선수가 달려서 kickTarget에 가까워졌을 때 비로소 catch.
 *
 * KICK_INTERVAL = 20 / speed  (speed에 반비례)
 *   speed 50  → 0.40s (느린 드리블: 발에 붙여 자주 터치)
 *   speed 100 → 0.20s
 *   speed 150 → 0.13s (빠른 드리블: 크게 차고 바로 달리기)
 *
 * kickAhead 스케일 (2차):
 *   speed 50  → ×0.25 ≈ 12  SVG  (거의 발에 붙음)
 *   speed 100 → ×1.00 = 50  SVG  (기준, 3단계)
 *   speed 150 → ×2.25 ≈ 112 SVG (크게 치고 달리기)
 *
 * 루프 호출 순서: PlayerMovement → DribbleController → BallMovement
 */
export class DribbleController {
    static KICK_AHEAD      = 50;   // 기준 킥 전진 거리 (speed=100 기준, SVG 단위)
    static KICK_SPEED_REF  = 100;  // kickAhead 기준 속도 (3단계)
    static CATCH_RADIUS    = 5;    // frontPos ↔ kickTarget 도달 판정 거리 (SVG)

    static LERP_WAIT = 20; // 대기: 볼이 frontPos에 밀착
    static LERP_KICK = 18; // 킥: 볼이 목표로 빠르게 이동
    static LERP_TURN = 14; // 방향전환: 볼을 앞으로 당김

    constructor(playerMovement, ballMovement) {
        this.pm = playerMovement;
        this.bm = ballMovement;
        this._active      = false;
        this._kicking     = false;
        this._waitTimer   = 0;
        this._kickTargetX = 0;
        this._kickTargetY = 0;
    }

    start() {
        this._active    = true;
        this._kicking   = false;
        this._waitTimer = 0;
    }

    stop() {
        this._active  = false;
        this._kicking = false;
        if (this.bm.owner) this.bm.snapToFront();
    }

    /** 현재 속도에 맞는 킥 전진 거리 (2차 스케일) */
    _calcKickAhead() {
        const r = this.pm.speed / DribbleController.KICK_SPEED_REF;
        return DribbleController.KICK_AHEAD * r * r;
    }

    /**
     * 킥 사이 대기 시간 (속도에 반비례)
     *   speed 50  → 0.40s  /  speed 100 → 0.20s  /  speed 150 → 0.13s
     */
    _kickInterval() {
        return 20 / this.pm.speed;
    }

    update(dt) {
        if (!this._active || !this.bm.owner) return;

        const turning = this.pm.isTurning();
        const { x: fx, y: fy, fwdX, fwdY } = this.bm.frontPos();

        let targetX, targetY, lerpRate;

        if (turning) {
            // 방향전환: 볼을 선수 앞에 밀착
            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_TURN;
            this._kicking   = false;
            this._waitTimer = 0;

        } else if (this._kicking) {
            // 볼이 고정 킥 목표로 이동 중.
            // 선수 frontPos가 킥 목표에 충분히 가까워지면 따라잡은 것으로 판정.
            targetX  = this._kickTargetX;
            targetY  = this._kickTargetY;
            lerpRate = DribbleController.LERP_KICK;

            const dfk = Math.hypot(fx - this._kickTargetX, fy - this._kickTargetY);
            if (dfk < DribbleController.CATCH_RADIUS) {
                this._kicking   = false;
                this._waitTimer = 0;
            }

        } else {
            // 대기: 볼이 frontPos에 붙어 있음, 인터벌 후 다음 킥
            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_WAIT;
            this._waitTimer += dt;

            if (this._waitTimer >= this._kickInterval()) {
                const kickAhead       = this._calcKickAhead();
                this._kickTargetX     = fx + fwdX * kickAhead;
                this._kickTargetY     = fy + fwdY * kickAhead;
                this._kicking         = true;
                this._waitTimer       = 0;
            }
        }

        const t  = Math.min(1, lerpRate * dt);
        const bx = this.bm.ball.x;
        const by = this.bm.ball.y;
        this.bm.ball.setPosition(bx + (targetX - bx) * t, by + (targetY - by) * t);
    }
}
