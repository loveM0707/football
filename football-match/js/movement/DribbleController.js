/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 킥 사이클:
 *   WAIT : 볼이 frontPos에 직접 붙어 있음(snap). _kickInterval() 경과 후 킥 발동.
 *   KICK : 볼이 고정 목표(킥 시점의 frontPos + kickAhead)로 lerp 이동.
 *          선수 frontPos가 킥 목표 지점에 도달하면 종료(따라잡음 판정).
 *   TURN : 방향전환 중. 볼을 선수 앞에 lerp로 밀착 유지.
 *
 * WAIT에서 snap을 쓰는 이유:
 *   lerp lag = speed / LERP_RATE. speed=150, LERP=12 이면 lag=12.5px — 발에서 눈에 띄게 뒤처짐.
 *   WAIT는 의미상 "볼이 발에 붙어 있음"이므로 snap이 정확하다.
 *   KICK→WAIT 전환 시 frontPos와 kickTarget 거리가 CATCH_RADIUS(5px) 이내이므로 jump 없음.
 *
 * KICK_INTERVAL = 20 / speed  (speed에 반비례)
 *   speed 50  → 0.40s / speed 100 → 0.20s / speed 150 → 0.13s
 *
 * kickAhead 스케일 (2차, speed=100 기준 30 SVG):
 *   speed 50  → ×0.25 ≈  7.5 SVG
 *   speed 100 → ×1.00 = 30 SVG
 *   speed 150 → ×2.25 ≈ 67.5 SVG
 *
 * 루프 호출 순서: PlayerMovement → DribbleController → BallMovement
 */
export class DribbleController {
    static KICK_AHEAD     = 30;   // 기준 킥 전진 거리 (speed=100 기준, SVG)
    static KICK_SPEED_REF = 100;  // kickAhead 기준 속도
    static CATCH_RADIUS   = 5;    // frontPos ↔ kickTarget 도달 판정 거리 (SVG)

    static LERP_KICK = 7;  // 킥: 볼이 목표를 향해 자연스럽게 굴러감
    static LERP_TURN = 14; // 방향전환: 볼을 앞으로 당김 (가변 부스트 포함)

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

        if (turning) {
            // TURN: 볼을 선수 앞에 lerp로 밀착 — 회전 중 뒤처짐 방지
            const distToFront = Math.hypot(this.bm.ball.x - fx, this.bm.ball.y - fy);
            // 16px 이상 벌어지면 즉시 스냅
            if (distToFront > 16) {
                this.bm.ball.setPosition(fx, fy);
                this._kicking = false;
                this._state   = 'TURN';
                return;
            }
            const angVel    = Math.abs(this.pm._angVel || 0);
            const velBoost  = Math.min(14, angVel * 0.07);
            const distBoost = Math.min(10, distToFront * 0.9);
            const lerpRate  = DribbleController.LERP_TURN + velBoost + distBoost;
            const t = Math.min(1, lerpRate * dt);
            this.bm.ball.setPosition(
                this.bm.ball.x + (fx - this.bm.ball.x) * t,
                this.bm.ball.y + (fy - this.bm.ball.y) * t,
            );
            this._kicking = false;
            this._state   = 'TURN';

        } else if (this._kicking) {
            // KICK: 볼이 고정 목표로 lerp 이동 — 선수가 따라잡으면 종료
            const t = Math.min(1, DribbleController.LERP_KICK * dt);
            this.bm.ball.setPosition(
                this.bm.ball.x + (this._kickTargetX - this.bm.ball.x) * t,
                this.bm.ball.y + (this._kickTargetY - this.bm.ball.y) * t,
            );
            this._state = 'KICK';
            const dfk = Math.hypot(fx - this._kickTargetX, fy - this._kickTargetY);
            if (dfk < DribbleController.CATCH_RADIUS) {
                this._kicking   = false;
                this._waitTimer = 0;
                this._enterWait();
            }

        } else {
            // WAIT: 볼을 frontPos에 직접 snap — lerp lag 없이 발에 완전 밀착
            if (this._state !== 'WAIT') {
                // TURN→WAIT 전환: 타이머 리셋 — 전환 직후 즉시 킥 방지
                this._kicking   = false;
                this._waitTimer = 0;
                this._enterWait();
            }
            this.bm.ball.setPosition(fx, fy);
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
    }
}
