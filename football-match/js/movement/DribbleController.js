/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 상태 우선순위 (높은 순):
 *   KICK : 볼 비행 중 — 방향전환이 있어도 중단 없이 계속 진행.
 *          선수 frontPos가 kickTarget에 도달하면 종료.
 *   TURN : 방향전환 중, 볼을 frontPos에 snap. 타이머 누적.
 *   WAIT : 직진 중, 볼을 frontPos에 snap. 타이머 누적.
 *
 * WAIT와 TURN 모두 snap을 쓰는 이유:
 *   lerp lag = speed / lerpRate. speed=150, lerpRate=38이면 lag≈4px.
 *   볼이 발에 붙어 있어야 하는 상태에서 lag는 불필요하다.
 *
 * KICK 우선순위가 높은 이유:
 *   방향전환 중 KICK을 끊으면 볼이 앞에서 발로 순간 복귀 — "뒤로 처지는" 느낌의 주원인.
 *   KICK이 자연 종료(선수가 따라잡음)된 후에야 발에 붙음.
 *
 * 타이머는 TURN 중에도 누적:
 *   잦은 방향전환에서 타이머가 계속 0으로 리셋되면 킥이 영원히 발동되지 않아 볼이 발에 고착됨.
 *
 * KICK_INTERVAL = 20 / speed
 *   speed 50 → 0.40s / speed 100 → 0.20s / speed 150 → 0.13s
 *
 * kickAhead (2차 스케일, speed=100 기준 30 SVG):
 *   speed 50 → 7.5 SVG / speed 100 → 30 SVG / speed 150 → 67.5 SVG
 */
export class DribbleController {
    static KICK_AHEAD     = 30;   // 기준 킥 전진 거리 (speed=100 기준, SVG)
    static KICK_SPEED_REF = 100;  // kickAhead 기준 속도
    static CATCH_RADIUS   = 5;    // frontPos ↔ kickTarget 도달 판정 거리 (SVG)
    static LERP_KICK      = 7;    // 킥: 볼이 목표를 향해 자연스럽게 굴러감

    constructor(playerMovement, ballMovement) {
        this.pm = playerMovement;
        this.bm = ballMovement;
        this._active       = false;
        this._kicking      = false;
        this._waitTimer    = 0;
        this._kickTargetX  = 0;
        this._kickTargetY  = 0;
        this._state        = 'WAIT';
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

    _calcKickAhead() {
        const r = this.pm.speed / DribbleController.KICK_SPEED_REF;
        return DribbleController.KICK_AHEAD * r * r;
    }

    _kickInterval() {
        return 20 / this.pm.speed;
    }

    _enterWait() {
        if (this._pendingSpeed !== null) {
            this.pm.speed      = this._pendingSpeed;
            this._pendingSpeed = null;
        }
        this._state = 'WAIT';
    }

    update(dt) {
        if (!this._active || !this.bm.owner) return;

        const { x: fx, y: fy, fwdX, fwdY } = this.bm.frontPos();

        if (this._kicking) {
            // ── KICK: 최우선 ──────────────────────────────────────────
            // 방향전환 중에도 볼 비행 유지 — 중단 시 볼이 앞→발로 순간복귀하며 뒤처짐처럼 보임
            this._state = 'KICK';
            const t = Math.min(1, DribbleController.LERP_KICK * dt);
            this.bm.ball.setPosition(
                this.bm.ball.x + (this._kickTargetX - this.bm.ball.x) * t,
                this.bm.ball.y + (this._kickTargetY - this.bm.ball.y) * t,
            );
            const dfk = Math.hypot(fx - this._kickTargetX, fy - this._kickTargetY);
            if (dfk < DribbleController.CATCH_RADIUS) {
                this._kicking   = false;
                this._waitTimer = 0;
                this._enterWait();
            }

        } else {
            // ── TURN / WAIT: 볼을 frontPos에 snap ─────────────────────
            const turning = this.pm.isTurning();
            if (turning) {
                this._state = 'TURN';
            } else if (this._state !== 'WAIT') {
                this._enterWait(); // pendingSpeed 반영
            }

            // TURN·WAIT 모두 snap — lerp lag 없이 발에 완전 밀착
            this.bm.ball.setPosition(fx, fy);

            // 타이머는 TURN 중에도 계속 누적 — 잦은 방향전환으로 인한 볼 고착 방지
            this._waitTimer += dt;

            // 방향이 정렬됐을 때만 킥 — 방향전환 중 킥으로 볼이 엉뚱한 방향으로 나가는 것 방지
            if (!turning && this._waitTimer >= this._kickInterval()) {
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
