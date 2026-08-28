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
 * kickAhead = 36 * (speed/100)^2 — 50은 배제, 75 이상 유지로 발 붙음 방지
 */
import { angleDiff, angleTo } from './Direction.js';

export class DribbleController {
    static KICK_AHEAD     = 12;
    static KICK_SPEED_REF = 100;
    static CATCH_RADIUS   = 5.5;
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
        this._smoothCatchT = 0;
        // 완급용 내부 위상 — 시나리오가 아닌 모듈이 직접 관리해 전 메뉴 공통 적용
        this._weaveOffset  = Math.random() * Math.PI * 2;
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
        this._smoothCatchT = 0;
        if (this.bm.owner) this.bm.snapToFront();
    }

    stop() {
        this._active       = false;
        this._kicking      = false;
        this._state        = 'WAIT';
        this._pendingSpeed = null;
        this._graceTimer   = 0;
        this._smoothCatchT = 0;
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
        // 발에서 툭 치는 효과: 8~14 전방(0.8~1.4m) — 떨어져 보이지 않게 최소·최대 제한
        return 14 + DribbleController.KICK_AHEAD * r * r;
    }

    _kickInterval() {
        // 완급: 기본 간격에 ±22% 지터로 킥 리듬을 불규칙화
        const base = 20 / this.pm.speed;
        const jitter = 0.88 + Math.random() * 0.24; // 0.88~1.12
        return base * jitter;
    }

    _kickVariation(speed) {
        // 자연스러운 툭툭: 0.88~1.12 기본 변주에 가끔만 강한/짧은 터치
        // 이전 0.47~1.82 넓은 편차가 발에 붙어 보이는 원인 — 범위 축소
        let base = 0.88 + Math.random() * 0.24; // 0.88~1.12
        const roll = Math.random();
        if (roll < 0.10) base *= 1.28;      // 가끔 롱터치
        else if (roll < 0.20) base *= 0.82; // 가끔 짧은 터치
        // 저속에서도 최소 0.88 유지 — 너무 짧아 발 아래로 들어가는 현상 방지
        if (speed <= 75) base = Math.max(0.90, Math.min(base, 1.08));
        if (speed >= 150) base = Math.max(base, 0.92);
        return base;
    }

    _enterWait() {
        if (this._pendingSpeed !== null) {
            this.pm.speed      = this._pendingSpeed;
            this._pendingSpeed = null;
        }
        this._state = 'WAIT';
    }

    /**
     * 모듈 내부 완급 자동 조절 — 시나리오가 pm.speed를 직접 다루지 않아도
     * 압박·템포에 따라 75~150를 오가며 툭툭 리듬을 만든다.
     * ctx: { defenders?: Player[], pressDistance?: number, clock?: number }
     */
    _autoSpeed(dt, ctx = {}) {
        if (!ctx.clock && ctx.clock !== 0 && ctx.pressDistance == null && !ctx.defenders) return;
        // pressDistance 계산
        let pressD = ctx.pressDistance;
        if (pressD == null && ctx.defenders) {
            pressD = Infinity;
            for (const d of ctx.defenders) {
                const dd = Math.hypot(d.x - this.pm.player.x, d.y - this.pm.player.y);
                if (dd < pressD) pressD = dd;
            }
        }
        if (pressD == null) pressD = Infinity;
        const clock = ctx.clock ?? 0;
        const tempoPhase = (Math.sin(clock * 1.35 + this._weaveOffset) * 0.6
                         + Math.sin(clock * 0.75 + this._weaveOffset * 0.73) * 0.4);
        const burstRoll = Math.random();
        const SPEEDS = [50, 75, 100, 125, 150];
        let targetSpeed;
        if (pressD < 55) {
            if (tempoPhase > 0.18) targetSpeed = SPEEDS[4];
            else if (tempoPhase > -0.45) targetSpeed = SPEEDS[3];
            else targetSpeed = SPEEDS[2];
            if (burstRoll < 0.014) targetSpeed = SPEEDS[1];
        } else if (pressD < 95) {
            if (tempoPhase > 0.38) targetSpeed = SPEEDS[4];
            else if (tempoPhase > -0.18) targetSpeed = SPEEDS[3];
            else if (tempoPhase > -0.62) targetSpeed = SPEEDS[2];
            else targetSpeed = SPEEDS[1];
            if (burstRoll < 0.010) targetSpeed = SPEEDS[1];
        } else if (pressD < 155) {
            if (tempoPhase > 0.55) targetSpeed = SPEEDS[4];
            else if (tempoPhase > 0.05) targetSpeed = SPEEDS[3];
            else if (tempoPhase > -0.45) targetSpeed = SPEEDS[2];
            else targetSpeed = SPEEDS[1];
            if (burstRoll < 0.018) targetSpeed = SPEEDS[4];
            if (burstRoll < 0.008) targetSpeed = SPEEDS[1];
        } else {
            if (tempoPhase > 0.48) targetSpeed = SPEEDS[3];
            else if (tempoPhase > -0.12) targetSpeed = SPEEDS[2];
            else targetSpeed = SPEEDS[1];
            if (burstRoll < 0.014) targetSpeed = SPEEDS[4];
        }
        // 엔드라인 근처에서는 감속
        const p = this.pm.player;
        if ((p.x > 1022) || (p.x < 28)) targetSpeed = SPEEDS[1];
        this.setSpeed(targetSpeed);
    }

    update(dt, ctx = {}) {
        if (!this._active || !this.bm.owner) return;
        // 시나리오가 아닌 모듈이 완급을 직접 수행 — ctx가 있으면 자동 속도 조절
        if (ctx && (ctx.defenders || ctx.pressDistance != null || ctx.clock != null)) {
            this._autoSpeed(dt, ctx);
        }

        const { x: fx, y: fy, fwdX, fwdY } = this.bm.frontPos();
        // 볼이 발에 붙었을 때만 방향 전환 허용 — 180도 전환 시 볼이 멀리 떨어졌다가 붙는 현상 방지
        const ballDistToFoot = Math.hypot(this.bm.ball.x - fx, this.bm.ball.y - fy);
        const canTurn = this.ballAttached && ballDistToFoot < 6.5;
        // 방향 전환 판정 — KICK 중에는 임계치 상향(28°/90)해 큰 킥 도중 미세 선회로
        // 볼이 즉시 발에 달라붙는 현상 방지 (단, canTurn이 false면 턴 자체를 무시)
        let turning = false;
        if (canTurn) {
            turning = this.pm.isTurning();
            if (this._kicking) {
                const facingTarget = this.pm.getDesiredAngle?.() ?? this.pm._facingTarget ?? null;
                const movingTarget = this.pm._tx !== null && this.pm._ty !== null
                    ? angleTo(this.pm.player.x, this.pm.player.y, this.pm._tx, this.pm._ty)
                    : null;
                const desired = facingTarget ?? movingTarget;
                if (desired !== null) {
                    const diff = Math.abs(angleDiff(desired, this.pm.player.angle));
                    const vel = Math.abs(this.pm._angVel ?? 0);
                    turning = diff > 28 || vel > 90;
                } else {
                    // 목표가 없으면 일반 판정보다 완화
                    turning = Math.abs(this.pm._angVel ?? 0) > 90;
                }
            }
        }

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
            // ── TURN: KICK 중 턴이면 볼을 발로 즉시 당기지 않고, 킥 목표를 향해 계속 전진
            // 큰 킥 후 턴으로 볼이 발 아래로 빨려 들어가 감춰지는 현상 방지
            if (this._kicking) {
                const t = Math.min(1, DribbleController.LERP_KICK * dt);
                this.bm.ball.setPosition(
                    this.bm.ball.x + (this._kickTargetX - this.bm.ball.x) * t,
                    this.bm.ball.y + (this._kickTargetY - this.bm.ball.y) * t,
                );
                this._kickTimer += dt;
                this._waitTimer += dt;
                const dfk = Math.hypot(fx - this._kickTargetX, fy - this._kickTargetY);
                const isFallback = this._kickTimer >= this._kickTimeLimit;
                if (dfk < DribbleController.CATCH_RADIUS || isFallback) {
                    this._kicking = false;
                    this._waitTimer = 0;
                    this._enterWait();
                    if (isFallback) {
                        const distToFront = Math.hypot(this.bm.ball.x - fx, this.bm.ball.y - fy);
                        if (distToFront > 12) this._smoothCatchT = Math.min(0.18, distToFront / 90);
                    }
                }
                this._state = 'TURN';
                return;
            }
            // 비 KICK 턴은 빠르게 lerp
            const t = Math.min(1, 12 * dt);
            this.bm.ball.setPosition(
                this.bm.ball.x + (fx - this.bm.ball.x) * t,
                this.bm.ball.y + (fy - this.bm.ball.y) * t,
            );
            if (Math.hypot(fx - this.bm.ball.x, fy - this.bm.ball.y) < 1.2) {
                this.bm.ball.setPosition(fx, fy);
            }
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
            const isFallback = this._kickTimer >= this._kickTimeLimit;
            if (dfk < DribbleController.CATCH_RADIUS || isFallback) {
                this._kicking   = false;
                this._waitTimer = 0;
                this._enterWait();
                if (isFallback) {
                    // 큰 킥 후 시간 경과로 잡는 경우 즉시 snap하면 순간이동 — 부드러운 캐치로 전환
                    const distToFront = Math.hypot(this.bm.ball.x - fx, this.bm.ball.y - fy);
                    if (distToFront > 12) {
                        this._smoothCatchT = Math.min(0.18, distToFront / 90);
                    } else {
                        this.bm.ball.setPosition(fx, fy);
                    }
                } else {
                    this.bm.ball.setPosition(fx, fy);
                }
            }

        } else {
            // ── WAIT: 볼을 frontPos에 snap — 큰 킥 직후에는 lerp로 부드럽게 복귀
            if (this._state !== 'WAIT') this._enterWait();
            if (this._smoothCatchT > 0) {
                this._smoothCatchT -= dt;
                const tt = Math.min(1, 10 * dt);
                this.bm.ball.setPosition(
                    this.bm.ball.x + (fx - this.bm.ball.x) * tt,
                    this.bm.ball.y + (fy - this.bm.ball.y) * tt,
                );
                if (this._smoothCatchT <= 0 || Math.hypot(fx - this.bm.ball.x, fy - this.bm.ball.y) < 1.5) {
                    this.bm.ball.setPosition(fx, fy);
                    this._smoothCatchT = 0;
                }
            } else {
                this.bm.ball.setPosition(fx, fy);
            }
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
                let scaledAhead = isFirstKick && moved < 40 ? kickAhead * 0.55 : kickAhead;
                // 완급·툭툭: 스피드와 랜덤에 따른 킥 거리 변주
                scaledAhead *= this._kickVariation(this.pm.speed);
                // 고속 스프린트는 볼을 더 멀리 툭, 저속은 발에 가깝게
                this._kickTargetX = fx + fwdX * scaledAhead;
                this._kickTargetY = fy + fwdY * scaledAhead;
                this._kicking      = true;
                this._kickTimer    = 0;
                // 시간 기반 fallback도 변주 거리 반영 + 여유 — 큰 킥이 즉시 snap되지 않게 8~22% 여유
                this._kickTimeLimit = (scaledAhead / this.pm.speed) * (1.08 + Math.random() * 0.14);
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
