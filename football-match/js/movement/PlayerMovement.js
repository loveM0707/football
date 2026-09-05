/**
 * PlayerMovement - 선수 이동·회전 모듈
 *
 * 좌표 규약 (SVG rotate 기준):
 *   angle=0   → 발이 화면 아래(남), 앞방향 벡터 (0, +1)
 *   angle=90  → 발이 화면 오른쪽(동), 앞방향 벡터 (+1, 0)
 *   angle=180 → 발이 화면 위(북), 앞방향 벡터 (0, -1)
 *   angle=-90 → 발이 화면 왼쪽(서), 앞방향 벡터 (-1, 0)
 *
 * 책임:
 *   - 선수의 위치 이동(가속/감속/도착)을 유일하게 담당
 *   - 선수의 방향전환 물리(스프링-댐퍼 관성)를 유일하게 담당
 *   - 시나리오는 "어디를 볼지"만 setFacingTarget(angle)으로 요청
 *   - "얼마나 빨리 회전할지"는 PlayerMovement가 결정
 *
 * DribbleController는 pm.isTurning() 결과에 따라 볼을 제어한다.
 */
import { angleTo, angleDiff, rightVector } from './Direction.js';
import { stepAngle, PM_STIFFNESS, PM_DAMPING, PM_MAX_VEL, PM_DRIFT_SCALE } from './AngleInertia.js';
import { SpeedController } from './SpeedController.js';

export class PlayerMovement {
    /**
     * 스피드 5단계 (SVG 단위/초, 10 SVG = 1m)
     *   1단계(느림) ~ 5단계(스프린트)
     */
    static SPEEDS = [50, 75, 100, 125, 150];
    static SPEED          = 100;  // 기본값 (3단계)
    static ROT_SPEED      = 360;  // 하위 호환용
    static ARRIVAL_RADIUS = 4;    // 도착 판정 반경
    static TURN_THRESHOLD = 12;   // 드리블 TURN 판정 완화

    /**
     * @param {Player} player
     * @param {object} [options]
     *   speed            {number}  초기 속도
     *   stiffness        {number}  회전 스프링 상수
     *   damping          {number}  회전 댐핑 상수
     *   maxVel           {number}  최대 각속도 (도/초)
     *   driftScale       {number}  원심 드리프트 배율
     *   turnBeforeMove   {boolean} 이동 목표 방향으로 정렬 후 전진 (기본 true)
     *   speedTurnFactor  {boolean} 속도에 따른 회전율 감소 (기본 true)
     *   smoothAccel      {boolean} 가감속 커브 사용 (기본 true)
     */
    constructor(player, options = {}) {
        this.player = player;

        this._tx = null;   // 이동 목표 x
        this._ty = null;   // 이동 목표 y
        this._onArrive = null;
        this._active = false;

        this._angVel = 0;  // 각속도 (도/초)
        this._facingTarget = null; // 시나리오가 요청한 바라볼 방향

        this._stiffness       = options.stiffness       ?? PM_STIFFNESS;
        this._damping         = options.damping         ?? PM_DAMPING;
        this._maxVel          = options.maxVel          ?? PM_MAX_VEL;
        this._driftScale      = options.driftScale      ?? PM_DRIFT_SCALE;
        this._turnBeforeMove  = options.turnBeforeMove  ?? true;
        this._speedTurnFactor = options.speedTurnFactor ?? true;

        // 가감속 커브 — 목표 속도와 실제 속도 사이를 부드럽게 전환
        const initSpeed = options.speed ?? PlayerMovement.SPEED;
        this._smoothAccel = options.smoothAccel ?? true;
        this._speedCtrl = new SpeedController({ initialSpeed: initSpeed });
    }

    /** 목표 속도 (set: 목표 설정, get: 실제 현재 속도 반환) */
    get speed() { return this._speedCtrl.current; }
    set speed(v) { this._speedCtrl.setTarget(v); }

    /** 목표 속도 조회 */
    get targetSpeed() { return this._speedCtrl.target; }

    /** 가감속 없이 즉시 속도 설정 */
    setSpeedInstant(v) { this._speedCtrl.setInstant(v); }

    /** 가속/감속 중인지 */
    get speedTransitioning() { return this._speedCtrl.transitioning; }

    /**
     * 이동 목표를 설정한다.
     * @param {number} x
     * @param {number} y
     * @param {function} [onArrive] 도착 시 콜백
     */
    moveTo(x, y, onArrive = null) {
        this._tx = x;
        this._ty = y;
        this._onArrive = onArrive;
        this._active = true;
    }

    stop() {
        this._active = false;
        this._tx = null;
        this._ty = null;
        this._onArrive = null;
    }

    /**
     * 시나리오가 원하는 바라볼 방향을 설정한다.
     * 설정하면 이동 목표 방향 대신 이 각도를 향해 회전한다.
     * @param {number} angleDeg
     */
    setFacingTarget(angleDeg) {
        this._facingTarget = angleDeg;
    }

    /**
     * 원하는 방향 설정을 해제한다.
     * 이후 이동 목표 방향을 따라 회전한다.
     */
    clearFacingTarget() {
        this._facingTarget = null;
    }

    /** 이동 목표가 설정되어 실제 이동 중인지 여부 */
    get moving() {
        return this._active && this._tx !== null;
    }

    /** 회전 관성을 초기화한다. 수령 직후 드리블 방향을 안정화할 때 사용한다. */
    resetTurn(angle = null) {
        this._angVel = 0;
        if (angle !== null) this.player.setAngle(angle);
    }

    /** 현재 설정된 원하는 방향을 반환한다. */
    getDesiredAngle() {
        return this._facingTarget;
    }

    /**
     * 회전 중이면 true.
     * 이동 목표 또는 facing target과 현재 각도 차이가 임계값을 넘거나,
     * 각속도가 충분히 크면 true.
     */
    isTurning() {
        const target = this._resolveTargetAngle();
        if (target === null) return false;

        const diff = Math.abs(angleDiff(target, this.player.angle));
        if (diff > PlayerMovement.TURN_THRESHOLD) return true;
        // 관성으로 인한 빠른 회전 중에도 즉시 TURN — 볼이 뒤처지는 것을 방지
        if (Math.abs(this._angVel) > 50) return true;
        return false;
    }

    /** 매 프레임 호출 */
    update(dt) {
        // 0. 가감속 커브 적용 — 목표 속도를 향해 서서히 전환
        if (this._smoothAccel) {
            this._speedCtrl.update(dt);
        }

        // 1. 회전 목표 결정
        const targetAngle = this._resolveTargetAngle();

        // 2. 회전 물리 업데이트
        const curSpeed = this._speedCtrl.current;
        if (targetAngle !== null) {
            let maxVel = this._maxVel;

            // 속도에 따른 회전율 감소 (서서히 선회)
            if (this._speedTurnFactor) {
                const speedRatio = Math.min(1, Math.max(0, curSpeed / PlayerMovement.SPEEDS[4]));
                maxVel *= (1 - speedRatio * 0.3);
            }

            const res = stepAngle(this.player.angle, targetAngle, this._angVel, dt, {
                stiffness: this._stiffness,
                damping: this._damping,
                maxVel: maxVel,
            });
            this._angVel = res.vel;
            if (Math.abs(res.rot) > 0.01) {
                this.player.setAngle(this.player.angle + res.rot);
            }
        }

        // 3. 이동 처리
        if (!this._active || this._tx === null) return;

        const dx = this._tx - this.player.x;
        const dy = this._ty - this.player.y;
        const dist = Math.hypot(dx, dy);

        // 도착
        if (dist < PlayerMovement.ARRIVAL_RADIUS) {
            this.player.setPosition(this._tx, this._ty);
            this._active = false;
            const cb = this._onArrive;
            this._onArrive = null;
            if (cb) cb();
            return;
        }

        // 이동 방향과 현재 방향의 차이
        const moveAngle = angleTo(this.player.x, this.player.y, this._tx, this._ty);
        const curDiff = angleDiff(moveAngle, this.player.angle);

        // 원심 드리프트
        const driftMag = Math.abs(this._angVel) * curSpeed * this._driftScale;
        let driftX = 0, driftY = 0;
        if (driftMag > 0.1 && Math.abs(this._angVel) > 20) {
            const { x: rightX, y: rightY } = rightVector(this.player.angle);
            const side = this._angVel > 0 ? -1 : 1;
            driftX = rightX * side * driftMag * dt;
            driftY = rightY * side * driftMag * dt;
        }

        // 관성 모델: turnBeforeMove=true 시 정면 정렬도에 비례한 속도로 이동
        let effectiveSpeed = curSpeed;
        if (this._turnBeforeMove) {
            const align = Math.cos(curDiff * Math.PI / 180);
            effectiveSpeed *= Math.max(0.32, align);
        }
        const step = Math.min(effectiveSpeed * dt, dist);
        if (step > 0.01) {
            this.player.setPosition(
                this.player.x + (dx / dist) * step + driftX,
                this.player.y + (dy / dist) * step + driftY
            );
        }
    }

    /** 회전 목표 각도를 해결한다: facing target 우선, 없으면 이동 목표 방향 */
    _resolveTargetAngle() {
        if (this._facingTarget !== null) return this._facingTarget;
        if (!this._active || this._tx === null) return null;
        if (Math.hypot(this._tx - this.player.x, this._ty - this.player.y) < PlayerMovement.ARRIVAL_RADIUS) {
            return null;
        }
        return angleTo(this.player.x, this.player.y, this._tx, this._ty);
    }
}
