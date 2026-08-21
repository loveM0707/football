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
     * 수신자 반응 지연 (초).
     * 패스 직후 이 시간 동안 수신자는 정지 — 인간 반사신경 시뮬레이션.
     * 패스가 빠를수록 볼이 일찍 도달하므로 포지션 잡을 시간이 줄어든다.
     */
    static REACTION_DELAY = 0.2;

    /**
     * 숏패스: 볼을 (toX, toY) 방향으로 킥.
     * 마찰을 고려해 목적지에서 arriveSpeed 만큼 남도록 초기 속도를 계산.
     *
     * @param {BallMovement} bm
     * @param {number}       toX
     * @param {number}       toY
     * @param {object}       options
     *   arriveSpeed {number}  목적지 도달 시 잔여 속도 (기본 80 SVG/s)
     *   angleDevDeg {number}  최대 각도 편차(도). 무작위로 ±편차 적용. (기본 0)
     * @returns {{ initialSpeed, timeToArrive }}
     */
    static shortPass(bm, toX, toY, options = {}) {
        const ball = bm.ball;
        const dx   = toX - ball.x;
        const dy   = toY - ball.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return { initialSpeed: 0, timeToArrive: 0 };

        const arriveSpeed = options.arriveSpeed ?? PassMovement.SHORT_PASS_ARRIVE_SPEED;
        const angleDevDeg = options.angleDevDeg ?? 0;
        const v0          = Math.sqrt(arriveSpeed ** 2 + 2 * BallMovement.FRICTION * dist);

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
     * 롱패스: 볼을 공중으로 띄워 (toX, toY) 지점에 착지시킨다.
     * 마찰 없이 일정 수평 속도로 이동; 높이는 포물선(BallMovement.releaseAerial).
     *
     * @param {BallMovement} bm
     * @param {number}       toX
     * @param {number}       toY
     * @param {object}       options
     *   flightDuration {number}   비행 시간(초). 기본: max(0.8, dist/250)
     *   maxHeight      {number}   최고 높이 스케일 0~1 (기본 1.0)
     *   angleDevDeg    {number}   최대 각도 편차(도) (기본 0)
     *   onLand         {function} 착지 콜백
     * @returns {{ flightDuration }}
     */
    static longPass(bm, toX, toY, options = {}) {
        const ball = bm.ball;
        const dx   = toX - ball.x;
        const dy   = toY - ball.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return { flightDuration: 0 };

        const flightDuration = options.flightDuration ?? Math.max(0.8, dist / 250);
        let vx = dx / flightDuration;
        let vy = dy / flightDuration;

        const angleDevDeg = options.angleDevDeg ?? 0;
        if (angleDevDeg > 0) {
            const devRad = (Math.random() * 2 - 1) * angleDevDeg * Math.PI / 180;
            const cos    = Math.cos(devRad);
            const sin    = Math.sin(devRad);
            const vx2    = vx * cos - vy * sin;
            const vy2    = vx * sin + vy * cos;
            vx = vx2; vy = vy2;
        }

        bm.releaseAerial(vx, vy, flightDuration, options.maxHeight ?? 1.0, options.onLand ?? null);
        return { flightDuration };
    }

    /**
     * interceptPoint: 수신자가 볼을 몸 가운데로 받기 위한 목표 Y를 계산한다.
     *
     * 볼의 현재 속도 방향 직선 위에서 수신자 X까지 연장한 Y를 예측.
     * X 좌표는 변경하지 않는다 — 수신자는 옆으로만 이동.
     * 반응 후 한 번 호출해 targetY를 얻고, 매 프레임 직접 Y를 조금씩 이동시킨다.
     * (PlayerMovement의 회전 메커니즘을 우회해 setPosition을 직접 사용할 것)
     *
     * @param {BallMovement} bm
     * @param {Player}       receiver
     * @param {object}       options
     *   yMin {number}  Y 클램프 최솟값 (기본 45)
     *   yMax {number}  Y 클램프 최댓값 (기본 635)
     * @returns {{ x: number, y: number }}
     */
    static interceptPoint(bm, receiver, { yMin = 45, yMax = 635 } = {}) {
        const bx  = bm.ball.x, by = bm.ball.y;
        const vx  = bm.vx,     vy = bm.vy;
        const spd = Math.hypot(vx, vy);
        if (spd < 1) return { x: receiver.x, y: receiver.y };

        const nvx = vx / spd;
        const nvy = vy / spd;

        // 수신자 X 위치까지 볼 경로를 직선 연장 → 도달 Y 예측
        const proj = (receiver.x - bx) * nvx + (receiver.y - by) * nvy;
        const iy   = proj > 0 ? by + nvy * proj : receiver.y;

        return { x: receiver.x, y: Math.max(yMin, Math.min(yMax, iy)) };
    }

    /**
     * interceptSpeed: Y 이동 거리에 따른 수신자 속도를 5단계로 반환한다.
     *
     * PlayerMovement.SPEEDS [50, 75, 100, 125, 150] 와 동일한 값 사용.
     *
     * @param {number} distY  Y축 이동 거리 (SVG)
     * @returns {number}      이동 속도 (SVG/s)
     */
    static interceptSpeed(distY) {
        if (distY < 8)  return 50;
        if (distY < 18) return 75;
        if (distY < 30) return 100;
        if (distY < 45) return 125;
        return 150;
    }
}
