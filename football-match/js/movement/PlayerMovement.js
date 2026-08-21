/**
 * PlayerMovement - 선수 이동·회전 모듈
 *
 * 좌표 규약 (SVG rotate 기준):
 *   angle=0   → 발이 화면 아래(남), 앞방향 벡터 (0, +1)
 *   angle=90  → 발이 화면 오른쪽(동), 앞방향 벡터 (+1, 0)
 *   angle=180 → 발이 화면 위(북), 앞방향 벡터 (0, -1)
 *   angle=-90 → 발이 화면 왼쪽(서), 앞방향 벡터 (-1, 0)
 *
 * 이동 중 회전이 먼저 완료된 후 전진한다.
 * isTurning() 이 true인 동안 DribbleController는 볼을 선수에 붙인다.
 * 방향전환은 AngleInertia 공통 모듈(관성/원심력)로 부드럽게 처리 — 메뉴/실경기 공통.
 */
import { stepAngle, PM_STIFFNESS, PM_DAMPING, PM_MAX_VEL, PM_DRIFT_SCALE } from './AngleInertia.js';
export class PlayerMovement {
    /**
     * 스피드 5단계 (SVG 단위/초, 10 SVG = 1m)
     *   1단계(느림) ~ 5단계(스프린트)
     */
    static SPEEDS = [50, 75, 100, 125, 150]; // 1~5단계 (SVG 단위/초, 10 SVG = 1m)
    static SPEED          = 100;  // 기본값 (3단계)
    static ROT_SPEED      = 360;  // 호환용 — 실제 상한은 AngleInertia.PM_MAX_VEL
    static ARRIVAL_RADIUS = 4;    // 도착 판정 반경
    static TURN_THRESHOLD = 12;   // 드리블 TURN 판정 완화(기존 6→12) — 관성 적용 시 미세 회전으로 볼이 발에 붙는 현상 방지

    constructor(player) {
        this.player = player;
        this.speed  = PlayerMovement.SPEED; // 인스턴스별 스피드 (외부에서 변경 가능)
        this._tx = null;   // 목표 x
        this._ty = null;   // 목표 y
        this._onArrive = null;
        this._active = false;
        this._angVel = 0;  // 각속도 (도/초) — 관성
    }

    /**
     * 목표 위치로 이동을 시작한다.
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

    /** 현재 목표 방향으로 회전 중이면 true — 관성 시 각속도도 고려해 빠른 회전은 즉시 TURN */
    isTurning() {
        if (!this._active || this._tx === null) return false;
        const dx = this._tx - this.player.x;
        const dy = this._ty - this.player.y;
        if (Math.hypot(dx, dy) < PlayerMovement.ARRIVAL_RADIUS) return false;
        const target = _angleFromDir(dx, dy);
        const diff = Math.abs(_angleDiff(target, this.player.angle));
        if (diff > PlayerMovement.TURN_THRESHOLD) return true;
        // 관성으로 인한 빠른 회전 중에도 즉시 TURN — 볼이 뒤처지는 것을 방지
        if (Math.abs(this._angVel) > 50) return true;
        return false;
    }

    /** 매 프레임 호출 */
    update(dt) {
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

        // 목표 방향각 — AngleInertia 공통 모듈로 관성 회전
        const targetAngle = _angleFromDir(dx, dy);
        const res = stepAngle(this.player.angle, targetAngle, this._angVel, dt, {
            stiffness: PM_STIFFNESS, damping: PM_DAMPING, maxVel: PM_MAX_VEL,
        });
        this._angVel = res.vel;
        if (Math.abs(res.rot) > 0.01) this.player.setAngle(this.player.angle + res.rot);

        // 원심력 — AngleInertia 모듈과 동일한 물리, 속도 비례 가중
        const driftMag = Math.abs(this._angVel) * this.speed * PM_DRIFT_SCALE;
        let driftX = 0, driftY = 0;
        if (driftMag > 0.1 && Math.abs(this._angVel) > 20) {
            const rad = this.player.angle * Math.PI / 180;
            const rightX = Math.cos(rad);
            const rightY = Math.sin(rad);
            const side = this._angVel > 0 ? -1 : 1;
            driftX = rightX * side * driftMag * dt;
            driftY = rightY * side * driftMag * dt;
        }

        // 회전이 어느 정도 완료된 후에만 전진 — 드리블 시 볼이 뒤처지지 않도록
        // 원심 드리프트는 전진 중에만 적용, 제자리 회전 드리프트 제거 (드리블 TURN 중 볼 뒤처짐 원인)
        const curDiff = _angleDiff(targetAngle, this.player.angle);
        if (Math.abs(curDiff) < 30) {
            const step = Math.min(this.speed * dt, dist);
            this.player.setPosition(
                this.player.x + (dx / dist) * step + driftX,
                this.player.y + (dy / dist) * step + driftY
            );
        }
    }
}

/** 방향 벡터 (dx, dy) → SVG rotate 각도 */
function _angleFromDir(dx, dy) {
    return Math.atan2(-dx, dy) * 180 / Math.PI;
}

/** 두 각도의 최단 차이 (-180 ~ +180) */
function _angleDiff(target, current) {
    return (((target - current) % 360) + 540) % 360 - 180;
}
