/**
 * LobbedThroughPass - 침투 공간으로 보내는 공중 스루패스
 *
 * 목표 공간 계산은 스루패스와 공유하지만, 공중 비행과 패스 편차는
 * 별도 모듈에서 관리한다. 실제 패스 물리는 PassMovement에 위임한다.
 */
import { PassMovement } from './PassMovement.js';
import { PlayerMovement } from './PlayerMovement.js';
import { forwardVector } from './Direction.js';

const DEFAULT_LEAD_TIME = 1.2;
const DEFAULT_ARRIVE_SPEED = 90;
const DEFAULT_MAX_HEIGHT = 1.25;
const DEFAULT_ANGLE_VARIATION_DEG = 4;
const DEFAULT_HEIGHT_VARIATION = 0.18;
const DEFAULT_POWER_VARIATION = 0.1;

function normalize(vector) {
    const length = Math.hypot(vector.x, vector.y) || 1;
    return { x: vector.x / length, y: vector.y / length };
}

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

export class LobbedThroughPass {
    constructor(options = {}) {
        this._leadTime = options.leadTime ?? DEFAULT_LEAD_TIME;
        this._leadDistance = options.leadDistance ?? null;
        this._arriveSpeed = options.arriveSpeed ?? DEFAULT_ARRIVE_SPEED;
        this._maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
        this._angleVariationDeg = options.angleVariationDeg ?? DEFAULT_ANGLE_VARIATION_DEG;
        this._heightVariation = options.heightVariation ?? DEFAULT_HEIGHT_VARIATION;
        this._powerVariation = options.powerVariation ?? DEFAULT_POWER_VARIATION;
    }

    targetSpace(options) {
        const runner = options.runner;
        const direction = normalize(options.direction ?? forwardVector(runner.angle));
        const runnerSpeed = options.runnerSpeed ?? PlayerMovement.SPEEDS[4];
        const leadDistance = options.leadDistance ?? this._leadDistance
            ?? runnerSpeed * (options.leadTime ?? this._leadTime);
        return {
            x: runner.x + direction.x * leadDistance,
            y: runner.y + direction.y * leadDistance,
        };
    }

    play(ballMovement, options) {
        const target = this.targetSpace(options);
        const ball = ballMovement.ball;
        const distance = Math.hypot(target.x - ball.x, target.y - ball.y);
        const baseDuration = options.flightDuration
            ?? Math.max(0.7, distance / 300);
        const powerVariation = options.powerVariation ?? this._powerVariation;
        const flightDuration = baseDuration * randomBetween(1 - powerVariation, 1 + powerVariation);
        const angleVariationDeg = options.angleVariationDeg ?? this._angleVariationDeg;
        const deviationRad = options.deviationRad
            ?? randomBetween(-angleVariationDeg, angleVariationDeg) * Math.PI / 180;
        const heightVariation = options.heightVariation ?? this._heightVariation;
        const maxHeight = Math.max(0.5, (options.maxHeight ?? this._maxHeight)
            * randomBetween(1 - heightVariation, 1 + heightVariation));

        const result = PassMovement.longPass(ballMovement, target.x, target.y, {
            flightDuration,
            maxHeight,
            deviationRad,
            onLand: options.onLand,
        });
        return { ...result, target, flightDuration, maxHeight, deviationRad };
    }
}
