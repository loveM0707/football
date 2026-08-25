/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 상태 우선순위 (높은 순):
 *   TURN : 방향전환 중. 볼을 frontPos에 snap + 킥 취소.
 *   KICK : 볼이 kickTarget(킥 시점의 전방 고정 위치)으로 lerp 이동.
 *   WAIT : 직진 중. 볼을 frontPos에 snap. 타이머 누적 후 킥 발동.
 *
 * TURN > KICK인 이유:
 *   방향전환 중에도 KICK을 유지하면 볼이 구 방향의 kickTarget에 고착되어
 *   선수가 새 방향으로 달려가면서 볼이 100+ SVG 뒤에 남는다.
 *
 * KICK catch 조건:
 *   1. frontPos ↔ kickTarget < CATCH_RADIUS (기본: 선수가 따라잡음)
 *   2. kickTimer > expectedTime (시간 기반 fallback)
 *   조건 2가 필요한 이유: 킥 발동 직후 각도 보정(spring-damper)으로 frontPos 경로가
 *   kickTarget에서 수 SVG 빗나갈 수 있음 (4.8° 보정 × 86.5 SVG = 7.1 SVG 수직 오프셋).
 *   CATCH_RADIUS(5) 이내로 접근하지 못해 킥이 영원히 끝나지 않는 현상의 원인.
 *   시간 fallback은 볼이 kickTarget에 수렴한 뒤 frontPos로 자연 snap한다.
 *
 * WAIT·TURN: snap (lerp lag = speed/rate 제거).
 * 타이머는 TURN 중에도 누적 (잦은 방향전환 시 볼 고착 방지).
 *
 * KICK_INTERVAL = 20 / speed
 * kickAhead = 30 * (speed/100)^2
 */
export class DribbleController {
    static KICK_AHEAD     = 30;
    static KICK_SPEED_REF = 100;
    static CATCH_RADIUS   = 5;
    static LERP_KICK      = 7;

    constructor(playerMovement, ballMovement) {
        this.pm = playerMovement;
        this.bm = ballMovement;
        this._active       = false;
        this._kicking      = false;
        this._waitTimer    = 0;
        this._kickTargetX  = 0;
        this._kickTargetY  = 0;
        this._kickTimer    = 0;
        this._kickTimeLimit = 0;
        this._state        = 'WAIT';
        this._pendingSpeed = null;
    }

    start() {
        this._active       = true;
        this._kicking      = false;
        this._waitTimer    = 0;
        this._kickTimer    = 0;
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

    setSpeed(speed) {
        if (!this._active || this._state === 'WAIT') {
            this.pm.speed = speed;
        } else {
            this._pendingSpeed = speed;
        }
    }

    /** 공이 선수의 발에 붙어 있어 다음 동작을 수행할 수 있는 상태인지 반환한다. */
    get ballAttached() {
        return this._active && Boolean(this.bm.owner) && !this._kicking;
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

        const turning = this.pm.isTurning();
        const { x: fx, y: fy, fwdX, fwdY } = this.bm.frontPos();

        if (turning) {
            // ── TURN: 최우선 — 볼을 frontPos에 snap, 킥 취소 ──────
            this.bm.ball.setPosition(fx, fy);
            this._kicking = false;
            this._state   = 'TURN';
            this._waitTimer += dt;

        } else if (this._kicking) {
            // ── KICK: 볼이 고정 목표로 lerp ─────────────────────────
            // 선수가 정지한 경우 킥을 취소하고 볼을 발 앞에 붙인다.
            if (!this.pm.moving) {
                this._kicking = false;
                this._waitTimer = 0;
                this.bm.ball.setPosition(fx, fy);
                return;
            }
            this._state = 'KICK';
            const t = Math.min(1, DribbleController.LERP_KICK * dt);
            this.bm.ball.setPosition(
                this.bm.ball.x + (this._kickTargetX - this.bm.ball.x) * t,
                this.bm.ball.y + (this._kickTargetY - this.bm.ball.y) * t,
            );

            this._kickTimer += dt;
            const dfk = Math.hypot(fx - this._kickTargetX, fy - this._kickTargetY);
            if (dfk < DribbleController.CATCH_RADIUS || this._kickTimer >= this._kickTimeLimit) {
                this._kicking   = false;
                this._waitTimer = 0;
                this._enterWait();
                // 시간 fallback으로 catch된 경우: 볼을 frontPos에 즉시 snap
                this.bm.ball.setPosition(fx, fy);
            }

        } else {
            // ── WAIT: 볼을 frontPos에 snap, 타이머 후 킥 ───────────
            if (this._state !== 'WAIT') this._enterWait();
            this.bm.ball.setPosition(fx, fy);
            this._waitTimer += dt;

            // 선수가 정지한 상태(이동 목표 없음)에서는 킥하지 않고 볼을 발에 붙인다.
            // (예: 슈팅 직전 정지, 슬로우 키핑 등)
            if (!this.pm.moving) {
                this._kicking = false;
                this._waitTimer = 0;
                return;
            }

            if (this._waitTimer >= this._kickInterval()) {
                const kickAhead   = this._calcKickAhead();
                this._kickTargetX = fx + fwdX * kickAhead;
                this._kickTargetY = fy + fwdY * kickAhead;
                this._kicking      = true;
                this._kickTimer    = 0;
                this._kickTimeLimit = kickAhead / this.pm.speed;
                this._waitTimer    = 0;
                this._state        = 'KICK';
            }
        }
    }
}
