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
        // 모듈 공통 안정화: 소유 직후 킥까지 유예 (볼이 떨어졌다 붙는 현상 방지)
        this._graceTimer   = 0;
        this._startPosX    = 0;
        this._startPosY    = 0;
    }

    start() {
        this._active       = true;
        this._kicking      = false;
        this._waitTimer    = 0;
        this._kickTimer    = 0;
        this._state        = 'WAIT';
        this._pendingSpeed = null;
        // 시작 후 0.25초 동안은 킥 금지 + 발 앞 snap 유지
        this._graceTimer   = 0.25;
        this._startPosX    = this.pm.player.x;
        this._startPosY    = this.pm.player.y;
        if (this.bm.owner) this.bm.snapToFront();
    }

    stop() {
        this._active       = false;
        this._kicking      = false;
        this._state        = 'WAIT';
        this._pendingSpeed = null;
        this._graceTimer   = 0;
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

        // 소유 직후 유예: 볼을 발 앞에 단단히 고정, 킥 억제
        if (this._graceTimer > 0) {
            this._graceTimer -= dt;
            // 유예 중에도 회전 중이면 snap, 아니면 snap 유지. 절대 킥하지 않음
            this.bm.ball.setPosition(fx, fy);
            this._waitTimer = 0;
            if (turning) this._state = 'TURN';
            else this._state = 'WAIT';
            // 이동이 일정 거리 이상 진행되면 유예 조기 해제 없음 — 최소 시간 보장
            return;
        }

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

            // 선수가 정지한 상태에서는 킥하지 않고 볼을 발에 붙인다.
            if (!this.pm.moving) {
                this._kicking = false;
                this._waitTimer = 0;
                return;
            }

            // 최소 이동 거리 보장: 시작점으로부터 12 이상 이동 전에는 킥 억제 (초기 드리블 안정화)
            const dx0 = this.pm.player.x - this._startPosX;
            const dy0 = this.pm.player.y - this._startPosY;
            const moved = this._startPosX === 0 && this._startPosY === 0 ? Infinity : Math.hypot(dx0, dy0);
            if (moved < 12) {
                this._waitTimer = Math.min(this._waitTimer, this._kickInterval() * 0.6);
                return;
            }

            if (this._waitTimer >= this._kickInterval()) {
                const kickAhead   = this._calcKickAhead();
                // 초기 킥은 짧게 (자연스러운 첫 터치) — 이후 킥은 정상 거리
                const isFirstKick = this._startPosX !== 0 || this._startPosY !== 0;
                const scaledAhead = isFirstKick && moved < 40 ? kickAhead * 0.55 : kickAhead;
                this._kickTargetX = fx + fwdX * scaledAhead;
                this._kickTargetY = fy + fwdY * scaledAhead;
                this._kicking      = true;
                this._kickTimer    = 0;
                this._kickTimeLimit = scaledAhead / this.pm.speed;
                this._waitTimer    = 0;
                this._state        = 'KICK';
                // 첫 킥 후 시작점 갱신으로 다음 킥은 정상 동작
                if (isFirstKick && moved < 40) {
                    this._startPosX = 0; this._startPosY = 0;
                }
            }
        }
    }
}
