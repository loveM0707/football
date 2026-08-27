/**
 * BallReception - 볼 트래핑·수령 모듈
 *
 * 공이 선수 앞에 접근하거나 지나칠 때, 적절한 거리와 속도 조건을
 * 만족하면 볼을 소유하고 드리블로 전환한다. 로빙 패스 착지·바운드,
 * 지상 패스 등 다양한 상황에서 재사용할 수 있다.
 *
 * 침투 런 지원:
 *   start({ runTargetX, runTargetY })로 목표를 전달하면,
 *   모듈이 자동으로 목표를 향해 달리다가 볼이 가까워지면 추적 모드로 전환한다.
 *   시나리오에서 수동으로 moveTo()를 호출할 필요가 없다.
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

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
        // 침투 런: start({ runTargetX, runTargetY })로 설정되면 목표를 향해 달린다
        this._runTargetX = null;
        this._runTargetY = null;
    }

    start(options = {}) {
        this._active = true;
        this._complete = false;
        this._onReceive = options.onReceive ?? null;
        this._targetX = options.targetX ?? null;
        this._targetY = options.targetY ?? null;
        this._onFinish = options.onFinish ?? null;
        this._runTargetX = options.runTargetX ?? null;
        this._runTargetY = options.runTargetY ?? null;
        // 수령 직후 바라볼 방향. 미지정 시 착지점 방향(getDesiredAngle)을 따른다.
        this._receiveAngle = options.receiveAngle ?? null;
        this._trackTimer = 0;
        this._tracking = false;
    }

    stop() {
        this._active = false;
        this._dribble.stop();
        this._runTargetX = null;
        this._runTargetY = null;
        this._receiveAngle = null;
    }

    get received() { return this._complete; }

    update(dt) {
        if (!this._active) return;
        if (this._complete) {
            this._dribble.update(dt);
            return;
        }

        const ball = this._bm.ball;

        // 침투 런: 목표가 설정되어 있고 볼이 먼 거리에 있으면 목표를 향해 이동
        // 볼이 가까워지면 추적 모드로 전환하여 기존 트래핑 로직에 위임한다.
        if (this._runTargetX !== null && !this._bm.isAerial && !this._bm.isBouncing) {
            const distToBall = Math.hypot(ball.x - this._player.x, ball.y - this._player.y);
            if (distToBall > this._trackDistance) {
                this._pm.speed = PlayerMovement.SPEEDS[4];
                this._pm.moveTo(this._runTargetX, this._runTargetY);
                return;
            }
            // 볼이 가까워지면 침투 런 종료 — 이후 추적·트래핑은 기존 로직이 처리
            this._runTargetX = null;
            this._runTargetY = null;
        }

        // 공중 비행 중: 매 프레임 착지점을 예측해 수신자를 이동시킨다.
        if (this._bm.isAerial) {
            this._trackAerial(dt);
            return;
        }

        // 바운드 중: 착지 예상 지점 추적 + 접촉 거리면 즉시 수령
        if (this._bm.isBouncing) {
            this._trackBounce(dt);
            const bounce = this._bm._bounce;
            if (bounce) {
                const dx = ball.x - this._player.x;
                const dy = ball.y - this._player.y;
                const fwd = forwardVector(this._player.angle);
                const dot = dx * fwd.x + dy * fwd.y;
                const contactDist = Math.hypot(dx, dy);
                const bSpd = Math.hypot(bounce.vx, bounce.vy);
                if (dot >= 0 && contactDist <= Player.BODY_RADIUS + this._catchDistance
                    && bSpd <= this._maxBallSpeed) {
                    this._trap();
                    return;
                }
            }
            return;
        }

        // 지면에 남은 공의 속도
        const ballSpeed = Math.hypot(this._bm.vx, this._bm.vy);

        const fwd = forwardVector(this._player.angle);
        const possessionOffset = Player.BODY_RADIUS + 8;
        const dx = ball.x - this._player.x;
        const dy = ball.y - this._player.y;
        const dot = dx * fwd.x + dy * fwd.y;
        const contactDistance = Math.hypot(dx, dy);
        // 방향 무관 컨트롤 반경 — 이보다 가까우면 몸 어떤 부위로도 컨트롤 가능
        const controlRadius = Player.BODY_RADIUS + this._catchDistance + 6;

        // 착지 후 공이 정면으로 굴러오면 기존처럼 접점까지 짧게 보정한다.
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
        } else if (contactDistance > controlRadius) {
            // 모듈 개선: 뒤/측면에서 오는 패스도 멈추지 않게 볼 경로를 직접 추적한다.
            // 이전 로직은 dot>0(정면)일 때만 움직여, 패스가 러너 뒤에서 오면 정지했다.
            this._trackTimer -= dt;
            if (this._trackTimer <= 0) {
                this._trackTimer = 0.08;
                this._tracking = true;
                // 선형 인터셉트: 볼 속도와 거리로 만남 시점을 예측해 그 지점으로 질주
                const spd = Math.max(ballSpeed, 1);
                const t = Math.min(contactDistance / spd, 0.5);
                const ix = clamp(ball.x + this._bm.vx * t, 0, 1050);
                const iy = clamp(ball.y + this._bm.vy * t, 30, 650);
                const interceptAngle = angleTo(this._player.x, this._player.y, ix, iy);
                this._pm.setFacingTarget(interceptAngle);
                this._pm.speed = PlayerMovement.SPEEDS[4];
                this._pm.moveTo(ix, iy);
            }
        }

        // 트랩 판정 — 모듈 개선: 방향 무관. 컨트롤 반경 진입 + 볼 속도 조건이면 수령.
        // (이전에는 정면 접점/측면 통과 조건이라 뒤쪽 패스를 영영 못 받았다.)
        if (contactDistance <= controlRadius && ballSpeed <= this._maxBallSpeed) {
            this._trap();
        }
    }

    _trackAerial(dt) {
        const ball = this._bm.ball;
        const remaining = this._bm._aerialDuration - this._bm._aerialTimer;
        if (remaining <= 0.05) return;

        // 현재 공 위치에서 남은 비행 시간 동안 이동할 착지 예상 지점
        const landX = ball.x + this._bm._aerialVx * remaining;
        const landY = ball.y + this._bm._aerialVy * remaining;
        const distance = Math.hypot(landX - this._player.x, landY - this._player.y);
        if (distance < 1) return;

        // 착지점까지 도달하는 데 필요한 속도로 조정
        const requiredSpeed = distance / Math.max(remaining, 0.05);
        this._pm.speed = Math.max(PlayerMovement.SPEEDS[1], Math.min(PlayerMovement.SPEEDS[4], requiredSpeed));

        // 착지 방향으로 몸 방향 설정
        const landingAngle = angleTo(this._player.x, this._player.y, landX, landY);
        this._pm.setFacingTarget(landingAngle);

        const fwd = forwardVector(landingAngle);
        const possessionOffset = Player.BODY_RADIUS + 8;

        this._trackTimer -= dt;
        if (this._trackTimer <= 0) {
            this._trackTimer = 0.06;
            this._tracking = true;
            // 착지점 직전에서 볼을 받을 수 있도록 착지점의 약간 뒤로 이동
            this._pm.moveTo(
                landX - fwd.x * possessionOffset,
                landY - fwd.y * possessionOffset,
            );
        }
    }

    _trackBounce(dt) {
        const bounce = this._bm._bounce;
        if (!bounce) return;

        const remaining = bounce.duration - bounce.timer;
        const landingX = this._bm.ball.x + bounce.vx * remaining;
        const landingY = this._bm.ball.y + bounce.vy * remaining;

        const landingAngle = angleTo(this._player.x, this._player.y, landingX, landingY);
        const fwd = forwardVector(landingAngle);
        const possessionOffset = Player.BODY_RADIUS + 8;

        this._trackTimer -= dt;
        if (this._trackTimer <= 0) {
            this._trackTimer = 0.08;
            this._tracking = true;
            this._pm.setFacingTarget(landingAngle);
            this._pm.moveTo(
                landingX - fwd.x * possessionOffset,
                landingY - fwd.y * possessionOffset,
            );
        }
    }

    _trap() {
        this._complete = true;

        const desiredAngle = this._receiveAngle ?? this._pm.getDesiredAngle() ?? this._player.angle;
        this._pm.resetTurn(desiredAngle);
        this._pm.setFacingTarget(desiredAngle);
        const offset = Player.BODY_RADIUS + 8;
        this._bm.possess(this._player, offset);
        this._bm.snapToFront();
        this._dribble.start();

        if (this._onReceive) this._onReceive();

        if (this._targetX !== null && this._pm._tx === null) {
            this._pm.moveTo(this._targetX, this._targetY, this._onFinish);
        } else if (!this._pm.moving) {
            // 모듈 개선: 수령 직후 정지하지 않고 전방으로 자연스럽게 이어가기
            // 다른 메뉴(헤딩, 크로스 등)에서도 공통 적용되어 끊김 방지
            const fwd = forwardVector(desiredAngle);
            this._pm.speed = PlayerMovement.SPEEDS[3];
            this._pm.moveTo(
                this._player.x + fwd.x * 70,
                this._player.y + fwd.y * 70,
            );
        }
    }
}
