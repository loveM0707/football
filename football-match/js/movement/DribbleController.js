/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 원칙: 볼은 절대 순간이동하지 않는다. 모든 이동은 lerp.
 *
 * 킥 사이클:
 *   WAIT  : 볼이 frontPos에 부드럽게 따라옴 (짧은 대기)
 *   KICK  : 목표가 frontPos+KICK_AHEAD → frontPos로 선형 감소 → 볼이 앞으로 나갔다 돌아오는 효과
 *   TURN  : 방향전환 중. 볼을 빠른 lerp로 앞에 당김. 킥 없음.
 *
 * 루프 호출 순서: PlayerMovement → DribbleController → BallMovement
 */
export class DribbleController {
    static KICK_INTERVAL = 0.14; // 킥 사이 대기 시간 (초) — 짧을수록 더 자주 툭툭 침
    static KICK_AHEAD    = 50;   // 킥 최대 전진 거리 (SVG 단위)
    static KICK_DURATION = 0.42; // 킥 1회 지속 (초) — 볼이 앞에 나가 있는 시간

    static LERP_WAIT = 20; // 대기: 볼이 frontPos에 빠르게 수렴 (lag 최소화)
    static LERP_KICK = 4;  // 킥: 볼이 천천히 목표를 추적 → 자연스러운 굴림 효과
    static LERP_TURN = 14; // 전환: 빠르게 앞으로 당김

    constructor(playerMovement, ballMovement) {
        this.pm = playerMovement;
        this.bm = ballMovement;
        this._active    = false;
        this._kicked    = false;
        this._kickTimer = 0;
        this._waitTimer = 0;
    }

    start() {
        this._active    = true;
        this._kicked    = false;
        this._kickTimer = 0;
        this._waitTimer = 0;
        // snapToFront() 없음 — lerp로 자연스럽게 frontPos로 이동
    }

    stop() {
        this._active = false;
        if (this.bm.owner) this.bm.snapToFront();
    }

    update(dt) {
        if (!this._active || !this.bm.owner) return;

        const turning = this.pm.isTurning();
        const { x: fx, y: fy, fwdX, fwdY } = this.bm.frontPos();

        let targetX, targetY, lerpRate;

        if (turning) {
            // 방향전환: 볼을 선수 앞으로 빠르게 당김, 킥 타이머 리셋
            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_TURN;
            this._kicked    = false;
            this._kickTimer = 0;
            this._waitTimer = 0;

        } else if (this._kicked) {
            // 킥 중: 목표가 KICK_AHEAD에서 0으로 줄어들며 볼이 앞으로 나갔다 돌아옴
            this._kickTimer -= dt;
            const fraction = Math.max(0, this._kickTimer / DribbleController.KICK_DURATION);
            targetX  = fx + fwdX * DribbleController.KICK_AHEAD * fraction;
            targetY  = fy + fwdY * DribbleController.KICK_AHEAD * fraction;
            lerpRate = DribbleController.LERP_KICK;

            if (this._kickTimer <= 0) {
                this._kicked    = false;
                this._waitTimer = 0;
            }

        } else {
            // 대기: frontPos로 빠르게 수렴, 짧은 대기 후 다음 킥
            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_WAIT;
            this._waitTimer += dt;

            if (this._waitTimer >= DribbleController.KICK_INTERVAL) {
                this._kicked    = true;
                this._kickTimer = DribbleController.KICK_DURATION;
                this._waitTimer = 0;
            }
        }

        // 볼을 목표로 부드럽게 이동 (절대 순간이동 없음)
        const t  = Math.min(1, lerpRate * dt);
        const bx = this.bm.ball.x;
        const by = this.bm.ball.y;
        this.bm.ball.setPosition(bx + (targetX - bx) * t, by + (targetY - by) * t);
    }
}
