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
        this._aerialBounce = null;
        this._bounce = null;
    }

    get owner() { return this._owner; }
    get offset() { return this._offset; }

    /** 선수가 공을 소유한다. 위치 전환은 DribbleController의 lerp에 맡긴다. */
    possess(player, offset) {
        this._owner = player;
        this._offset = offset;
        // 소유와 비행은 상호 배타 — 낡은 공중 상태가 남으면 인터셉터가
        // 영구히 볼을 외면한다 (아웃 후 드릴 리셋 등이 비행 중 소유를 만들 때)
        this._aerial = false;
        this._aerialTimer = 0;
        this._aerialOnLand = null;
        this._aerialBounce = null;
        this._bounce = null;
        this.ball.setHeight(0);
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
        this._aerialBounce = null;
        this._bounce = null;
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
    releaseAerial(vx, vy, duration, maxH = 1, onLand = null, bounce = null) {
        this._owner = null;
        this._aerial = true;
        this._bounce = null;
        this._aerialVx = vx;
        this._aerialVy = vy;
        this._aerialDuration = duration;
        this._aerialTimer = 0;
        this._aerialMaxH = maxH;
        this._aerialOnLand = onLand;
        this._aerialBounce = bounce;
        this.vx = 0;
        this.vy = 0;
    }

    /** 현재 공중 비행 중이면 true */
    get isAerial() { return this._aerial; }

    /** 착지 후 바운드 중이면 true */
    get isBouncing() { return this._bounce !== null; }

    /**
     * 공중 비행 상태 공개 스냅샷 (읽기 전용 복사).
     * private(_aerialVx 등) 직접 접근 대신 이 getter를 사용한다.
     * 기존 HeadingSystem·BallReception·시나리오 3곳의 중복 접근을 대체한다.
     * @returns {null | { vx, vy, duration, timer, remaining, maxH, progress }}
     */
    get aerialState() {
        if (!this._aerial) return null;
        const remaining = this._aerialDuration - this._aerialTimer;
        return {
            vx: this._aerialVx,
            vy: this._aerialVy,
            duration: this._aerialDuration,
            timer: this._aerialTimer,
            remaining,
            maxH: this._aerialMaxH,
            progress: this._aerialDuration > 0 ? this._aerialTimer / this._aerialDuration : 0,
        };
    }

    /**
     * 바운드 상태 공개 스냅샷 (읽기 전용 복사).
     * @returns {null | { timer, duration, remaining, maxHeight, vx, vy }}
     */
    get bounceState() {
        const b = this._bounce;
        if (!b) return null;
        return {
            timer: b.timer,
            duration: b.duration,
            remaining: b.duration - b.timer,
            maxHeight: b.maxHeight,
            vx: b.vx,
            vy: b.vy,
        };
    }

    /** 공을 소유자 앞 위치로 즉시 이동 */
    snapToFront() {
        if (!this._owner) return;
        const { x, y } = this.frontPos();
        this.ball.setPosition(x, y);
    }

    /**
     * 소유자 앞 위치 좌표를 반환.
     * @param {number} [extra=0]       기본 offset에 추가할 거리
     * @param {number} [pressure=0]    압박 강도 (0~1). 높으면 볼을 몸 가까이
     */
    frontPos(extra = 0, pressure = 0) {
        // 압박이 강할수록 오프셋을 줄여 볼을 가까이 유지 (최대 25% 감소)
        const pressAdj = this._offset * (1 - Math.min(1, pressure) * 0.25);
        const totalOffset = pressAdj + extra;
        const fwd = forwardVector(this._owner.angle);
        return {
            x: this._owner.x + fwd.x * totalOffset,
            y: this._owner.y + fwd.y * totalOffset,
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
                const bounce = this._aerialBounce;
                this._aerialBounce = null;
                if (bounce) {
                    this._bounce = {
                        timer: 0,
                        duration: bounce.duration ?? 0.4,
                        maxHeight: bounce.maxHeight ?? 0.3,
                        vx: bounce.vx ?? this._aerialVx * (bounce.velocityScale ?? 0.6),
                        vy: bounce.vy ?? this._aerialVy * (bounce.velocityScale ?? 0.6),
                        postVx: bounce.postVx,
                        postVy: bounce.postVy,
                    };
                }
                if (onLand) onLand();
            }
            return;
        }

        if (this._bounce) {
            const bounce = this._bounce;
            const useDt = Math.min(dt, bounce.duration - bounce.timer);
            bounce.timer += useDt;
            const progress = bounce.timer / bounce.duration;
            this.ball.setHeight(bounce.maxHeight * 4 * progress * (1 - progress));
            this.ball.setPosition(
                this.ball.x + bounce.vx * useDt,
                this.ball.y + bounce.vy * useDt,
            );
            if (bounce.timer >= bounce.duration) {
                this.ball.setHeight(0);
                this.vx = bounce.postVx ?? bounce.vx * 0.75;
                this.vy = bounce.postVy ?? bounce.vy * 0.75;
                this._bounce = null;
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
