/**
 * PassMovement - 패스 물리 모듈
 *
 * BallMovement.release()를 이용해 볼에 적절한 초기 속도를 부여한다.
 * 마찰(FRICTION)을 고려해 목적지 도달 시 arriveSpeed가 남도록 역산.
 *
 * 수식: v₀² = v_arrive² + 2 × FRICTION × dist
 *
 * 사용처: 숏패스, 나중에 롱패스·슈팅 등으로 확장 가능
 */
import { BallMovement } from './BallMovement.js';

export class PassMovement {

    /** 숏패스 기본 도달 속도 (SVG/s) */
    static SHORT_PASS_ARRIVE_SPEED = 80;

    /**
     * 숏패스: 볼을 (toX, toY) 방향으로 킥.
     * 마찰을 고려해 목적지에서 arriveSpeed 만큼 남도록 초기 속도를 계산.
     *
     * @param {BallMovement} bm
     * @param {number}       toX           목적지 X
     * @param {number}       toY           목적지 Y
     * @param {object}       options
     *   arriveSpeed {number}  목적지 도달 시 잔여 속도 (기본 80 SVG/s)
     * @returns {{ initialSpeed, timeToArrive }}
     */
    /**
     * @param {object} options
     *   arriveSpeed  {number}  목적지 도달 시 잔여 속도 (기본 80 SVG/s)
     *   angleDevDeg  {number}  최대 각도 편차(도). 0~angleDevDeg 범위에서 무작위 방향으로 빗겨남.
     *                          기본 0 (편차 없음)
     */
    static shortPass(bm, toX, toY, options = {}) {
        const ball = bm.ball;
        const dx   = toX - ball.x;
        const dy   = toY - ball.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return { initialSpeed: 0, timeToArrive: 0 };

        const arriveSpeed  = options.arriveSpeed ?? PassMovement.SHORT_PASS_ARRIVE_SPEED;
        const angleDevDeg  = options.angleDevDeg ?? 0;
        const v0           = Math.sqrt(arriveSpeed ** 2 + 2 * BallMovement.FRICTION * dist);

        let nx = dx / dist;
        let ny = dy / dist;

        // 각도 편차 적용 (2D 회전 행렬)
        if (angleDevDeg > 0) {
            const devRad = (Math.random() * 2 - 1) * angleDevDeg * Math.PI / 180;
            const cos    = Math.cos(devRad);
            const sin    = Math.sin(devRad);
            const nx2    = nx * cos - ny * sin;
            const ny2    = nx * sin + ny * cos;
            nx = nx2; ny = ny2;
        }

        bm.release(nx * v0, ny * v0);

        // 도달 시간 추정: 등감속 v = v₀ - a·t → t = (v₀ - v_arrive) / a
        const timeToArrive = (v0 - arriveSpeed) / BallMovement.FRICTION;
        return { initialSpeed: v0, timeToArrive };
    }

    /**
     * interceptPoint: 수신자가 볼을 맞이하기 위해 이동해야 할 목표 위치를 계산한다.
     *
     * 볼의 현재 속도 방향 직선 위에서 수신자와 가장 가까운 점을 구하고,
     * 볼 쪽으로 stepX만큼 전진한 위치를 반환한다.
     * 매 프레임 호출해 receiverPm.moveTo(pt.x, pt.y, ()=>{}) 에 전달한다.
     *
     * @param {BallMovement} bm
     * @param {Player}       receiver
     * @param {object}       options
     *   stepX {number}  볼 방향(X)으로 전진할 최대 픽셀 (기본 40)
     *   yMin  {number}  Y 클램프 최솟값 (기본 45)
     *   yMax  {number}  Y 클램프 최댓값 (기본 635)
     * @returns {{ x: number, y: number }}
     */
    static interceptPoint(bm, receiver, { stepX = 40, yMin = 45, yMax = 635 } = {}) {
        const bx  = bm.ball.x, by = bm.ball.y;
        const vx  = bm.vx,     vy = bm.vy;
        const spd = Math.hypot(vx, vy);
        if (spd < 1) return { x: receiver.x, y: receiver.y };

        const nvx = vx / spd;
        const nvy = vy / spd;

        // 수신자 위치를 볼 진행 방향 직선에 정사영 → 볼 도달 Y 예측
        const proj = (receiver.x - bx) * nvx + (receiver.y - by) * nvy;
        const iy   = proj > 0 ? by + nvy * proj : receiver.y;

        // 볼 방향(X축)으로 stepX만큼 전진
        const dx      = bx - receiver.x;
        const targetX = receiver.x + Math.sign(dx) * Math.min(stepX, Math.abs(dx));
        const targetY = Math.max(yMin, Math.min(yMax, iy));

        return { x: targetX, y: targetY };
    }
}
