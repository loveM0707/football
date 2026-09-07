/**
 * KeepAway - 무방향 킵어웨이(론도) 이동 공통 모듈
 *
 * 공격 방향 없이 "범위 안에서 볼을 빼앗기지 않는" 움직임을 제공한다.
 * 방향성 움직임(OffBallDecision·DribbleDecision)과 교체 가능한 형태로,
 * 필요할 때 시나리오가 둘 중 하나를 선택해 재사용한다.
 *
 * 구성:
 *   - KeepAwaySupport  동료 오프볼 — 구역 기준 담당 홈(론도 대형)을 지켜
 *                      공간을 벌린다. 볼을 따라달리지 않는다.
 *                      (OffBallDecision.evaluate와 동일 입출력 — 구동부 공유)
 *   - KeepAwayCarry    캐리어 — 열린 공간으로 운반한다 (DribbleDecision 대체)
 *   - clampToZone      범위 클램프 (모든 목표점은 범위를 벗어나지 않는다)
 *   - cornerRisk       코너 리스크 — 복싱 링처럼 범위 구석은 "열린 곳"이
 *                      아니라 "몰리면 출구가 막히는 곳"으로 강한 벌점을 준다
 *
 * 판단은 기존 모듈에 위임한다 (중복 구현 금지):
 *   - 패스 대상 순위 = TeamSupport.passOptions (orientation 'neutral')
 *   - 레인 개방도    = Geometry.segmentClearance
 *   - 패스/드리블 선택 = OverloadAssessment + AttackChoice (orientation 'neutral')
 *   - 수비           = DefensiveDecision (orientation 'neutral', 골 = 범위 중심)
 *
 * 무방향 중립 설정 (이 모듈과 함께 사용):
 *   TeamSupport/OverloadAssessment/DefensiveDecision에 orientation: 'neutral'을
 *   넘기면 전진성·박스 가점이 제거되고 개방도·레인만으로 판단한다.
 *   수비 앵커(goalX/goalY)는 범위 중심으로 두면 "공간 차단"이 된다.
 */
import { PlayerMovement } from './PlayerMovement.js';
import { segmentClearance } from './Geometry.js';

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

export const KEEP_ROLE = {
    SUPPORT: 'support', // 공간 창출 지원 (전원 동일 역할 — 슬롯 분담 없음)
};

/** 점을 범위에 가둔다 (margin = 경계 여유). */
export function clampToZone(x, y, zone, margin = 0) {
    return {
        x: Math.max(zone.minX + margin, Math.min(zone.maxX - margin, x)),
        y: Math.max(zone.minY + margin, Math.min(zone.maxY - margin, y)),
    };
}

function nearestOppDist(x, y, opponents) {
    let bd = Infinity;
    for (const p of opponents) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) bd = d;
    }
    return bd;
}

/**
 * 코너 리스크 (복싱 링) — 링 구석에 몰리면 출구가 사라져 불리하다.
 * 범위 4코너 반경 안에 있을수록 강한 벌점을 반환한다 (0 ~ penalty).
 * "비어 있어서 열린" 코너를 열린 공간으로 착각하지 않게 하는 것이 목적이다.
 */
export function cornerRisk(x, y, zone, radius = 160, penalty = 260) {
    let worst = 0;
    for (const [cx, cy] of [
        [zone.minX, zone.minY], [zone.maxX, zone.minY],
        [zone.minX, zone.maxY], [zone.maxX, zone.maxY],
    ]) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < radius) worst = Math.max(worst, (1 - d / radius) ** 2);
    }
    return worst * penalty;
}

const SUPPORT_DEFAULTS = {
    ringScale: 0.55,   // 홈 링 반경 = 구역 절반 크기 × 이 값 — 공간을 크게 벌린다
    minRingR: 110,     // 홈 링 반경 하한 (좁은 구역에서도 축소되지 않게)
    anchorFollow: 0.035, // 대형 중심의 볼 추적 비율 (프레임당). 낮을수록
    // "따라다닌다"가 사라진다 — 중심이 볼을 약 0.5초 지연으로 좇으므로
    // 대형은 볼 근처에 머물되 선수들은 제자리를 지키고 회전만 한다.
    avoidRadius: 130,  // 국소 회피 반경 — 수비수가 홈에 붙으면 밀려난다
    avoidShift: 150,   // 압박 회피 최대 이동량 (SVG)
    pairRadius: 95,    // 동료 최소 페어 거리 — 이하면 밀어낸다 (붙어다니는 줄행렬 방지)
    pairShift: 120,    // 동료 간 밀어내기 최대량 (SVG)
    cornerRadius: 170, // 코너 회피 반경 (링 metaphor)
    cornerShift: 140,  // 코너에서 밀려나는 최대량 (SVG)
    follow: 0.15,      // 목표 스무딩 (프레임당 lerp — 지터 방지)
    zoneMargin: 25,    // 범위 경계 여유 (밖으로 나가지 않게)
    rotSpeed: 0.45,    // 대형 회전 속도 (rad/s) — 전원이 같은 방향·속도로
    // 돌아 간격은 유지한 채 계속 움직인다 ("서있음" 방지)
    laneSeek: 0.5,     // 레인 탐색 반영 비율 — 막힌 레인의 옆자리를 찾는다
    laneMin: 40,       // 이보다 레인이 막히면 옆자리 탐색 개시
};

export class KeepAwaySupport {
    constructor(options = {}) {
        this.o = { ...SUPPORT_DEFAULTS, ...options };
        this._slots = new Map();    // player -> 담당 방위각 (회전·탐색으로 점진 이동)
        this._targets = new Map();  // player -> 스무딩된 절대 목표
        this._anchor = null;        // 대형 중심 — 볼의 느린 EMA
        this._lastClock = null;     // 회전용 시계
    }

    reset() {
        this._slots.clear();
        this._targets.clear();
        this._anchor = null;
        this._lastClock = null;
    }

    /**
     * 홈은 볼 그 자체가 아니라 "느린 앵커" 기준이다 — 볼이 움직여도
     * 대형은 약 anchorFollow 지연으로만 따라간다. 그 위에서 전원이 같은
     * 속도로 회전하고, 캐리어→홈 레인이 막히면 옆자리로 옮겨간다 —
     * 간격은 유지한 채 끊임없이 공간·레인을 찾아 움직인다 (론도).
     * @param {object} ctx
     *   carrier    {x,y}     볼(소유자) — 대형 앵커 추적용
     *   mates      {Array}   [{ player:{x,y}, idx }] 소유자 제외 동료
     *   opponents  {Array}   [{x,y}] 상대
     *   zone       {object}  { minX, maxX, minY, maxY } 유지 범위 (필수)
     * @returns {Array} mates 순서와 같은 [{ idx, role, targetX, targetY, speed }]
     */
    evaluate(ctx) {
        const o = this.o;
        const mates = ctx.mates ?? [];
        const opponents = ctx.opponents ?? [];
        const zone = ctx.zone;
        if (!zone || mates.length === 0) return [];
        // 대형 중심 = 볼의 느린 EMA — 볼과 무한히 멀어지지도, 쫓아가지도 않는다
        const carrier = ctx.carrier;
        if (!this._anchor || carrier) {
            this._anchor = this._anchor && carrier
                ? {
                    x: this._anchor.x + (carrier.x - this._anchor.x) * o.anchorFollow,
                    y: this._anchor.y + (carrier.y - this._anchor.y) * o.anchorFollow,
                }
                : (this._anchor ?? (carrier ? { x: carrier.x, y: carrier.y } : null));
        }
        if (!this._anchor) return [];
        const cx = Math.max(zone.minX, Math.min(zone.maxX, this._anchor.x));
        const cy = Math.max(zone.minY, Math.min(zone.maxY, this._anchor.y));
        const rx = Math.max(o.minRingR, (zone.maxX - zone.minX) / 2 * o.ringScale);
        const ry = Math.max(o.minRingR, (zone.maxY - zone.minY) / 2 * o.ringScale);

        // 슬롯 최초 배정 — 현재 방위순으로 링을 균등 분할한다 (모임 위치 고정)
        if (this._slots.size === 0) {
            const sorted = [...mates].sort((a, b) =>
                Math.atan2(a.player.y - cy, a.player.x - cx)
                - Math.atan2(b.player.y - cy, b.player.x - cx));
            const ref = Math.atan2(sorted[0].player.y - cy, sorted[0].player.x - cx);
            sorted.forEach((m, i) => {
                this._slots.set(m.player, ref + (i / sorted.length) * Math.PI * 2);
            });
        }

        // 회전 시계 — 시나리오 clock을 받아 대형 전체를 같은 속도로 회전
        const clock = ctx.clock ?? null;
        let dtC = 0;
        if (clock !== null && this._lastClock !== null && clock >= this._lastClock) {
            dtC = Math.min(clock - this._lastClock, 0.25);
        }
        this._lastClock = clock;

        return mates.map((m) => {
            const p = m.player;
            let slot = this._slots.get(p) ?? Math.atan2(p.y - cy, p.x - cx);
            // 대형 회전 — 간격 유지 + 지속 움직임 ("서있음" 방지)
            slot += o.rotSpeed * dtC;
            // 레인 탐색 — 캐리어→홈 레인이 막히면 양옆 중 열린 쪽으로 이동
            if (carrier) {
                const hx0 = cx + Math.cos(slot) * rx;
                const hy0 = cy + Math.sin(slot) * ry;
                if (segmentClearance(opponents, carrier.x, carrier.y, hx0, hy0) < o.laneMin) {
                    const aP = slot + 0.45, aM = slot - 0.45;
                    const lP = segmentClearance(opponents, carrier.x, carrier.y,
                        cx + Math.cos(aP) * rx, cy + Math.sin(aP) * ry);
                    const lM = segmentClearance(opponents, carrier.x, carrier.y,
                        cx + Math.cos(aM) * rx, cy + Math.sin(aM) * ry);
                    slot += (lP >= lM ? 0.45 : -0.45) * o.laneSeek;
                }
            }
            this._slots.set(p, slot);
            // 담당 홈 — 링 위의 이동 지점
            let hx = cx + Math.cos(slot) * rx;
            let hy = cy + Math.sin(slot) * ry;
            // 국소 회피 — 수비수가 홈에 붙어있으면 바깥으로 밀려난다
            for (const q of opponents) {
                const dx = hx - q.x, dy = hy - q.y;
                const d = Math.hypot(dx, dy);
                if (d < o.avoidRadius && d > 1) {
                    const w = (1 - d / o.avoidRadius) * o.avoidShift;
                    hx += dx / d * w;
                    hy += dy / d * w;
                }
            }
            // 동료 간격 — 서로 붙으면 밀려난다 (줄서기 방지)
            for (const n of mates) {
                if (n.player === p) continue;
                const dx = hx - n.player.x, dy = hy - n.player.y;
                const d = Math.hypot(dx, dy);
                if (d < o.pairRadius && d > 1) {
                    const w = (1 - d / o.pairRadius) * o.pairShift;
                    hx += dx / d * w;
                    hy += dy / d * w;
                }
            }
            // 코너 회피 — 링 구석 홈은 불리하다 (열려 있어도 안 잡는다)
            for (const [qx, qy] of [
                [zone.minX, zone.minY], [zone.maxX, zone.minY],
                [zone.minX, zone.maxY], [zone.maxX, zone.maxY],
            ]) {
                const dx = hx - qx, dy = hy - qy;
                const d = Math.hypot(dx, dy);
                if (d < o.cornerRadius && d > 1) {
                    const w = (1 - d / o.cornerRadius) ** 2 * o.cornerShift;
                    hx += dx / d * w;
                    hy += dy / d * w;
                }
            }
            const h = clampToZone(hx, hy, zone, o.zoneMargin);
            // 목표 스무딩 — 홈 자체는 고정이라 회피 이동만 부드러워진다
            const prev = this._targets.get(p);
            const t = prev
                ? { x: prev.x + (h.x - prev.x) * o.follow, y: prev.y + (h.y - prev.y) * o.follow }
                : { x: h.x, y: h.y };
            this._targets.set(p, t);
            const dd = Math.hypot(p.x - t.x, p.y - t.y);
            const speed = dd > 120 ? SPEEDS[4]
                : dd > 60 ? SPEEDS[3]
                : dd > 25 ? SPEEDS[2]
                : SPEEDS[1];
            return { idx: m.idx, role: KEEP_ROLE.SUPPORT, targetX: t.x, targetY: t.y, speed };
        });
    }
}

const CARRY_DEFAULTS = {
    scanRadius: 100,   // 운반 후보 링 반경 (SVG)
    zoneMargin: 30,    // 범위 경계 여유 (캐리어는 더 안쪽 유지)
    samples: 8,        // 후보 각도 수
    pressDist: 80,     // 이보다 가까이 붙으면 빠르게 탈출
    cornerRadius: 160, // 코너 리스크 판정 반경 (링 metaphor)
    cornerPenalty: 300 // 코너 정면 벌점 — 동료 지원보다 강하게 (드리블 유입 차단)
};

export class KeepAwayCarry {
    constructor(options = {}) {
        this.o = { ...CARRY_DEFAULTS, ...options };
    }

    /**
     * @param {object} ctx
     *   carrier    {x,y}     볼 소유자
     *   opponents  {Array}   [{x,y}] 상대
     *   zone       {object}  { minX, maxX, minY, maxY } 유지 범위 (필수)
     * @returns {{ targetX, targetY, speed }} 운반 목표 (moveTo 그대로 전달)
     */
    suggest(ctx) {
        const o = this.o;
        const carrier = ctx.carrier;
        const opponents = ctx.opponents ?? [];
        const zone = ctx.zone;
        // 최후 방어 — 범위 정보가 없어도 제자리 (밖으로 나가지 않게)
        if (!carrier || !zone) {
            return {
                targetX: carrier ? carrier.x : 0,
                targetY: carrier ? carrier.y : 0,
                speed: SPEEDS[1],
            };
        }
        // 열린 공간 + 범위 안쪽 선호, 코너 리스크 차감 —
        // 코너는 "수비가 없는 열린 곳"이 아니라 "출구가 막힌 불리한 곳"이다.
        let best = { x: carrier.x, y: carrier.y }, bestS = -Infinity;
        for (let s = 0; s <= o.samples; s++) {
            const a = s === o.samples ? 0 : (s / o.samples) * Math.PI * 2;
            const r = s === o.samples ? 0 : o.scanRadius;
            const t = clampToZone(
                carrier.x + Math.cos(a) * r, carrier.y + Math.sin(a) * r,
                zone, o.zoneMargin);
            const open = nearestOppDist(t.x, t.y, opponents);
            const edge = Math.min(
                t.x - zone.minX, zone.maxX - t.x, t.y - zone.minY, zone.maxY - t.y);
            const score = open + Math.max(0, edge) * 0.4
                - cornerRisk(t.x, t.y, zone, o.cornerRadius, o.cornerPenalty);
            if (score > bestS) { bestS = score; best = t; }
        }
        const nearest = nearestOppDist(carrier.x, carrier.y, opponents);
        const cornered = cornerRisk(carrier.x, carrier.y, zone, o.cornerRadius, 1) > 0.5;
        return {
            targetX: best.x, targetY: best.y,
            speed: (nearest < o.pressDist || cornered) ? SPEEDS[3] : SPEEDS[2],
        };
    }
}
