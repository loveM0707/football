/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 원칙: 볼은 절대 순간이동하지 않는다. 모든 이동은 lerp.
 *
 * 킥 사이클:
 *   WAIT  : 볼이 frontPos에 부드럽게 따라옴 (짧은 대기)
 *   KICK  : 목표가 frontPos+kickAhead → frontPos로 선형 감소 → 볼이 앞으로 나갔다 돌아오는 효과
 *   TURN  : 방향전환 중. 볼을 빠른 lerp로 앞에 당김. 킥 없음.
 *
 * kickAhead 스케일링 (속도 연동):
 *   kickAhead = KICK_AHEAD × (speed / KICK_SPEED_REF)²
 *   speed=50  → ×0.25 ≈ 12  (발에 거의 붙음)
 *   speed=100 → ×1.00 = 50  (기준, 3단계)
 *   speed=150 → ×2.25 ≈ 112 (멀리 떨어짐)
 *
 * 루프 호출 순서: PlayerMovement → DribbleController → BallMovement
 */
export class DribbleController {
    static KICK_INTERVAL   = 0.14; // 킥 사이 대기 시간 (초)
    static KICK_AHEAD      = 50;   // 기준 킥 최대 전진 거리 (3단계 기준, SVG 단위)
    static KICK_SPEED_REF  = 100;  // kickAhead 기준 속도 (PlayerMovement 3단계)
    static KICK_DURATION   = 0.42; // 킥 1회 지속 (초)

    static LERP_WAIT = 20;
    static LERP_KICK = 4;
    static LERP_TURN = 14;

    constructor(playerMovement, ballMovement) {
        this.pm = playerMovement;
        this.bm = ballMovement;
        this._active    = false;
        this._kicked    = false;
        this._kickTimer = 0;
        this._waitTimer = 0;
        this._kickAhead = DribbleController.KICK_AHEAD; // 현재 킥에 적용된 거리
    }

    start() {
        this._active    = true;
        this._kicked    = false;
        this._kickTimer = 0;
        this._waitTimer = 0;
    }

    stop() {
        this._active = false;
        if (this.bm.owner) this.bm.snapToFront();
    }

    /** 현재 선수 속도에 맞는 킥 전진 거리 (2차 스케일) */
    _calcKickAhead() {
        const ratio = this.pm.speed / DribbleController.KICK_SPEED_REF;
        return DribbleController.KICK_AHEAD * ratio * ratio;
    }

    update(dt) {
        if (!this._active || !this.bm.owner) return;

        const turning = this.pm.isTurning();
        const { x: fx, y: fy, fwdX, fwdY } = this.bm.frontPos();

        let targetX, targetY, lerpRate;

        if (turning) {
            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_TURN;
            this._kicked    = false;
            this._kickTimer = 0;
            this._waitTimer = 0;

        } else if (this._kicked) {
            this._kickTimer -= dt;
            const fraction = Math.max(0, this._kickTimer / DribbleController.KICK_DURATION);
            // 킥 시작 시 계산된 _kickAhead 사용 (킥 도중 속도가 바뀌어도 일관성 유지)
            targetX  = fx + fwdX * this._kickAhead * fraction;
            targetY  = fy + fwdY * this._kickAhead * fraction;
            lerpRate = DribbleController.LERP_KICK;

            if (this._kickTimer <= 0) {
                this._kicked    = false;
                this._waitTimer = 0;
            }

        } else {
            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_WAIT;
            this._waitTimer += dt;

            if (this._waitTimer >= DribbleController.KICK_INTERVAL) {
                this._kicked    = true;
                this._kickTimer = DribbleController.KICK_DURATION;
                this._waitTimer = 0;
                // 킥 시작 시점의 속도로 거리 확정
                this._kickAhead = this._calcKickAhead();
            }
        }

        const t  = Math.min(1, lerpRate * dt);
        const bx = this.bm.ball.x;
        const by = this.bm.ball.y;
        this.bm.ball.setPosition(bx + (targetX - bx) * t, by + (targetY - by) * t);
    }
}
