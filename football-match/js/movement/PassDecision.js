/**
 * PassDecision - 패스 대상 결정 공통 모듈
 *
 * "누구에게 패스할 것인가"를 시나리오 연출(랜덤 선택)이 아닌
 * 축구 기준으로 결정한다.
 *   - 레인 개방도: 패스 길 위 상대 간섭 (Geometry.segmentClearance)
 *   - 전진성: 공격 방향으로의 이득 (방향이 있을 때만)
 *   - 거리: 너무 가깝거나 먼 대상 제외
 *   - 압박: 쫓길 때는 먼 거리 감점 완화 + 전방 우선
 *
 * FourPlayerPassDefense/CoopDefense의 chooseReceiverAvoid*와
 * ThreeVsThree.tryPass의 후보 채점을 하나의 기준으로 통합한다.
 * 방향(dir)이 없으면(중립 순환 패스) 레인·거리만으로 판단한다.
 */
import { segmentClearance } from './Geometry.js';

const DEFAULTS = {
    minDist: 60,       // 이보다 가까우면 제외
    maxDist: 460,      // 이보다 멀면 제외
    minOpenness: 20,   // 레인 개방 최소치 (relax 시 무시)
    fwdOnlyGain: 70,   // forwardOnly 시 요구 전진 이득
    backCutOpenness: 30, // 후방 패스 허용 최소 레인
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class PassDecision {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * @param {object} ctx
     *   passer      {x,y}     패서 위치
     *   candidates  {Array}   [{ player:{x,y}, idx? }] 패서 제외 후보
     *   opponents   {Array}   [{x,y}] 상대 선수 (선택)
     *   dir         {number}  공격 방향 (+1/-1, 없으면 중립)
     *   attackGoalX {number}  공격 골라인 X (전진 보너스용, 선택)
     *   relax       {boolean} 긴급 탈출 — 닫힌 레인도 감수
     *   forwardOnly {boolean} 전진 패스만 허용 (슛 존 등)
     *   underPress  {boolean} 압박 상황 — 먼 거리 감점 완화
     * @returns {{ ok, idx, player, score, openness, dist, gain } | { ok:false }}
     */
    evaluate(ctx) {
        const o = this.o;
        const p = ctx.passer;
        const opponents = ctx.opponents ?? [];
        const dir = ctx.dir ?? null;
        const attackGoalX = ctx.attackGoalX ?? null;
        const relax = Boolean(ctx.relax);
        const underPress = Boolean(ctx.underPress);

        let best = null;
        let bestScore = -Infinity;

        for (const c of ctx.candidates ?? []) {
            const m = c.player;
            const dist = Math.hypot(m.x - p.x, m.y - p.y);
            if (dist < o.minDist || dist > o.maxDist) continue;

            const openness = segmentClearance(opponents, p.x, p.y, m.x, m.y);
            if (!relax && openness < o.minOpenness) continue;

            const gain = dir !== null ? dir * (m.x - p.x) : 0;
            if (ctx.forwardOnly && gain < o.fwdOnlyGain) continue;

            // 후방 패스 억제 — 레인이 넓을 때만 허용하되 큰 벌점
            let backPenalty = 0;
            if (dir !== null && gain < -10 && !relax) {
                if (openness < o.backCutOpenness) continue;
                backPenalty = -90;
            }

            const forwardBonus = dir === null ? 0
                : gain > 60 ? 40 : gain < -40 ? -50 : 0;
            const boxBonus = (dir !== null && attackGoalX !== null
                && Math.abs(attackGoalX - m.x) < 260) ? 25 : 0;

            const score = openness * 0.55 + gain * 0.5 + forwardBonus + boxBonus
                + backPenalty - dist * 0.075
                + (underPress ? -dist * 0.04 + 30 : 0);

            if (score > bestScore) {
                bestScore = score;
                best = { ok: true, idx: c.idx ?? -1, player: m, score, openness, dist, gain };
            }
        }

        return best ?? { ok: false };
    }
}
