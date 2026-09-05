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
import { FIELD_WIDTH } from './FieldGeometry.js';

const DEFAULT_CATCH_DISTANCE = 8;
const DEFAULT_MAX_BALL_SPEED = 180;
const DEFAULT_REACTION_WINDOW = 0.5;
const DEFAULT_TRACK_DISTANCE = 120;
const CONTACT_DISTANCE_MARGIN = 3;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class BallReception {
    /**
     * @param {Player}         player
     * @param {PlayerMovement} playerMovement
     * @param {BallMovement}   ballMovement
     * @param {object}         [options]
     *   catchDistance   {number}  트랩 판정 거리
     *   maxBallSpeed   {number}  트랩 가능 최대 볼 속도
     *   reactionWindow {number}  반응 시간
     *   trackDistance   {number}  추적 전환 거리
     *   trackReceiver   {boolean} 수신자 자동 추적
     *   touchQuality   {number}  퍼스트 터치 품질 (0~1, 1이면 완벽)
     *     낮을수록 트랩 후 볼이 더 멀리 튀고 안정화 시간이 길다.
     */
    constructor(player, playerMovement, ballMovement, options = {}) {
        this._player = player;
        this._pm = playerMovement;
        this._bm = ballMovement;
        this._catchDistance = options.catchDistance ?? DEFAULT_CATCH_DISTANCE;
        this._maxBallSpeed = options.maxBallSpeed ?? DEFAULT_MAX_BALL_SPEED;
        this._reactionWindow = options.reactionWindow ?? DEFAULT_REACTION_WINDOW;
        this._trackDistance = options.trackDistance ?? DEFAULT_TRACK_DISTANCE;
        this._trackReceiver = options.trackReceiver ?? true;
        // 퍼스트 터치 품질: 0(형편없음) ~ 1(완벽). 기본 0.8
        this._touchQuality = clamp(options.touchQuality ?? 0.8, 0, 1);

        this._dribble = new DribbleController(this._pm, this._bm);
        this._active = false;
        this._complete = false;
        this._onReceive = null;
        this._targetX = null;
        this._targetY = null;
        this._onFinish = null;
        this._trackTimer = 0;
        this._tracking = false;
        this._runTargetX = null;
        this._runTargetY = null;
    }

    /** 퍼스트 터치 품질을 동적으로 변경한다 */
    setTouchQuality(q) { this._touchQuality = clamp(q, 0, 1); }

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

    /**
     * 볼이 목표점을 향해 가고 있는지 판정한다 (패스 의도 유효 여부).
     * horizon(초) 뒤 예측 위치가 목표점에 더 가까워지면 true.
     * 목표 근접(30 이내)은 도착권으로 보고 유효로 본다.
     * 마찰을 무시한 선형 예측이라 도착 시점은 과대평가되지만,
     * "어느 방향으로 가는가" 판정에는 충분하다.
     */
    static headingToTarget(bm, tx, ty, horizon = 0.45, margin = 8) {
        const tDist = Math.hypot(tx - bm.ball.x, ty - bm.ball.y);
        if (tDist <= 30) return true;
        const px = bm.ball.x + bm.vx * horizon;
        const py = bm.ball.y + bm.vy * horizon;
        return Math.hypot(tx - px, ty - py) <= tDist + margin;
    }

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
            const ballSpeed = Math.hypot(this._bm.vx, this._bm.vy);
            // 런 무효 1: 패스가 죽었는데(저속) 옛 목표를 향해 뛰면 볼을 놓고 혼자 가는 꼴이 된다.
            // 런 무효 2: 볼이 목표점을 향해 가지 않으면(차단·굴절·옆으로 샘) 목표 자체가 무효 —
            // 수신자와 볼 사이 거리와 무관하게 런을 접고 실제 볼 추적으로 넘긴다.
            // 근거리 굴절도 예외가 없다 — 스루패스 실패 시 빈 공간으로 질주하던 버그의 직접 원인.
            const deadPass = ballSpeed < 80;
            const leavingTarget = !BallReception.headingToTarget(this._bm, this._runTargetX, this._runTargetY);
            if (deadPass || leavingTarget) {
                this._runTargetX = null;
                this._runTargetY = null;
            } else if (distToBall > this._trackDistance) {
                this._pm.speed = PlayerMovement.SPEEDS[4];
                this._pm.moveTo(this._runTargetX, this._runTargetY);
                return;
            } else {
                // 볼이 가까워지면 침투 런 종료 — 이후 추적·트래핑은 기존 로직이 처리
                this._runTargetX = null;
                this._runTargetY = null;
            }
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
            // 모듈 개선 2차: 예측 시간을 수신자 속도 기준 상향(clamp 0.5→0.65)하고
            // 볼이 유출되는 꼬리 구간에서도 계속 전력 추격 — 회수 실패 잔여 케이스 제거.
            this._trackTimer -= dt;
            if (this._trackTimer <= 0) {
                this._trackTimer = 0.07;
                this._tracking = true;
                // 선형 인터셉트: 볼 속도와 거리로 만남 시점을 예측해 그 지점으로 질주
                const spd = Math.max(ballSpeed, 1);
                const mySpd = Math.max(this._pm.speed || PlayerMovement.SPEEDS[3], PlayerMovement.SPEEDS[3]);
                const t = Math.min(contactDistance / Math.max(spd * 0.9, mySpd), 0.65);
                const ix = clamp(ball.x + this._bm.vx * t, 0, FIELD_WIDTH);
                const iy = clamp(ball.y + this._bm.vy * t, 30, 650);
                const interceptAngle = angleTo(this._player.x, this._player.y, ix, iy);
                this._pm.setFacingTarget(interceptAngle);
                // 볼이 앞서 도망 중이면 스프린트, 만남 직전이면 컨트롤 속도로 정확 접근
                const closing = (this._bm.vx * (ix - this._player.x) + this._bm.vy * (iy - this._player.y)) > 0;
                this._pm.speed = closing ? PlayerMovement.SPEEDS[4] : PlayerMovement.SPEEDS[3];
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

        // 퍼스트 터치 품질 적용 — 낮을수록 볼이 더 멀리 튀고 유예 시간이 길다
        const tq = this._touchQuality;
        if (tq < 0.95) {
            // 불완전한 터치: 볼을 약간 어긋난 위치로 이동
            const missAngle = (Math.random() - 0.5) * (1 - tq) * 30; // 최대 15도 편차
            const missDist  = (1 - tq) * 12; // 최대 12 SVG 편차
            const missRad   = (desiredAngle + missAngle) * Math.PI / 180;
            this._bm.ball.setPosition(
                this._bm.ball.x + (-Math.sin(missRad)) * missDist,
                this._bm.ball.y + Math.cos(missRad) * missDist,
            );
        }

        this._dribble.start();

        if (this._onReceive) this._onReceive();

        if (this._targetX !== null && this._pm._tx === null) {
            this._pm.moveTo(this._targetX, this._targetY, this._onFinish);
        } else if (!this._pm.moving) {
            const fwd = forwardVector(desiredAngle);
            // 터치 품질이 낮으면 초기 전진 속도도 낮다 (볼 안정화 필요)
            const postSpeed = tq > 0.7 ? PlayerMovement.SPEEDS[3]
                            : tq > 0.4 ? PlayerMovement.SPEEDS[2]
                            : PlayerMovement.SPEEDS[1];
            this._pm.speed = postSpeed;
            this._pm.moveTo(
                this._player.x + fwd.x * 70,
                this._player.y + fwd.y * 70,
            );
        }
    }
}
