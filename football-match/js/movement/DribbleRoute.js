/**
 * DribbleRoute - 골을 향한 드리블 웨이포인트 생성 모듈
 *
 * 전진 방향을 크게 벗어나지 않으면서 속도 변화를 주는 단순한 경로를 만든다.
 * 위아래 흔들림을 최소화하고, 마지막에는 목표 Y로 부드럽게 수렴한다.
 */
import { PlayerMovement } from './PlayerMovement.js';
import { forwardVector } from './Direction.js';

const SPEEDS = PlayerMovement.SPEEDS;

function randomSpeed() {
    return SPEEDS[Math.floor(Math.random() * SPEEDS.length)];
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * 골을 향한 드리블 웨이포인트를 생성한다.
 *
 * @param {number} startX 시작 X
 * @param {number} startY 시작 Y
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
    let dir = -90; // 기본 전진 방향: 오른쪽
    let speed = randomSpeed();

    // 200~300 SVG 단위마다 방향 변경 (잦은 방향 전환 방지)
    let dirLeft = 200 + Math.random() * 100;
    // 80~130 SVG 단위마다 속도 변경
    let speedLeft = 80 + Math.random() * 50;

    while (x < endX) {
        const progress = clamp((x - startX) / xRange, 0, 1);
        const step = Math.min(dirLeft, speedLeft);
        const fwd = forwardVector(dir);

        // X 좌표가 절대 줄어들지 않도록 보장
        const cx = Math.max(x, Math.min(x + fwd.x * step, endX));
        const cy = clamp(y + fwd.y * step, yMin, yMax);

        wps.push({ x: cx, y: cy, speed });
        x = cx;
        y = cy;
        dirLeft -= step;
        speedLeft -= step;

        // 방향 변경
        if (dirLeft <= 0.5) {
            // 최대 편차: 12도 (이전: 42도) — 위아래 흔들림 최소화
            const maxDev = 12 * (1 - progress * 0.3);
            const yOffset = y - finalY;
            // Y 중앙으로 강한 되돌림 힘
            const pull = 0.4 + progress * 0.5;
            const bias = -yOffset * pull;
            const deviation = clamp(
                (Math.random() * 2 - 1) * maxDev + bias,
                -maxDev,
                maxDev,
            );
            dir = -90 + deviation;
            dirLeft = 200 + Math.random() * 100;
        }

        // 속도 변경
        if (speedLeft <= 0.5) {
            speed = randomSpeed();
            speedLeft = 80 + Math.random() * 50;
        }
    }

    // Y 중앙 정착 웨이포인트
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
