/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 설계 원칙: 볼은 절대 순간이동하지 않는다.
 * 모든 위치 변화는 lerp로 처리해 자연스러운 굴러가는 느낌을 만든다.
 *
 * 3가지 상태:
 *   WAIT  : 볼이 선수 앞에 붙어서 같이 이동. 다음 킥 타이머 대기.
 *   KICK  : 볼 목표 위치가 KICK_AHEAD → 0으로 줄어들며 앞으로 나갔다가 돌아오는 효과.
 *   TURN  : 방향 전환 중. 빠른 lerp로 볼을 앞에 모음. 킥 없음.
 *
 * 게임 루프 호출 순서:
 *   1. PlayerMovement.update(dt)
 *   2. DribbleController.update(dt)
 *   3. BallMovement.update(dt)   ← 소유 중 skip
 */
export class DribbleController {
    // 직진 드리블 파라미터
    static KICK_INTERVAL = 0.38; // 킥 사이 대기 시간 (초)
    static KICK_AHEAD    = 44;   // 킥 시 볼이 앞으로 나가는 최대 거리 (SVG 단위)
    static KICK_DURATION = 0.34; // 킥 1회 지속 시간 (초)

    // lerp 계수 — 클수록 목표에 빠르게 도달
    static LERP_WAIT = 16; // 대기: 볼이 앞에 밀착 (약간의 자연스러운 지연 유지)
    static LERP_KICK = 5;  // 킥: 볼이 천천히 앞으로 나갔다가 돌아옴
    static LERP_TURN = 14; // 전환: 볼을 빠르게 앞으로 끌어당김

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
        // 최초 소유 시에만 한 번 스냅 (볼이 멀리 있을 경우 대비)
        this.bm.snapToFront();
    }

    stop() {
        this._active = false;
        if (this.bm.owner) this.bm.snapToFront();
    }

    /** 매 프레임 호출 */
    update(dt) {
        if (!this._active || !this.bm.owner) return;

        const turning = this.pm.isTurning();
        const { x: fx, y: fy, fwdX, fwdY } = this.bm.frontPos();

        let targetX, targetY, lerpRate;

        if (turning) {
            // 방향 전환: 볼을 선수 앞으로 빠르게 당김, 킥 없음
            targetX  = fx;
            targetY  = fy;
            lerpRate = DribbleController.LERP_TURN;
            this._kicked    = false;
            this._kickTimer = 0;
            this._waitTimer = 0;

        } else if (this._kicked) {
            // 킥 중: 목표가 KICK_AHEAD에서 0으로 감소 → 볼이 앞으로 나갔다가 돌아오는 효과
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
            // 대기: 볼이 선수 앞에 붙어 이동, 다음 킥 타이머 증가
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

        // 볼을 목표 위치로 부드럽게 이동 (절대 순간이동 없음)
        const t  = Math.min(1, lerpRate * dt);
        const bx = this.bm.ball.x;
        const by = this.bm.ball.y;
        this.bm.ball.setPosition(bx + (targetX - bx) * t, by + (targetY - by) * t);
    }
}
