/**
 * OffBallDecision - 오프볼(무볼) 이동 판단 공통 모듈
 *
 * 볼 없는 공격수가 "어디로 움직일 것인가"를 결정한다.
 * AttackerTeamAI(2인제 지원런)와 ThreeManAttack(3인제 침투/지원)에 흩어져 있던
 * 역할 분담·간격 유지·침투 목표 계산을 인원수 무관한 하나의 기준으로 통합한다.
 *
 * 파이프라인 (Perception → Situation → Decision → Intent):
 *   Perception  carrier/ball/mates/opponents/goal 입력
 *   Situation   공간 평가 (전진도·중앙성·압박·간격)
 *   Decision    역할 배정 (penetrate/support, stickiness로 진동 방지)
 *   Intent      목표점 + 권장 속도 (이동 실행은 호출자가 PlayerMovement로 수행)
 *
 * 순수 판단 모듈이다 — PlayerMovement를 직접 제어하지 않으므로
 * 2v2·3v3·11v11 어디서나 호출자(리타겟 타이머·속도 실행은 각자 유지)와 조합한다.
 * ShotDecision/CrossDecision/PassDecision과 같은 사용 패턴이다.
 */
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

export const OFFBALL_ROLE = Object.freeze({
    PENETRATE: 'penetrate', // 골대 정면 침투 (찬스 공간 생성)
    SUPPORT: 'support',     // 폭·깊이 지원 (패스 각도 제공)
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
     * @returns {Array} mates 순서와 같은 [{ idx, role, targetX, targetY, speed, separating }]
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
        const limit = Math.min(o.maxPenetrators, mates.length > 1 ? mates.length : 0);
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

        // ── Intent: 역할별 목표점 + 속도 ──
        return mates.map((m, i) => {
            const role = penetrators.has(i) ? OFFBALL_ROLE.PENETRATE : OFFBALL_ROLE.SUPPORT;
            const phase = i * 2.39; // 선수별 파동 위상 (결정적, 상태 불필요)
            const intent = role === OFFBALL_ROLE.PENETRATE
                ? this._penetrateTarget(m.player, carrier, clock, phase)
                : this._supportTarget(m.player, carrier, opponents, clock, phase);
            return { idx: m.idx ?? i, role, ...intent };
        });
    }

    /* ── Situation ─────────────────────────────── */

    /** 침투 적합도 — 전진 + 중앙 + 여유 공간 */
    _penetrationScore(p, carrier, opponents) {
        const o = this.o;
        const forwardness = o.dir * (p.x - carrier.x);
        const centrality = -Math.abs(p.y - o.centerY) / 100;
        let nearestOpp = Infinity;
        for (const opp of opponents) {
            nearestOpp = Math.min(nearestOpp, Math.hypot(opp.x - p.x, opp.y - p.y));
        }
        const freedom = Math.min(nearestOpp, 150) / 150;
        return forwardness * 0.01 + centrality * 0.5 + freedom * 0.8;
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
