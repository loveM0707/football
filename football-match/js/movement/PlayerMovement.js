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
 */
export class PlayerMovement {
    static SPEED          = 130;  // 이동 속도 (SVG 단위/초, ≈13m/s)
    static ROT_SPEED      = 460;  // 회전 속도 (도/초)
    static ARRIVAL_RADIUS = 4;    // 도착 판정 반경
    static TURN_THRESHOLD = 6;    // 이 각도 이하면 회전 완료로 판정 (도)

    constructor(player) {
        this.player = player;
        this._tx = null;   // 목표 x
        this._ty = null;   // 목표 y
        this._onArrive = null;
        this._active = false;
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

    /** 현재 목표 방향으로 회전 중이면 true */
    isTurning() {
        if (!this._active || this._tx === null) return false;
        const dx = this._tx - this.player.x;
        const dy = this._ty - this.player.y;
        if (Math.hypot(dx, dy) < PlayerMovement.ARRIVAL_RADIUS) return false;
        const target = _angleFromDir(dx, dy);
        return Math.abs(_angleDiff(target, this.player.angle)) > PlayerMovement.TURN_THRESHOLD;
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

        // 목표 방향각
        const targetAngle = _angleFromDir(dx, dy);
        const diff = _angleDiff(targetAngle, this.player.angle);

        // 회전
        const maxRot = PlayerMovement.ROT_SPEED * dt;
        const rot = Math.sign(diff) * Math.min(Math.abs(diff), maxRot);
        this.player.setAngle(this.player.angle + rot);

        // 회전이 어느 정도 완료된 후에만 전진
        if (Math.abs(diff) < 30) {
            const step = Math.min(PlayerMovement.SPEED * dt, dist);
            this.player.setPosition(
                this.player.x + (dx / dist) * step,
                this.player.y + (dy / dist) * step
            );
        }
    }
}

/** 방향 벡터 (dx, dy) → SVG rotate 각도 */
function _angleFromDir(dx, dy) {
    return Math.atan2(dx, dy) * 180 / Math.PI;
}

/** 두 각도의 최단 차이 (-180 ~ +180) */
function _angleDiff(target, current) {
    return (((target - current) % 360) + 540) % 360 - 180;
}
