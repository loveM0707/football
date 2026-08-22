/**
 * ShotMovement - 슈팅 물리·골대 판정 모듈
 *
 * 슈팅을 시작하면 BallMovement의 소유를 해제하고, 이 모듈이 공의
 * 수평 이동과 높이, 골대·포스트·크로스바 충돌을 전담한다.
 * 슈팅 중에는 상위 시나리오에서 BallMovement.update()를 호출하지 않는다.
 */
import { Ball } from '../entities/Ball.js';

const FIELD_HEIGHT = 680;
const GOAL_X = 1050;
const GOAL_TOP_Y = 303.4;
const GOAL_BOTTOM_Y = 376.6;
const CROSSBAR_HEIGHT = 2.44;
const HEIGHT_SCALE = 3;
const POST_HIT_RADIUS = Ball.RADIUS + 4;
const CROSSBAR_HIT_MARGIN = 0.12;
const GRAVITY = 9.8;
const ENDLINE_DISTANCE = 30;

export class ShotMovement {
    constructor(options = {}) {
        this._goalX = options.goalX ?? GOAL_X;
        this._goalTopY = options.goalTopY ?? GOAL_TOP_Y;
        this._goalBottomY = options.goalBottomY ?? GOAL_BOTTOM_Y;
        this._crossbarHeight = options.crossbarHeight ?? CROSSBAR_HEIGHT;
        this._heightScale = options.heightScale ?? HEIGHT_SCALE;
        this._phase = 'idle';
        this._result = null;
        this._onResult = null;
        this._bm = null;
        this._ball = null;
        this._elapsed = 0;
        this._duration = 0;
        this._startX = 0;
        this._startY = 0;
        this._targetX = 0;
        this._targetY = 0;
        this._startZ = 0;
        this._targetZ = 0;
        this._arcHeight = 0;
        this._speed = 0;
        this._rebound = null;
        this._out = null;
        this._impactResult = null;
    }

    get active() { return this._phase !== 'idle' && this._result === null; }
    get result() { return this._result; }

    /**
     * 소유 중인 공을 슈팅한다.
     * @returns {boolean} 소유 중이고 슈팅을 시작했으면 true
     */
    shoot(ballMovement, options = {}) {
        if (this.active || !ballMovement.owner) return false;

        const ball = ballMovement.ball;
        const targetX = options.goalX ?? this._goalX;
        const distanceX = targetX - ball.x;
        if (distanceX <= 0) return false;

        this._bm = ballMovement;
        this._ball = ball;
        this._startX = ball.x;
        this._startY = ball.y;
        this._targetX = targetX;
        this._targetY = options.targetY ?? (this._goalTopY + this._goalBottomY) * 0.5;
        this._startZ = options.startHeight ?? 0.08;
        this._targetZ = Math.max(0, options.targetHeight ?? 0.5);
        this._arcHeight = Math.max(0, options.arcHeight ?? 0.2);
        this._speed = Math.max(1, options.speed ?? 520);
        this._duration = distanceX / this._speed;
        this._elapsed = 0;
        this._result = null;
        this._onResult = options.onResult ?? null;
        this._rebound = null;
        this._out = null;
        this._impactResult = null;
        this._phase = 'flight';

        ballMovement.release(0, 0);
        ball.setHeight(this._startZ / this._heightScale);
        return true;
    }

    update(dt) {
        if (!this.active) return;
        if (this._phase === 'flight') {
            this._updateFlight(dt);
        } else if (this._phase === 'rebound') {
            this._updateRebound(dt);
        } else if (this._phase === 'out') {
            this._updateOut(dt);
        }
    }

    _updateFlight(dt) {
        this._elapsed = Math.min(this._duration, this._elapsed + dt);
        const progress = this._elapsed / this._duration;
        const z = this._startZ
            + (this._targetZ - this._startZ) * progress
            + 4 * this._arcHeight * progress * (1 - progress);
        this._ball.setPosition(
            this._startX + (this._targetX - this._startX) * progress,
            this._startY + (this._targetY - this._startY) * progress,
        );
        this._ball.setHeight(z / this._heightScale);

        if (this._elapsed >= this._duration) this._resolveGoalLine(z);
    }

    _resolveGoalLine(height) {
        const insideGoal = this._targetY >= this._goalTopY
            && this._targetY <= this._goalBottomY;
        const nearTopPost = Math.abs(this._targetY - this._goalTopY) <= POST_HIT_RADIUS;
        const nearBottomPost = Math.abs(this._targetY - this._goalBottomY) <= POST_HIT_RADIUS;
        const nearCrossbar = Math.abs(height - this._crossbarHeight) <= CROSSBAR_HIT_MARGIN
            && insideGoal;

        if (height > this._crossbarHeight + CROSSBAR_HIT_MARGIN) {
            this._startOut('miss-high', height);
            return;
        }

        if (!insideGoal) {
            this._startOut('miss-wide', height);
            return;
        }

        if (nearTopPost || nearBottomPost || nearCrossbar) {
            const impact = nearCrossbar ? 'crossbar' : 'post';
            if (Math.random() < 0.5) {
                this._startRebound(nearCrossbar, nearTopPost, impact);
            } else {
                this._startOut(impact, height);
            }
            return;
        }

        this._finish('goal');
    }

    _startRebound(hitCrossbar, hitTopPost, impact) {
        this._impactResult = impact;
        const side = hitTopPost ? -1 : 1;
        this._rebound = {
            x: this._ball.x,
            y: this._ball.y,
            z: Math.max(0, this._targetZ),
            vx: -this._speed * 0.6,
            vy: hitCrossbar ? (Math.random() - 0.5) * this._speed * 0.35 : side * this._speed * 0.35,
            vz: hitCrossbar ? 2.2 : 0.8,
            elapsed: 0,
        };
        this._phase = 'rebound';
    }

    _updateRebound(dt) {
        const rebound = this._rebound;
        rebound.elapsed += dt;
        rebound.x += rebound.vx * dt;
        rebound.y += rebound.vy * dt;
        rebound.z = Math.max(0, rebound.z + rebound.vz * dt);
        rebound.vz -= GRAVITY * dt;
        this._ball.setPosition(rebound.x, rebound.y);
        this._ball.setHeight(rebound.z / this._heightScale);

        const leftField = rebound.x < this._goalX - 20;
        const outsideField = rebound.y < -Ball.RADIUS || rebound.y > FIELD_HEIGHT + Ball.RADIUS;
        const timedOut = rebound.elapsed > 1.5;
        if (leftField || outsideField || timedOut) this._finish('post-rebound');
    }

    _startOut(result, height) {
        const flightDuration = Math.max(this._duration, 0.01);
        this._out = {
            x: this._ball.x,
            y: this._ball.y,
            z: height,
            vx: this._speed,
            vy: (this._targetY - this._startY) / flightDuration,
            vz: (this._targetZ - this._startZ) / flightDuration,
            result,
        };
        this._phase = 'out';
    }

    _updateOut(dt) {
        const out = this._out;
        out.x += out.vx * dt;
        out.y += out.vy * dt;
        out.z = Math.max(0, out.z + out.vz * dt);
        this._ball.setPosition(out.x, out.y);
        this._ball.setHeight(out.z / this._heightScale);

        if (out.x >= this._goalX + ENDLINE_DISTANCE) this._finish(out.result);
    }

    _finish(result) {
        if (this._result !== null) return;
        if (result === 'post-rebound') result = this._impactResult ?? result;
        this._result = result;
        this._phase = 'idle';
        this._bm.vx = 0;
        this._bm.vy = 0;
        this._ball.setHeight(0);
        if (this._onResult) this._onResult(result);
    }
}
