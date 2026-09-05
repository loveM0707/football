/**
 * TransitionDecision - 전환 의사결정 공통 모듈
 *
 * 팀 상태를 받아 "이번 전환에 어떻게 대응할 것인가"를 정한다.
 * (Decision — 좌표·속도는 TransitionIntent가 정한다)
 *
 * 공격 전환 (볼 획득):
 *   COUNTER  역습 조건이면 전진 (5. Counter Attack)
 *   BUILDUP  조건이 아니면 지공 재구성
 * 수비 전환 (볼 상실):
 *   COUNTERPRESS  역압박 조건이면 즉시 압박 (6. Counterpress)
 *   FALLBACK      조건이 아니면 라인 복귀 (7·8 대응의 수비측)
 * 수비 안정 시 상대 역습 대응:
 *   ANTI_COUNTER  상대 전환 공격을 늦추고 물러난다 (7. 상대 역습 대응)
 *
 * 역습 조건 (11v11 재사용 가능):
 * - 턴오버 지점이 상대 진영寄り 또는 중원 전방
 * - 상대 라인이 흐트러짐 (볼보다 뒤에 있는 수비 maß 적음)
 * - 수적 동등 이상 + 앞 공간 존재
 */
export const TRANSITION_DECISION = Object.freeze({
    COUNTER: 'counter',
    BUILDUP: 'buildup',
    COUNTERPRESS: 'counterpress',
    FALLBACK: 'fallback',
    ANTI_COUNTER: 'anti-counter',
    HOLD: 'hold',
});

const DEFAULTS = {
    counterMinSpace: 120,   // 역습 최소 전방 공간 (SVG)
    counterPressDist: 220,  // 이보다 가까이 있어야 역압박
    counterPressSpace: 90,  // 역압박 시 뒤 공간이 이보다 좁으면 폴백
    attackThird: 700,       // 턴오버 x가 여기보다 전방이면 역습 가점 (우공격 기준 절댓값 아님)
};

export class TransitionDecision {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * 공격 전환 결정을 내린다 (볼을 획득한 팀).
     * @param {object} ctx
     *   turnover {x,y}, dir, ball, mates, opponents, transitionLeft
     * @returns {{ decision: string, urgency: number, reason: string }}
     */
    decideAttack(ctx = {}) {
        const o = this.o;
        const dir = ctx.dir ?? 1;
        const ball = ctx.ball ?? ctx.turnover ?? { x: 525, y: 340 };
        const mates = ctx.mates ?? [];
        const opponents = ctx.opponents ?? [];

        // 앞 공간: 공격 방향으로 가장 가까운 상대까지 거리
        let spaceAhead = Infinity;
        for (const opp of opponents) {
            const ahead = (opp.x - ball.x) * dir;
            if (ahead > -20) {
                const d = Math.hypot(opp.x - ball.x, opp.y - ball.y);
                spaceAhead = Math.min(spaceAhead, d);
            }
        }
        // 볼보다 뒤(자 protected 측)에 있는 아군 수 — 역습 지원 숫자
        let supportBehind = 0;
        for (const m of mates) {
            if ((m.x - ball.x) * dir < 30) supportBehind++;
        }
        // 상대 복귀 수 — 볼보다 골 쪽에 있는 상대 수
        let oppBack = 0;
        for (const opp of opponents) {
            if ((opp.x - ball.x) * dir > 0) oppBack++;
        }

        const open = spaceAhead >= o.counterMinSpace;
        const numbers = mates.length + 1 >= oppBack; // 획득자 포함
        // 5. Counter Attack — 열려 있고 수적으로 밀리지 않으면 역습
        if (open && numbers) {
            const urgency = Math.max(0.6, Math.min(1, spaceAhead / 300 + 0.5));
            return { decision: TRANSITION_DECISION.COUNTER, urgency, reason: '역습 공간·수적 우위' };
        }
        return { decision: TRANSITION_DECISION.BUILDUP, urgency: 0.4, reason: '지공 재구성' };
    }

    /**
     * 수비 전환 결정을 내린다 (볼을 잃은 팀).
     * @param {object} ctx { turnover, ball, mates, opponents, dir }
     * @returns {{ decision: string, urgency: number, reason: string }}
     */
    decideDefense(ctx = {}) {
        const o = this.o;
        const ball = ctx.ball ?? ctx.turnover ?? { x: 525, y: 340 };
        const mates = ctx.mates ?? [];

        // 가장 가까운 아군까지 거리 — 붙어 있으면 역압박 가능
        let nearest = Infinity;
        for (const m of mates) {
            nearest = Math.min(nearest, Math.hypot(m.x - ball.x, m.y - ball.y));
        }
        // 뒤 공간: 자기 골까지 거리 — 좁으면 무리한 압박 금지
        const ownGoalX = (ctx.dir ?? 1) > 0 ? 0 : 1050;
        const goalDist = Math.abs(ball.x - ownGoalX);

        // 6. Counterpress — 가까이 있고 뒤가 비지 않았으면 즉시 압박
        if (nearest <= o.counterPressDist && goalDist > o.counterPressSpace) {
            const urgency = Math.max(0.6, Math.min(1, 1 - nearest / (o.counterPressDist * 1.5) + 0.4));
            return { decision: TRANSITION_DECISION.COUNTERPRESS, urgency, reason: '즉시 역압박' };
        }
        // 7·8. 폴백 — 늦추고 라인으로 복귀
        return { decision: TRANSITION_DECISION.FALLBACK, urgency: 0.7, reason: '라인 복귀' };
    }

    /**
     * 상대 역습 대응 결정 (안정 수비 팀이 상대 전환 공격을 맞을 때).
     * @param {object} ctx { ball, mates, dir }
     * @returns {{ decision: string, urgency: number, reason: string }}
     */
    decideAntiCounter(ctx = {}) {
        const dir = ctx.dir ?? 1;
        const ball = ctx.ball ?? { x: 525, y: 340 };
        const ownGoalX = dir > 0 ? 0 : 1050;
        const goalDist = Math.abs(ball.x - ownGoalX);
        const urgency = goalDist < 320 ? 1 : goalDist < 520 ? 0.75 : 0.5;
        return { decision: TRANSITION_DECISION.ANTI_COUNTER, urgency, reason: '상대 역습 지연·복귀' };
    }
}
