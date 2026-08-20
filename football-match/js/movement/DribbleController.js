/**
 * DribbleController - 드리블 킥 리듬 모듈
 *
 * 동작:
 *   - 직진 중: 주기(KICK_INTERVAL)마다 볼을 앞으로 툭 차낸다.
 *             차낸 볼은 서서히 다시 선수 앞으로 돌아온다.
 *   - 방향 전환 중(pm.isTurning() === true): 볼을 선수 앞에 붙인 채 같이 회전.
 *             킥은 발생하지 않는다.
 *
 * 게임 루프 호출 순서:
 *   1. PlayerMovement.update(dt)
 *   2. DribbleController.update(dt)   ← 볼 위치 설정
 *   3. BallMovement.update(dt)        ← 소유 중이면 skip
 */
export class DribbleController {
    static KICK_INTERVAL  = 0.40; // 킥 주기 (초)
    static KICK_AHEAD     = 38;   // 킥 시 볼이 앞으로 나가는 거리 (SVG 단위)
    static KICK_DURATION  = 0.28; // 볼이 앞에 나가 있는 시간 (초)
    static RETURN_SPEED   = 7;    // 볼이 돌아오는 속도 (lerp 계수/초)

    constructor(playerMovement, ballMovement) {
        this.pm = playerMovement;
        this.bm = ballMovement;
        this._active = false;
        this._waitTimer  = 0;  // 다음 킥까지 대기
        this._kickTimer  = 0;  // 킥 후 복귀 대기
        this._kicked     = false;
    }

    start() {
        this._active   = true;
        this._waitTimer = 0;
        this._kickTimer = 0;
        this._kicked    = false;
        this.bm.snapToFront();
    }

    stop() {
        this._active = false;
        if (this.bm.owner) this.bm.snapToFront();
    }

    /** 매 프레임 호출 */
    update(dt) {
        if (!this._active || !this.bm.owner) return;

        // 방향 전환 중: 볼을 앞에 붙인 채 같이 회전, 킥 타이머 리셋
        if (this.pm.isTurning()) {
            this._kicked    = false;
            this._waitTimer = 0;
            this._kickTimer = 0;
            this.bm.snapToFront();
            return;
        }

        if (this._kicked) {
            // 볼이 앞에 나간 상태 → 선수 앞으로 부드럽게 복귀
            this._kickTimer -= dt;
            const { x: fx, y: fy } = this.bm.frontPos();
            const bx = this.bm.ball.x;
            const by = this.bm.ball.y;
            const t  = Math.min(1, DribbleController.RETURN_SPEED * dt);
            this.bm.ball.setPosition(bx + (fx - bx) * t, by + (fy - by) * t);

            if (this._kickTimer <= 0) {
                this._kicked    = false;
                this._waitTimer = 0;
                this.bm.snapToFront();
            }
        } else {
            // 대기 중: 볼 앞에 붙이고 타이머 증가
            this.bm.snapToFront();
            this._waitTimer += dt;

            if (this._waitTimer >= DribbleController.KICK_INTERVAL) {
                this._kick();
            }
        }
    }

    _kick() {
        const { x, y, fwdX, fwdY } = this.bm.frontPos();
        // 볼을 앞으로 밀어냄
        this.bm.ball.setPosition(
            x + fwdX * DribbleController.KICK_AHEAD,
            y + fwdY * DribbleController.KICK_AHEAD
        );
        this._kicked    = true;
        this._kickTimer = DribbleController.KICK_DURATION;
        this._waitTimer = 0;
    }
}
