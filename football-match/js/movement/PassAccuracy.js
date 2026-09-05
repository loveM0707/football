/**
 * PassAccuracy - 패스 정확도 공통 모듈
 *
 * 무조건적인 랜덤 각도 편차 대신, 실제 축구 요소에서 패스 오차를 계산한다.
 *   - 거리: 멀수록 부정확 (수신자까지 볼이 오래 굴러간다)
 *   - 압박: 가까운 수비수가 있으면 자세가 흐트러진다
 *   - 숙련도: 패서 능력치가 높을수록 정확하다
 *   - 이동: 달리면서 차면 planted 상태보다 부정확하다
 *
 * PassMovement.shortPass/longPass의 deviationRad와 arriveSpeed 변동에 그대로 넣는다.
 * ShotExecution.plan()의 오차 모델과 같은 구조 (기본 + 거리 비례 + 압박 비례).
 */

const DEFAULTS = {
    baseSpreadDeg: 1.2,   // 기본 편차 (도) — 근거리·무압박·평균 숙련 기준
    distanceCoef: 0.008,  // 거리 1 SVG 당 편차 증가 (300 SVG ≈ 30m에서 +2.4도)
    pressureCoef: 4.0,    // 최대 압박 시 추가 편차 (도)
    pressureRadius: 110,  // 이 안에 수비수가 있으면 압박으로 본다
    skillRelief: 1.5,     // 숙련도 1.0이 깎아주는 편차 (도)
    movePenalty: 1.0,     // 이동 중 킥 추가 편차 (도)
    minSpreadDeg: 0.3,
    maxSpreadDeg: 9.0,
    arriveJitterBase: 0.04,   // 도착 속도 기본 변동률
    arriveJitterPress: 0.06,  // 압박 시 추가 변동률
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class PassAccuracy {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * 패스 오차를 평가한다.
     *
     * @param {object} ctx
     *   dist        {number}  패서→수신자 거리 (SVG)
     *   nearestOpp  {number}  패서와 가장 가까운 상대까지 거리 (기본 Infinity)
     *   skill       {number}  패서 숙련도 0~1 (기본 0.5)
     *   moving      {boolean} 패서가 이동 중인지 (기본 false)
     * @returns {{ deviationRad, spreadDeg, pressure, arriveJitter }}
     */
    evaluate(ctx = {}) {
        const o = this.o;
        const dist = Math.max(0, ctx.dist ?? 0);
        const nearest = ctx.nearestOpp ?? Infinity;
        const skill = clamp(ctx.skill ?? 0.5, 0, 1);

        // 압박도 0~1 — NonStopPass의 압박 거리와 같은 기준
        const pressure = clamp(1 - nearest / o.pressureRadius, 0, 1);

        let spread = o.baseSpreadDeg
            + dist * o.distanceCoef
            + pressure * o.pressureCoef
            - skill * o.skillRelief;
        if (ctx.moving) spread += o.movePenalty;
        spread = clamp(spread, o.minSpreadDeg, o.maxSpreadDeg);

        const deviationRad = (Math.random() * 2 - 1) * spread * Math.PI / 180;
        const arriveJitter = (Math.random() * 2 - 1)
            * (o.arriveJitterBase + pressure * o.arriveJitterPress);

        return { deviationRad, spreadDeg: spread, pressure, arriveJitter };
    }

    /** 패서 위치에서 가장 가까운 상대까지의 거리 (압박 계산용) */
    static nearestOpponent(passer, opponents = []) {
        let best = Infinity;
        for (const o of opponents) {
            best = Math.min(best, Math.hypot(o.x - passer.x, o.y - passer.y));
        }
        return best;
    }
}
