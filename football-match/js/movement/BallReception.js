/**
 * BallReception - 볼 트래핑·수령 모듈
 *
 * 공이 선수 앞에 접근하거나 지나칠 때, 적절한 거리와 속도 조건을
 * 만족하면 볼을 소유하고 드리블로 전환한다. 로빙 패스 착지·바운드,
 * 지상 패스 등 다양한 상황에서 재사용할 수 있다.
 */
import { Player } from '../entities/Player.js';
import { PlayerMovement } from './PlayerMovement.js';
import { DribbleController } from './DribbleController.js';
import { angleTo, forwardVector } from './Direction.js';

const DEFAULT_CATCH_DISTANCE = 8;
const DEFAULT_MAX_BALL_SPEED = 180;
const DEFAULT_REACTION_WINDOW = 0.5;
const DEFAULT_TRACK_DISTANCE = 120;
const CONTACT_DISTANCE_MARGIN = 3;

export class BallReception {
    constructor(player, playerMovement, ballMovement, options = {}) {
        this._player = player;
        this._pm = playerMovement;
        this._bm = ballMovement;
        this._catchDistance = options.catchDistance ?? DEFAULT_CATCH_DISTANCE;
        this._maxBallSpeed = options.maxBallSpeed ?? DEFAULT_MAX_BALL_SPEED;
        this._reactionWindow = options.reactionWindow ?? DEFAULT_REACTION_WINDOW;
        this._trackDistance = options.trackDistance ?? DEFAULT_TRACK_DISTANCE;
        this._trackReceiver = options.trackReceiver ?? true;

        this._dribble = new DribbleController(this._pm, this._bm);
        this._active = false;
        this._complete = false;
        this._onReceive = null;
        this._targetX = null;
        this._targetY = null;
        this._onFinish = null;
        this._trackTimer = 0;
        this._tracking = false;
        this._aerialPlanned = false;
    }

    start(options = {}) {
        this._active = true;
        this._complete = false;
        this._onReceive = options.onReceive ?? null;
        this._targetX = options.targetX ?? null;
        this._targetY = options.targetY ?? null;
        this._onFinish = options.onFinish ?? null;
        this._trackTimer = 0;
        this._tracking = false;
        this._aerialPlanned = false;
    }

    stop() {
        this._active = false;
        this._dribble.stop();
    }

    get received() { return this._complete; }

    update(dt) {
        if (!this._active) return;
        if (this._complete) {
            this._dribble.update(dt);
            return;
        }

        const ball = this._bm.ball;

        // 공중 비행 중에는 미리 궤적을 예측해 수령 지점을 잡아둔다.
        if (this._bm.isAerial) {
            this._planAerialReception();
            return;
        }

        // 바운드 중에는 트래핑하지 않지만, 바운드가 끝날 지점을 계속 추적한다.
        if (this._bm.isBouncing) {
            if (this._trackReceiver) this._trackBounce(dt);
            return;
        }

        // 지면에 남은 공의 속도
        const ballSpeed = Math.hypot(this._bm.vx, this._bm.vy);

        const fwd = forwardVector(this._player.angle);
        const possessionOffset = Player.BODY_RADIUS + 8;
        const dx = ball.x - this._player.x;
        const dy = ball.y - this._player.y;
        const dot = dx * fwd.x + dy * fwd.y;

        // 착지 후 공이 앞쪽으로 굟러가면 수령 선수가 접점까지 짧게 보정한다.
        if (this._trackReceiver && dot > 0 && dot < this._trackDistance) {
            this._trackTimer -= dt;
            if (this._trackTimer <= 0) {
                this._trackTimer = 0.08;
                this._tracking = true;
                this._pm.moveTo(
                    ball.x - fwd.x * possessionOffset,
                    ball.y - fwd.y * possessionOffset,
                );
            }
        }

        // 볼이 선수의 실제 발 앞 소유 지점에 도달했는지 판정한다.
        const expectedX = this._player.x + fwd.x * possessionOffset;
        const expectedY = this._player.y + fwd.y * possessionOffset;
        const frontError = Math.hypot(ball.x - expectedX, ball.y - expectedY);
        const contactDistance = Math.hypot(ball.x - this._player.x, ball.y - this._player.y);
        const hasContact = dot > Player.BODY_RADIUS
            && contactDistance <= possessionOffset + CONTACT_DISTANCE_MARGIN;
        if ((frontError <= this._catchDistance || hasContact)
            && ballSpeed <= this._maxBallSpeed) {
            this._trap();
            return;
        }

        // 볼이 발 앞을 통과하는 경우에도 측면 오차가 작을 때만 수령한다.
        const lateral = Math.abs(dx * fwd.y - dy * fwd.x);

        if (dot > Player.BODY_RADIUS && dot < possessionOffset + this._pm.speed * this._reactionWindow
            && lateral <= this._catchDistance && ballSpeed <= this._maxBallSpeed) {
            this._trap();
        }
    }

    _trackAerial(dt) {
        const ball = this._bm.ball;
        const remaining = this._bm._aerialDuration - this._bm._aerialTimer;
        if (remaining <= 0) return;

        // 착지 예상 지점 계산
        const landX = ball.x + this._bm._aerialVx * remaining;
        const landY = ball.y + this._bm._aerialVy * remaining;

        const fwd = forwardVector(this._player.angle);
        const possessionOffset = Player.BODY_RADIUS + 8;
        const dx = landX - this._player.x;
        const dy = landY - this._player.y;
        const dot = dx * fwd.x + dy * fwd.y;

        // 착지 지점이 앞쪽이고 트래킹 범위 내이면 미리 이동을 준비한다.
        if (dot > 0 && dot < this._trackDistance * 1.6) {
            this._trackTimer -= dt;
            if (this._trackTimer <= 0) {
                this._trackTimer = 0.08;
                this._tracking = true;
                this._pm.moveTo(
                    landX - fwd.x * possessionOffset,
                    landY - fwd.y * possessionOffset,
                );
            }
        }
    }

    _planAerialReception() {
        if (this._aerialPlanned) return;

        const progress = this._bm._aerialTimer / this._bm._aerialDuration;
        if (progress < 0.45) return;

        const ball = this._bm.ball;
        const remaining = this._bm._aerialDuration - this._bm._aerialTimer;
        const landX = ball.x + this._bm._aerialVx * remaining;
        const landY = ball.y + this._bm._aerialVy * remaining;
        const landingAngle = angleTo(this._player.x, this._player.y, landX, landY);
        const distance = Math.hypot(landX - this._player.x, landY - this._player.y);
        const requiredSpeed = distance / Math.max(remaining, 0.1);
        const minSpeed = PlayerMovement.SPEEDS[2];
        const maxSpeed = PlayerMovement.SPEEDS[4];

        this._aerialPlanned = true;
        this._pm.speed = Math.max(minSpeed, Math.min(maxSpeed, requiredSpeed));
        this._pm.setFacingTarget(landingAngle);

        // 착지점 뒤가 아니라 공의 진행 방향 앞에서 받을 수 있도록 이동한다.
        const fwd = forwardVector(landingAngle);
        this._pm.moveTo(
            landX - fwd.x * (Player.BODY_RADIUS + 8),
            landY - fwd.y * (Player.BODY_RADIUS + 8),
        );
    }

    _trackBounce(dt) {
        const bounce = this._bm._bounce;
        if (!bounce) return;

        const remaining = bounce.duration - bounce.timer;
        const landingX = this._bm.ball.x + bounce.vx * remaining;
        const landingY = this._bm.ball.y + bounce.vy * remaining;
        const fwd = forwardVector(this._player.angle);
        const possessionOffset = Player.BODY_RADIUS + 8;

        this._trackTimer -= dt;
        if (this._trackTimer <= 0) {
            this._trackTimer = 0.08;
            this._tracking = true;
            this._pm.moveTo(
                landingX - fwd.x * possessionOffset,
                landingY - fwd.y * possessionOffset,
            );
        }
    }

    _trap() {
        this._complete = true;
        const desiredAngle = this._pm.getDesiredAngle();
        if (desiredAngle !== null) {
            this._pm.resetTurn(desiredAngle);
            this._pm.setFacingTarget(desiredAngle);
        }
        const offset = Player.BODY_RADIUS + 8;
        this._bm.possess(this._player, offset);
        this._bm.snapToFront();
        this._dribble.start();

        if (this._onReceive) this._onReceive();

        if (this._targetX !== null && this._pm._tx === null) {
            this._pm.moveTo(this._targetX, this._targetY, this._onFinish);
        }
    }
}
