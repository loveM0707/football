/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 원칙: 볼은 절대 순간이동하지 않는다. 모든 이동은 lerp.
 *
 * 킥 사이클:
 *   WAIT   : 볼이 frontPos에 붙어 있음, 짧은 대기 후 킥
 *   KICKING: 볼이 고정 목표로 빠르게 이동, 선수가 따라잡으면 종료
 *   TURN   : 방향전환 중, 볼을 선수 앞에 밀착 유지
 *
 * 느린 드리블: kickAhead가 짧아 볼이 조금 앞에 놓이고 자주 터치
 * 빠른 드리블: kickAhead가 길어 볼을 크게 치고 선수가 달려서 따라잡음
 *
 * kickAhead 스케일 (2차):
 *   speed=50  → ×0.25 ≈ 12  (발에 거의 붙음)
 *   speed=100 → ×1.00 = 50  (기준, 3단계)
 *   speed=150 → ×2.25 ≈ 112 (크게 치고 달리기)
 *
 * 루프 호출 순서: PlayerMovement → DribbleController → BallMovement
 */
export class DribbleController {
    static KICK_INTERVAL  = 0.08;  // 따라잡은 후 다음 킥까지 대기 (초)
    static KICK_AHEAD     = 50;    // 기준 킥 전진 거리 (speed=100 기준, SVG 단위)
    static KICK_SPEED_REF = 100;   // kickAhead 기준 속도 (3단계)
    static CATCH_RADIUS   = 10;    // 볼을 '따라잡은' 것으로 판정하는 거리 (SVG 단위)

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

    /** 현재 선수 속도에 맞는 킥 전진 거리 (2차 스케일) */
    _calcKickAhead() {
        const ratio = this.pm.speed / DribbleController.KICK_SPEED_REF;
        return DribbleController.KICK_AHEAD * ratio * ratio;
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
            // 킥 중: 볼이 고정 목표로 빠르게 이동
            //   선수의 frontPos가 볼 위치에 가까워지면 따라잡은 것으로 판정
            targetX  = this._kickTargetX;
            targetY  = this._kickTargetY;
            lerpRate = DribbleController.LERP_KICK;

            const dist = Math.hypot(this.bm.ball.x - fx, this.bm.ball.y - fy);
            if (dist < DribbleController.CATCH_RADIUS) {
                this._kicking   = false;
                this._waitTimer = 0;
            }

        } else {
            // 대기: 볼이 frontPos에 밀착, 짧은 간격 후 다음 킥
            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_WAIT;
            this._waitTimer += dt;

            if (this._waitTimer >= DribbleController.KICK_INTERVAL) {
                // 킥 목표를 현재 frontPos + kickAhead로 고정
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
