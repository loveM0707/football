/**
 * DribbleRoute - 골을 향한 드리블 웨이포인트 생성 모듈
 *
 * 방향 전환과 속도 전환을 독립적인 거리 주기로 만들고,
 * 마지막에는 목표 Y로 부드럽게 수렴한다.
 */
import { PlayerMovement } from './PlayerMovement.js';
import { forwardVector } from './Direction.js';

const SPEEDS = PlayerMovement.SPEEDS;

function randomSpeed() {
    return SPEEDS[Math.floor(Math.random() * SPEEDS.length)];
}

function randomSpeedDist() {
    return 50 + Math.random() * 50;
}

function randomDirDist() {
    return 100 + Math.random() * 50;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * @param {number} startX
 * @param {number} startY
 * @param {object} options
 * @param {number} options.endX 방향·속도 변화를 끝낼 X
 * @param {number} options.finalX 최종 웨이포인트 X
 * @param {number} options.finalY 최종 웨이포인트 Y
 * @param {number} options.yMin 웨이포인트 최소 Y
 * @param {number} options.yMax 웨이포인트 최대 Y
 */
export function generateGoalDribbleWaypoints(startX, startY, options = {}) {
    const endX = options.endX ?? 870;
    const finalX = options.finalX ?? endX;
    const finalY = options.finalY ?? startY;
    const yMin = options.yMin ?? 45;
    const yMax = options.yMax ?? 635;
    const wps = [];
    const xRange = Math.max(1, endX - startX);

    let x = startX;
    let y = startY;
    let dir = -90;
    let speed = randomSpeed();
    let dirLeft = randomDirDist();
    let speedLeft = randomSpeedDist();

    while (x < endX) {
        const progress = clamp((x - startX) / xRange, 0, 1);
        const step = Math.min(dirLeft, speedLeft);
        const fwd = forwardVector(dir);
        const cx = Math.min(x + fwd.x * step, endX);
        const cy = clamp(y + fwd.y * step, yMin, yMax);

        wps.push({ x: cx, y: cy, speed });
        x = cx;
        y = cy;
        dirLeft -= step;
        speedLeft -= step;

        if (dirLeft <= 0.5) {
            const maxDev = 42 * (1 - progress * 0.57);
            const yOffset = y - finalY;
            const pull = 0.25 + progress * 0.55;
            const bias = -yOffset * pull * 0.38;
            const deviation = clamp(
                (Math.random() * 2 - 1) * maxDev + bias,
                -maxDev,
                maxDev,
            );
            dir = -90 + deviation;
            dirLeft = randomDirDist();
        }

        if (speedLeft <= 0.5) {
            speed = randomSpeed();
            speedLeft = randomSpeedDist();
        }
    }

    if (Math.abs(y - finalY) > 25) {
        const midX = x + (finalX - x) * 0.5;
        const midY = y + (finalY - y) * 0.6;
        wps.push({ x: midX, y: midY, speed: randomSpeed() });
        x = midX;
        y = midY;
    }

    wps.push({ x: finalX, y: finalY, speed: randomSpeed() });
    return wps;
}
