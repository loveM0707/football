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

/**
 * 수비수 회피를 포함한 공격 웨이포인트 생성.
 *
 * DribbleDefense.js, OneVsOne.js에서 중복되던 인라인 로직을 통합한다.
 * 수비수 위치를 인지해 회피 경로를 삽입하고, 진행 방향을 유지한다.
 *
 * @param {number} startX       시작 X
 * @param {number} startY       시작 Y
 * @param {object} options
 * @param {number} options.endX          경로 종점 X (기본 870)
 * @param {number} options.finalX        최종 X (기본 endX)
 * @param {number} options.finalY        최종 Y (기본 startY)
 * @param {number} options.yMin          Y 하한 (기본 45)
 * @param {number} options.yMax          Y 상한 (기본 635)
 * @param {number} options.defenderX     수비수 X 위치
 * @param {number} options.defenderY     수비수 Y 위치
 * @param {number} options.avoidDist     회피 거리 (기본 80)
 * @param {number} options.maxDeviation  최대 방향 편차 (기본 42도)
 * @param {number} options.centerY       중앙 Y (기본 340)
 */
export function generateDefensiveWaypoints(startX, startY, options = {}) {
    const endX     = options.endX ?? 870;
    const finalX   = options.finalX ?? endX;
    const finalY   = options.finalY ?? startY;
    const yMin     = options.yMin ?? 45;
    const yMax     = options.yMax ?? 635;
    const defX     = options.defenderX ?? 600;
    const defY     = options.defenderY ?? 340;
    const avoidDist = options.avoidDist ?? 80;
    const maxDev   = options.maxDeviation ?? 42;
    const centerY  = options.centerY ?? 340;
    const maxX     = options.maxX ?? (endX + 30);

    const wps       = [];
    const avoidSign = Math.random() < 0.5 ? -1 : 1;
    const xRange    = Math.max(1, endX - startX);

    let x = startX, y = startY;
    let dir = -90, speed = randomSpeed();
    let dirLeft   = 100 + Math.random() * 50;
    let speedLeft = 50 + Math.random() * 50;
    let avoided   = false;

    while (x < endX) {
        const progress = clamp((x - startX) / xRange, 0, 1);
        const step = Math.min(dirLeft, speedLeft);
        const fwd = forwardVector(dir);
        let cx = Math.min(x + fwd.x * step, maxX);
        let cy = clamp(y + fwd.y * step, yMin, yMax);

        // 수비수 회피 경유지 삽입
        if (!avoided && x < defX - 20 && cx >= defX - 20) {
            avoided = true;
            const safeY = clamp(defY + avoidSign * (avoidDist + 10), yMin, yMax);
            wps.push({ x: defX - 20, y: safeY, speed });
            x = defX - 20; y = safeY;
            dirLeft   = 100 + Math.random() * 50;
            speedLeft = 50 + Math.random() * 50;
            continue;
        }

        wps.push({ x: cx, y: cy, speed });
        x = cx; y = cy;
        dirLeft -= step; speedLeft -= step;

        // 방향 변경
        if (dirLeft <= 0.5) {
            const curMaxDev = maxDev * (1 - progress * 0.57);
            const yOffset = y - centerY;
            const pull    = 0.25 + progress * 0.55;
            // 수비수 접근 시 회피 편향
            const proximity = (!avoided && x < defX)
                ? Math.max(0, 1 - (defX - x) / 300) : 0;
            const bias = -yOffset * pull * 0.38
                       + avoidSign * curMaxDev * proximity * 0.5;
            const deviation = clamp(
                (Math.random() * 2 - 1) * curMaxDev + bias,
                -curMaxDev, curMaxDev,
            );
            dir = -90 + deviation;
            dirLeft = 100 + Math.random() * 50;
        }

        // 속도 변경
        if (speedLeft <= 0.5) {
            speed = randomSpeed();
            speedLeft = 50 + Math.random() * 50;
        }
    }

    // 중앙 수렴
    if (Math.abs(y - finalY) > 25) {
        const midX = x + (finalX - x) * 0.5;
        const midY = y + (finalY - y) * 0.6;
        wps.push({ x: midX, y: midY, speed: randomSpeed() });
        x = midX;
    }

    wps.push({ x: finalX, y: finalY, speed: randomSpeed() });
    return wps;
}
