/**
 * Direction - 각도·방향 수학 공통 모듈
 *
 * SVG 좌표계 규약을 따른다:
 *   angle = 0   → forward = (0, +1)
 *   angle = -90 → forward = (+1, 0)
 *   angle = 90  → forward = (-1, 0)
 *   angle = 180 → forward = (0, -1)
 *
 * 이 모듈은 상태를 갖지 않으며 순수한 수학 함수만 제공한다.
 */

/** 두 점 사이의 방향각을 반환한다 (도). */
export function angleTo(fromX, fromY, toX, toY) {
    return Math.atan2(fromX - toX, toY - fromY) * 180 / Math.PI;
}

/** 두 각도의 최단 차이를 (-180 ~ +180) 범위로 반환한다. */
export function angleDiff(target, current) {
    let d = target - current;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
}

/** 각도를 (-180 ~ +180) 범위로 정규화한다. */
export function normalizeAngle(deg) {
    let d = deg;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
}

/** 주어진 각도의 전방 단위 벡터를 반환한다. */
export function forwardVector(angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    return { x: -Math.sin(rad), y: Math.cos(rad) };
}

/** 주어진 각도의 오른쪽 단위 벡터를 반환한다. */
export function rightVector(angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    return { x: Math.cos(rad), y: Math.sin(rad) };
}
