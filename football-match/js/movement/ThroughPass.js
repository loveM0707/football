/**
 * ThroughPass - 달려가는 공격수의 진행 공간으로 보내는 스루패스 모듈
 *
 * 러너의 현재 위치에서 진행 방향으로 리드 거리를 더한 지점을 계산하고,
 * 그 공간으로 지상 패스를 보낸다. 러너의 속도·리드 타임·도착 잔여 속도는
 * 메뉴별 상황에 맞게 조정할 수 있다.
 */
import { PassMovement }  from './PassMovement.js';
import { PlayerMovement } from './PlayerMovement.js';
import { forwardVector } from './Direction.js';

const DEFAULT_LEAD_TIME = 1.15;
const DEFAULT_ARRIVE_SPEED = 100;
const DEFAULT_CATCH_DISTANCE = 22;
const DEFAULT_MAX_DEVIATION_DEG = 0;

function normalize(vector) {
    const length = Math.hypot(vector.x, vector.y) || 1;
    return { x: vector.x / length, y: vector.y / length };
}

export class ThroughPass {
    constructor(options = {}) {
        this._leadTime = options.leadTime ?? DEFAULT_LEAD_TIME;
        this._leadDistance = options.leadDistance ?? null;
        this._arriveSpeed = options.arriveSpeed ?? DEFAULT_ARRIVE_SPEED;
        this._catchDistance = options.catchDistance ?? DEFAULT_CATCH_DISTANCE;
        this._maxDeviationDeg = options.maxDeviationDeg ?? DEFAULT_MAX_DEVIATION_DEG;
    }

    /**
     * 러너가 도달할 공간을 계산한다.
     * @param {object} options
     *   runner       {Player}
     *   direction    {x, y} 진행 방향. 없으면 runner.angle 사용
     *   runnerSpeed  {number} 러너의 속도
     *   leadDistance {number} 직접 지정할 공간 선행 거리
     *   leadTime     {number} 선행 거리 계산에 사용할 시간
     */
    targetSpace(options) {
        const runner = options.runner;
        const direction = normalize(options.direction ?? forwardVector(runner.angle));
        const runnerSpeed = options.runnerSpeed
            ?? PlayerMovement.SPEEDS[4];
        const leadDistance = options.leadDistance ?? this._leadDistance
            ?? runnerSpeed * (options.leadTime ?? this._leadTime);

        return {
            x: runner.x + direction.x * leadDistance,
            y: runner.y + direction.y * leadDistance,
        };
    }

    /**
     * 러너의 진행 공간으로 패스를 시작한다.
     * @returns {{ target, initialSpeed, timeToArrive }}
     */
    play(ballMovement, options) {
        const target = this.targetSpace(options);
        const result = PassMovement.shortPass(
            ballMovement,
            target.x,
            target.y,
            {
                arriveSpeed: options.arriveSpeed ?? this._arriveSpeed,
                deviationRad: options.deviationRad
                    ?? (Math.random() * 2 - 1)
                    * (options.maxDeviationDeg ?? this._maxDeviationDeg)
                    * Math.PI / 180,
            },
        );
        return { ...result, target };
    }

    isCatchable(ball, runner, catchDistance = this._catchDistance) {
        return Math.hypot(ball.x - runner.x, ball.y - runner.y) < catchDistance;
    }
}
