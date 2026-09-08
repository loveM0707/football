/**
 * KeepAway - 무방향 킵어웨이(론도) 이동 공통 모듈
 *
 * 공격 방향 없이 "범위 안에서 볼을 빼앗기지 않는" 움직임을 제공한다.
 * 방향성 움직임(OffBallDecision·DribbleDecision)과 교체 가능한 형태로,
 * 필요할 때 시나리오가 둘 중 하나를 선택해 재사용한다.
 *
 * 구성:
 *   - KeepAwaySupport  동료 오프볼 — 팀 전체가 5~15m 사각형(론도 박스)을
 *                      이룬다. 볼을 따라달리지 않고 담당 코너를 지킨다.
 *                      (OffBallDecision.evaluate와 동일 입출력 — 구동부 공유)
 *   - KeepAwayCarry    캐리어 — 열린 공간으로 운반한다 (DribbleDecision 대체)
 *   - clampToZone      범위 클램프 (모든 목표점은 범위를 벗어나지 않는다)
 *   - cornerRisk       코너 리스크 — 복싱 링처럼 범위 구석은 "열린 곳"이
 *                      아니라 "몰리면 출구가 막히는 곳"으로 강한 벌점을 준다
 *
 * 간격·겹침 방지는 공용 프리미티브 Geometry.relaxSpacing 를 쓴다 —
 * 방향성 메뉴의 OffBallDecision 도 같은 함수로 목표점 간격을 유지한다.
 *
 * 판단은 기존 모듈에 위임한다 (중복 구현 금지):
 *   - 패스 대상 순위 = TeamSupport.passOptions (orientation 'neutral')
 *   - 레인 개방도    = Geometry.segmentClearance
 *   - 패스/드리블 선택 = OverloadAssessment + AttackChoice (orientation 'neutral')
 *   - 수비           = DefensiveDecision (orientation 'neutral', 골 = 범위 중심)
 */
import { PlayerMovement } from './PlayerMovement.js';
import { segmentClearance, relaxSpacing } from './Geometry.js';

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
    boxW: 145,           // 팀 사각형 가로 (SVG) — 10 = 1m → 14.5m
    boxH: 115,           // 세로 — 11.5m. 인접 코너 간격이 곧 패스 거리 (5~15m)
    pairSpacing: 60,     // 동료 간 최소 이완 (6m, 공용 Geometry.relaxSpacing)
    anchorFollow: 0.05,  // 대형 중심의 볼 추적 (EMA/frame) — 따라달림 없음
    rotSpeed: 0.12,      // 사각형의 아주 느린 회전 — 목표가 항상 살아있다
    avoidRadius: 130,    // 수비수가 코너에 붙으면 밀려난다
    avoidShift: 90,
    cornerRadius: 170,   // 범위 구석 코너 리스크 회피 (링 metaphor)
    cornerShift: 90,
    follow: 0.15,        // 목표 스무딩 (지터 방지)
    zoneMargin: 25,      // 경계 여유 — 전원 사각형 안에서만
    outsideMargin: 0,
    laneSeek: 0.4,       // 막힌 레인의 옆 코너로_blend할 비율
    laneMin: 40,         // 이보다 레인이 막히면 탐색 개시
};

export class KeepAwaySupport {
    constructor(options = {}) {
        this.o = { ...SUPPORT_DEFAULTS, ...options };
        this._targets = new Map();  // player -> 스무딩된 절대 목표
        this._anchor = null;        // 대형 중심 — 볼의 느린 EMA
        this._lastClock = null;     // 회전용 시계
        this._rot = 0;              // 사각형 회전각
        this._vacant = -1;          // 캐리어가 점령할 코너 (히스테리시스)
    }

    reset() {
        this._targets.clear();
        this._anchor = null;
        this._lastClock = null;
        this._rot = 0;
        this._vacant = -1;
    }

    /**
     * 소유팀 4인은 5~15m 변을 가진 사각형을 이루며 볼을 따라 흐른다.
     * 캐리어가 가장 가까운 코너 하나를 "점령"하고(빈 코너), 나머지 동료가
     * 남은 세 코너를 방위순으로 나눠 갖는다 — 서로 겹치지 않고, 볼에게
     * 달려가지 않으며, 레인이 막히면 옆 코너로 옮겨 열린 패스 길을 만든다.
     * @param {object} ctx
     *   carrier    {x,y}     볼 소유자 (대형 앵커)
     *   mates      {Array}   [{ player:{x,y}, idx }] 소유자 제외 동료
     *   opponents  {Array}   [{x,y}] 상대
     *   zone       {object}  { minX, maxX, minY, maxY } 유지 범위 (필수)
     *   clock      {number}  회전용 시계 (선택)
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

        // 회전 — 아주 느리게 돌아 목표가 항상 살아있게 유지된다
        const clock = ctx.clock ?? null;
        let dtC = 0;
        if (clock !== null && this._lastClock !== null && clock >= this._lastClock) {
            dtC = Math.min(clock - this._lastClock, 0.25);
        }
        this._lastClock = clock;
        this._rot += o.rotSpeed * dtC;

        // 사각형 4코너
        const cos = Math.cos(this._rot), sin = Math.sin(this._rot);
        const hw = o.boxW / 2, hh = o.boxH / 2;
        const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
            .map(([ux, uy]) => ({ x: cx + ux * cos - uy * sin, y: cy + ux * sin + uy * cos }));

        // 캐리어가 점령할 코너(빈 자리) — 현재 볼 위치 기준, 히스테리시스
        let vac = 0, vd = Infinity;
        corners.forEach((q, i) => {
            const d = carrier ? Math.hypot(q.x - carrier.x, q.y - carrier.y) : i;
            if (d < vd) { vd = d; vac = i; }
        });
        if (carrier && this._vacant >= 0 && this._vacant !== vac) {
            const cur = corners[this._vacant];
            const cd = Math.hypot(cur.x - carrier.x, cur.y - carrier.y);
            if (vd + 16 >= cd) vac = this._vacant; // 더 이상 분명할 때만 교체
        }
        this._vacant = vac;

        // 남은 코너 ↔ 동료 — 방위순 정렬 후 회전 정렬로 총 이동거리 최소 배정
        const free = [0, 1, 2, 3].filter(i => i !== vac);
        const bearing = (x, y) => Math.atan2(y - cy, x - cx);
        const sm = [...mates].sort((a, b) =>
            bearing(a.player.x, a.player.y) - bearing(b.player.x, b.player.y));
        const sf = [...free].sort((a, b) =>
            bearing(corners[a].x, corners[a].y) - bearing(corners[b].x, corners[b].y));
        let bestR = 0, bestCost = Infinity;
        const F = sf.length;
        for (let r = 0; r < F; r++) {
            let cost = 0;
            for (let i = 0; i < sm.length; i++) {
                const c = corners[sf[(i + r) % F]];
                cost += Math.hypot(c.x - sm[i].player.x, c.y - sm[i].player.y);
            }
            if (cost < bestCost) { bestCost = cost; bestR = r; }
        }
        const assign = new Map();
        sm.forEach((m, i) => assign.set(m.player, sf[(i + bestR) % F]));

        // 코너별 홈 산출 — 레인 탐색 → 수비 회피 → 코너 리스크
        const works = [];
        for (const m of mates) {
            const p = m.player;
            const ci = assign.get(p) ?? sf[0] ?? 0;
            let q = corners[ci];
            let hx = q.x, hy = q.y;
            if (carrier && segmentClearance(opponents, carrier.x, carrier.y, hx, hy) < o.laneMin) {
                const nb = [(ci + 1) % 4, (ci + 3) % 4].filter(k => k !== vac);
                let bk = -1, bl = -1;
                for (const k of nb) {
                    const l = segmentClearance(opponents, carrier.x, carrier.y, corners[k].x, corners[k].y);
                    if (l > bl) { bl = l; bk = k; }
                }
                const cur = segmentClearance(opponents, carrier.x, carrier.y, q.x, q.y);
                if (bk >= 0 && bl > cur) {
                    const t = o.laneSeek;
                    hx = q.x + (corners[bk].x - q.x) * t;
                    hy = q.y + (corners[bk].y - q.y) * t;
                }
            }
            for (const opp of opponents) {
                const dx = hx - opp.x, dy = hy - opp.y;
                const d = Math.hypot(dx, dy);
                if (d < o.avoidRadius && d > 1) {
                    const w = (1 - d / o.avoidRadius) * o.avoidShift;
                    hx += dx / d * w;
                    hy += dy / d * w;
                }
            }
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
            works.push({ m, hx, hy });
        }
        // 동료 간 겹침 방지 — 공용 이완 프리미티브 (다른 메뉴도 동일 함수 사용)
        relaxSpacing(works.map(w => ({ x: w.hx, y: w.hy, ref: w })), {
            minSpacing: o.pairSpacing,
            iterations: 2,
        }).forEach(pt => { pt.ref.hx = pt.x; pt.ref.hy = pt.y; });

        const ex = o.outsideMargin ?? 0;
        const mg = ex > 0 ? 0 : o.zoneMargin;
        return works.map(({ m, hx, hy }) => {
            const p = m.player;
            const h = {
                x: Math.max(zone.minX - ex + mg, Math.min(zone.maxX + ex - mg, hx)),
                y: Math.max(zone.minY - ex + mg, Math.min(zone.maxY + ex - mg, hy)),
            };
            // 목표 스무딩 — 홈은 사각형 코너, 회피 이동만 부드럽게 보간된다
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
    cornerPenalty: 300, // 코너 정면 벌점 — 동료 지원보다 강하게 (드리블 유입 차단)
    forbidOutward: true, // 캐리어는 바깥쪽을 향해 드리블할 수 없다
    outwardCosMax: 0.35, // 바깥쪽 판정 임계 (cos) — 이보다 바깥 성분이 크면 금지 (횡드리블은 허용)
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
            // 바깥쪽 드리블 금지 — 횡드리블/정지 키핑만 허용
            if (o.forbidOutward) {
                const vx = t.x - carrier.x, vy = t.y - carrier.y;
                const vl = Math.hypot(vx, vy);
                if (vl > 1) {
                    const zcx = (zone.minX + zone.maxX) / 2;
                    const zcy = (zone.minY + zone.maxY) / 2;
                    const ox = carrier.x - zcx, oy = carrier.y - zcy;
                    const ol = Math.hypot(ox, oy);
                    if (ol > 20) {
                        const onx = ox / ol, ony = oy / ol;
                        const dot = vx * onx + vy * ony;
                        if (dot > o.outwardCosMax * vl) continue;
                    }
                }
            }
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
