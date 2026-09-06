/**
 * OffBallDecision - 오프볼(무볼) 이동 판단 공통 모듈
 *
 * 볼 없는 공격수가 "어디로 움직일 것인가"를 결정한다.
 * AttackerTeamAI(2인제 지원런)와 ThreeManAttack(3인제 침투/지원)에 흩어져 있던
 * 역할 분담·간격 유지·침투 목표 계산을 인원수 무관한 하나의 기준으로 통합한다.
 *
 * 파이프라인 (Perception → Situation → Decision → Intent):
 *   Perception  carrier/ball/mates/opponents/goal 입력
 *   Situation   공간 평가 (전진도·중앙성·압박·간격) + 전원 기준 수적 우열
 *   Decision    역할 배정 (penetrate/support/widen, stickiness로 진동 방지)
 *     - 동료가 1명뿐이어도 전원 기준 수적 우위면 프리맨으로 침투시킨다
 *       (2v1 백패스 방지 — 뒤에서 맴돌면 패스가 후방으로 향할 수밖에 없다)
 *     - 캐리어와 먼 비침투자는 근거리로 복귀시키지 않고 볼 반대편 폭을
 *       유지한다 (뭉침 방지 — 3v2·11v11 전환 옵션)
 *   Intent      목표점 + 권장 속도 (이동 실행은 호출자가 PlayerMovement로 수행)
 *
 * 순수 판단 모듈이다 — PlayerMovement를 직접 제어하지 않으므로
 * 2v2·3v3·11v11 어디서나 호출자(리타겟 타이머·속도 실행은 각자 유지)와 조합한다.
 * ShotDecision/CrossDecision/PassDecision과 같은 사용 패턴이다.
 *
 * 아울렛 지원 (탈압박):
 *   캐리어가 강하게 압박받으면 가장 가까운 동료 1명이 짧게 내려와
 *   탈출구를 만든다. 간격 유지와 반대 방향이지만, 압박 상황에서만
 *   발동하는 예외 규칙이다. outletTrigger가 Infinity(기본값)면 꺼진다.
 */
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

export const OFFBALL_ROLE = Object.freeze({
    PENETRATE: 'penetrate', // 골대 정면 침투 (찬스 공간 생성)
    SUPPORT: 'support',     // 근거리 지원 (패스 각도 제공)
    WIDEN: 'widen',         // 폭 유지 — 볼 반대편 측면 깊이 확보 (전환 옵션)
});

const DEFAULTS = {
    dir: 1,                 // 공격 방향 (+1 = 오른쪽 골 공격)
    attackGoalX: 1050,
    centerY: 340,
    minX: 0,
    maxX: 1050,
    yMin: 45,
    yMax: 635,
    maxPenetrators: 1,      // 침투자 수 (11v11 확장 시 상향)
    penetrateDepth: 140,    // 골대에서 이만큼 앞 (SVG)
    penetrateWidth: 55,     // 중앙 통로 반폭
    supportForward: 75,     // 캐리어 전방 오프셋 기준
    supportForwardVar: 25,  // 전방 오프셋 가변폭 (시계 파동과 합성)
    supportLateral: 95,     // 측면 오프셋 기준
    supportLateralVar: 17,  // 측면 오프셋 가변폭
    minDist: 75,            // 캐리어와 최소 간격 (이하면 분리 개입)
    idealMin: 95,           // 분리 시 확보 거리
    idealMax: 150,
    maxDist: 160,           // 이보다 멀면 복귀 스프린트
    minSideGap: 65,         // 측면 최소 폭 (이하면 반대편으로)
    stickiness: 0.15,       // 침투자 유지 여유 (역할 진동 방지)
    outletTrigger: Infinity, // 이보다 가까이 압박받으면 아울렛 발동 (기본 꺼짐)
    outletDist: 60,         // 아울렛 목표 — 캐리어와 이 거리 유지
    widenDist: 170,         // 캐리어와 이보다 멀면 폭 유지로 전환 (뭉침 방지)
    widenHysteresis: 30,    // 폭 유지 해제 여유 (진동 방지)
    widenForward: 110,      // 폭 유지 깊이 (캐리어 전방 오프셋)
    widenHalfWidth: 200,    // 폭 유지 측면 (중앙 기준 반폭)
    maxWideners: 2,         // 폭 유지 인원 (양 측면 커버)
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class OffBallDecision {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * @param {object} ctx
     *   carrier    {x,y}       볼 소유자
     *   mates      {Array}     [{ player:{x,y}, idx }] 판단 대상 (캐리어 제외)
     *   opponents  {Array}     [{x,y}] 상대 선수 (선택)
     *   clock      {number}    전역 시계 (자연스러운 파동용, 기본 0)
     *   prevRoles  {Array}     mates 순서와 같은 이전 역할 (유지 판단용, 선택)
     * @returns {Array} mates 순서와 같은
     *   [{ idx, role, targetX, targetY, speed, separating, outlet }]
     *   outlet=true면 아울렛 지원 (탈압박용 짧은 내려옴)
     */
    evaluate(ctx) {
        const o = this.o;
        const carrier = ctx.carrier;
        const mates = ctx.mates ?? [];
        const opponents = ctx.opponents ?? [];
        const clock = ctx.clock ?? 0;
        const prevRoles = ctx.prevRoles ?? null;

        if (mates.length === 0) return [];

        // ── Decision: 침투자 선정 (전진도 + 중앙성 - 압박) ──
        const order = this._rankPenetration(mates, carrier, opponents);
        const penetrators = new Set();
        let limit = Math.min(o.maxPenetrators, mates.length > 1 ? mates.length : 0);
        if (limit === 0 && mates.length === 1 && opponents.length > 0) {
            // 유일한 동료 + 전원 기준 수적 우위 = 프리맨 → 빈 공간으로 침투한다.
            // (대표: 2v1 — 뒤에서 맴돌면 패스가 후방으로 향할 수밖에 없다.)
            // 근처 반경이 아니라 전원 기준인 이유: 2v2처럼 수비수가 멀리 있어도
            // 동수면 지원 대형을 유지해야 한다. 무상대 패스 드릴도 지원 유지.
            const mine = 1 + mates.length; // carrier 포함
            const theirs = opponents.length;
            const verdict = mine > theirs ? 'overload' : mine < theirs ? 'underload' : 'even';
            const wasPenetrating = !!prevRoles && prevRoles[0] === OFFBALL_ROLE.PENETRATE;
            // 한 번 침투했으면 동수까지 유지해 역할 진동을 막는다 (열세면 지원 복귀).
            if (verdict === 'overload' || (wasPenetrating && verdict === 'even')) {
                limit = Math.min(o.maxPenetrators, 1);
            }
        }
        for (let k = 0; k < limit && k < order.length; k++) {
            penetrators.add(order[k]);
        }
        // 유지 판단 — 기존 침투자가 아직 유효하면 역할 진동을 막는다
        if (prevRoles && limit > 0) {
            const prevPen = mates.findIndex((m, i) => prevRoles[i] === OFFBALL_ROLE.PENETRATE);
            if (prevPen >= 0 && !penetrators.has(prevPen)) {
                const prevScore = this._penetrationScore(mates[prevPen].player, carrier, opponents);
                const bestScore = this._penetrationScore(mates[order[0]].player, carrier, opponents);
                if (prevScore >= bestScore - o.stickiness) {
                    penetrators.clear();
                    penetrators.add(prevPen);
                }
            }
        }

        // ── Decision: 폭 유지 선정 (뭉침 방지) ──
        // 캐리어와 먼 비침투자는 근거리 지원으로 복귀시키지 않고 볼 반대편
        // 측면 깊이를 유지한다. 공이 왼쪽에 있으면 오른쪽에 폭이 생겨
        // 전환 패스 옵션이 된다. 동료 1명(2v1·단일 지원)은 제외 — 기존
        // 지원 복귀 동작을 유지한다.
        const wideners = new Set();
        if (mates.length > 1) {
            const cands = order
                .filter(i => !penetrators.has(i))
                .map(i => ({ i, d: Math.hypot(
                    mates[i].player.x - carrier.x, mates[i].player.y - carrier.y) }))
                .sort((a, b) => b.d - a.d); // 먼 순서
            for (const c of cands) {
                if (wideners.size >= o.maxWideners) break;
                const wasWiden = !!prevRoles && prevRoles[c.i] === OFFBALL_ROLE.WIDEN;
                if (c.d > o.widenDist
                    || (wasWiden && c.d > o.widenDist - o.widenHysteresis)) {
                    wideners.add(c.i);
                }
            }
        }

        // ── Decision: 아울렛 지원 (탈압박) ──
        // 캐리어가 강하게 압박받으면 가장 가까운 동료 1명이 짧게 내려와
        // 탈출구를 만든다. 간격 유지와 반대 방향이지만 압박 상황에서만
        // 발동하는 예외 규칙이다. outletTrigger가 Infinity(기본값)면 꺼진다.
        let outletIdx = -1;
        if (o.outletTrigger !== Infinity && mates.length > 0) {
            let pressD = Infinity;
            for (const opp of opponents) {
                pressD = Math.min(pressD, Math.hypot(opp.x - carrier.x, opp.y - carrier.y));
            }
            if (pressD < o.outletTrigger) {
                let best = -1, bd = Infinity;
                mates.forEach((m, i) => {
                    if (penetrators.has(i)) return;
                    const d = Math.hypot(m.player.x - carrier.x, m.player.y - carrier.y);
                    if (d < bd) { bd = d; best = i; }
                });
                if (best >= 0 && bd > o.outletDist + 20) outletIdx = best;
            }
        }

        // ── Intent: 역할별 목표점 + 속도 ──
        return mates.map((m, i) => {
            if (i === outletIdx) {
                return { idx: m.idx ?? i, role: OFFBALL_ROLE.SUPPORT, ...this._outletTarget(m.player, carrier), outlet: true };
            }
            const role = penetrators.has(i) ? OFFBALL_ROLE.PENETRATE
                : wideners.has(i) ? OFFBALL_ROLE.WIDEN
                : OFFBALL_ROLE.SUPPORT;
            const phase = i * 2.39; // 선수별 파동 위상 (결정적, 상태 불필요)
            const intent = role === OFFBALL_ROLE.PENETRATE
                ? this._penetrateTarget(m.player, carrier, clock, phase)
                : role === OFFBALL_ROLE.WIDEN
                    ? this._widenTarget(m.player, carrier)
                    : this._supportTarget(m.player, carrier, opponents, clock, phase);
            return { idx: m.idx ?? i, role, outlet: false, ...intent };
        });
    }

    /** 아울렛 목표 — 캐리어 쪽으로 짧게 내려와 탈출 각도를 만든다. */
    _outletTarget(p, carrier) {
        const o = this.o;
        const dx = p.x - carrier.x, dy = p.y - carrier.y;
        const d = Math.hypot(dx, dy) || 1;
        return {
            targetX: clamp(carrier.x + (dx / d) * o.outletDist, o.minX, o.maxX),
            targetY: clamp(carrier.y + (dy / d) * o.outletDist, o.yMin + 15, o.yMax - 15),
            speed: SPEEDS[3],
            separating: false,
        };
    }

    /* ── Situation ─────────────────────────────── */

    /** 침투 적합도 — 전진 + 중앙 + 여유 공간 + 근접 (타이밍) */
    _penetrationScore(p, carrier, opponents) {
        const o = this.o;
        const forwardness = o.dir * (p.x - carrier.x);
        const centrality = -Math.abs(p.y - o.centerY) / 100;
        let nearestOpp = Infinity;
        for (const opp of opponents) {
            nearestOpp = Math.min(nearestOpp, Math.hypot(opp.x - p.x, opp.y - p.y));
        }
        const freedom = Math.min(nearestOpp, 150) / 150;
        // 너무 멀면 도착 전에 국면이 끝난다 — 가까운 동료가 침투하고
        // 먼 동료는 폭을 유지한다 (뭉침·폭 방치 방지)
        const proximity = -Math.hypot(p.x - carrier.x, p.y - carrier.y) / 400;
        return forwardness * 0.01 + centrality * 0.5 + freedom * 0.8 + proximity;
    }

    _rankPenetration(mates, carrier, opponents) {
        return mates
            .map((m, i) => ({ i, s: this._penetrationScore(m.player, carrier, opponents) }))
            .sort((a, b) => b.s - a.s)
            .map(e => e.i);
    }

    /** 수비수가 적은 측면 — 지원 폭 방향 */
    _freerSide(carrier, opponents) {
        let up = 0, down = 0;
        for (const opp of opponents) {
            if (opp.y < carrier.y) up++;
            else down++;
        }
        if (up === down) return 0;
        return up > down ? 1 : -1; // 수비 반대쪽
    }

    /* ── Intent ────────────────────────────────── */

    _penetrateTarget(p, carrier, clock, phase) {
        const o = this.o;
        let tx = o.attackGoalX - o.dir * o.penetrateDepth;
        // 캐리어보다 뒤처지지 않게 전방성 보정
        if (o.dir > 0) tx = Math.max(tx, carrier.x + 35);
        else tx = Math.min(tx, carrier.x - 35);
        tx = clamp(tx, o.minX, o.maxX);
        // 중앙 통로 + 파동으로 자연스러움
        let ty = o.centerY + Math.sin(clock * 1.1 + phase) * 12;
        ty = clamp(ty, o.centerY - o.penetrateWidth, o.centerY + o.penetrateWidth);

        const dd = Math.hypot(p.x - tx, p.y - ty);
        const speed = dd > 140 ? SPEEDS[4] : dd > 70 ? SPEEDS[3] : SPEEDS[2];
        return this._withSeparation(p, carrier, tx, ty, speed, phase);
    }

    /** 볼 반대편 측면 깊이 — 전환 패스 옵션 (분리 개입 불필요, 원거리) */
    _widenTarget(p, carrier) {
        const o = this.o;
        const side = carrier.y <= o.centerY ? 1 : -1; // 볼 반대편
        let tx = carrier.x + o.dir * o.widenForward;
        if (o.dir > 0) tx = Math.min(tx, o.attackGoalX - 60);
        else tx = Math.max(tx, o.attackGoalX + 60);
        tx = clamp(tx, o.minX, o.maxX);
        const ty = clamp(o.centerY + side * o.widenHalfWidth, o.yMin + 15, o.yMax - 15);

        const dd = Math.hypot(p.x - tx, p.y - ty);
        const speed = dd > 140 ? SPEEDS[4] : dd > 70 ? SPEEDS[3] : SPEEDS[2];
        return { targetX: tx, targetY: ty, speed, separating: false };
    }

    _supportTarget(p, carrier, opponents, clock, phase) {
        const o = this.o;
        // 측면: 수비 반대쪽, 필드 가장자리면 안쪽으로
        let side = this._freerSide(carrier, opponents);
        if (side === 0) side = p.y < carrier.y ? -1 : 1;
        if (carrier.y < o.yMin + 135) side = 1;
        if (carrier.y > o.yMax - 135) side = -1;

        const fwd = o.supportForward + Math.sin(clock * 0.7 + phase) * o.supportForwardVar;
        const lat = side * (o.supportLateral + Math.sin(clock * 1.1 + phase) * o.supportLateralVar);
        let tx = clamp(carrier.x + o.dir * fwd, o.minX, o.maxX);
        let ty = clamp(carrier.y + lat, o.yMin + 15, o.yMax - 15);
        // 캐리어 바로 옆 겹침 방지 — 측면 폭 확보
        if (Math.abs(ty - carrier.y) < o.minSideGap) {
            ty = clamp(carrier.y + side * o.minSideGap, o.yMin + 15, o.yMax - 15);
            tx = clamp(carrier.x + o.dir * Math.max(fwd, 30), o.minX, o.maxX);
        }

        const dd = Math.hypot(p.x - tx, p.y - ty);
        const speed = dd > o.maxDist ? SPEEDS[4]
            : dd > o.idealMax ? SPEEDS[3]
            : dd < o.minDist ? SPEEDS[2]
            : SPEEDS[3];
        return this._withSeparation(p, carrier, tx, ty, speed, phase);
    }

    /** 간격 붕괴 시 캐리어 기준 반경방향 이탈 목표 (분리 개입) */
    _withSeparation(p, carrier, tx, ty, speed, phase) {
        const o = this.o;
        const dx = p.x - carrier.x, dy = p.y - carrier.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= o.minDist) {
            return { targetX: tx, targetY: ty, speed, separating: false };
        }
        const nx = dist > 1 ? dx / dist : 1;
        const ny = dist > 1 ? dy / dist : 0;
        let sx = carrier.x + nx * o.idealMin;
        let sy = carrier.y + ny * o.idealMin;
        if (Math.abs(sy - carrier.y) < o.minSideGap) {
            const side = ny !== 0 ? Math.sign(ny) : (phase > 3 ? -1 : 1);
            sy = carrier.y + side * o.minSideGap;
            sx = carrier.x + Math.max(nx * o.idealMin, o.dir * 30);
        }
        return {
            targetX: clamp(sx, o.minX, o.maxX),
            targetY: clamp(sy, o.yMin + 15, o.yMax - 15),
            speed: SPEEDS[4],
            separating: true,
        };
    }
}
