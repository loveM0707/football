/**
 * Geometry - 점·선분 기하 공통 모듈
 *
 * 점과 선분 사이의 최단 거리를 한 곳에서만 정의한다.
 * 기존에 ShotDecision, AttackerTeamAI, GoalkeeperDistribution,
 * 패스·3:3 시나리오 6곳에 복사되어 있던 동일 수식을 이 모듈로 통합 —
 * 패스 레인·슛 라인 차단 판정이 어디서나 같은 기준으로 동작한다.
 *
 * 이 모듈은 상태를 갖지 않으며 순수한 수학 함수만 제공한다.
 */

/**
 * 점(px,py)에서 선분(x1,y1)-(x2,y2)까지의 최단 거리를 반환한다.
 * 선분이 점으로 축소된 경우 점과의 거리를 반환한다.
 */
export function distPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 여러 점({x,y} 배열) 중 선분(x1,y1)-(x2,y2)에 가장 가까운 거리를 반환한다.
 * 패스 길 위의 상대 간섭(레인 개방도) 판정용. 점이 없으면 Infinity.
 */
export function segmentClearance(points, x1, y1, x2, y2) {
    let best = Infinity;
    for (const p of points) {
        const d = distPointToSegment(p.x, p.y, x1, y1, x2, y2);
        if (d < best) best = d;
    }
    return best;
}
