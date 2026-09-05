/**
 * AttackChoice - 공격 선택 중재자 공통 모듈
 *
 * 슛 / 패스 / 드리블 중 무엇을 할지를 인원수 무관(NvM)하게 결정한다.
 * 기존에는 이 선택이 시나리오·팀AI에 난수 게이트로 하드코딩되어 있었다
 * (ThreeVsThree.openTick의 passP, AttackerTeamAI의 0.035~0.68 확률).
 * 이 모듈은 OverloadAssessment + ShotDecision 결과를 받아 확정적
 * 우선순위로 선택한다. 난수 없음 — 같은 상황이면 같은 선택.
 *
 * 우선순위:
 *   1. 슛 — ShotDecision forced, 또는 shoot + 품질 임계 이상
 *   2. 패스 — 레인이 열렸고 (a) 수비수가 홀더에 붙었거나 (b) 레인이 비었으면
 *   3. 드리블 — 수비수가 레인을 막고 홀더에 붙지 않으면 유인 드리블,
 *      레인이 닫혔으면 돌파/대기 (방법은 DribbleDecision이 정한다).
 *      전방이 탁 트였는데 동료가 뒤에 있으면 후방 패스 대신 캐리어가 직접
 *      전진한다 (front-open-carry) — 템포를 죽이지 않는다.
 *
 * 핵심 전술 (2v1 검증 대상):
 *   "수비수가 패스 라인을 막으면 드리블로 유인하고,
 *    수비수가 드리블(홀더)을 막으면 패스한다."
 *
 * 순수 판단 모듈이다 — 킥·이동을 수행하지 않고 선택만 반환한다.
 */
export const ATTACK_ACTION = Object.freeze({
    SHOOT: 'shoot',
    PASS: 'pass',
    DRIBBLE: 'dribble',
});

const DEFAULTS = {
    shootQualityMin: 0.45, // 이 이상이면 슛 선택
    passLaneMin: 28,       // 패스 레인 최소 개방 (SVG, segmentClearance 기준)
    passMinGain: -20,      // lane-open 패스에 요구되는 최소 전진 이득 (SVG)
    // 지원 대형이 갖춰지기 전 후방 패스를 막는다. 압박 해제(drawn) 패스에는
    // 적용하지 않는다 — 불리해도 발을 빼야 할 때는 방향을 가리지 않는다.
    openFieldMin: 150,     // 이 이상 전방이 비었으면 "탁 트인 전방" (SVG, spaceAhead 기준)
    forwardGainMin: 0,     // 탁 트인 전방에서는 이 이상 전진하는 패스만 허용한다.
    // 전방이 열렸는데 후방 패스를 하면 템포를 죽인다 — 캐리어가 직접 몰고 간다.
    minHoldTime: 1.0,      // 소유 교체 후 패스까지 최소 유지 시간 (초)
    // 리시브 직후 논스톱 핑퐁을 막는다 — 실제 축구처럼 터치 후 판단한다.
    // 소유자 identity로 자동 감지하므로 시나리오 통지 불필요.
};

export class AttackChoice {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this._lastOwner = null;
        this._holdTime = 0;
    }

    reset() {
        this._lastOwner = null;
        this._holdTime = 0;
    }

    /**
     * @param {object} ctx
     *   assessment   {object} OverloadAssessment.assess 결과
     *   shotEval     {object} ShotDecision.evaluate 결과 ({ shoot, forced, quality })
     *   ballAttached {boolean} 볼이 공격수 발에 붙어 있는지 (false면 패스·슛 불가)
     *   owner        {object} 현재 볼 소유자 (identity로 교체 감지, 선택)
     *   dt           {number} 프레임 시간 (홀드 타이머용, 기본 0.016)
     * @returns {{ action: 'shoot'|'pass'|'dribble', mateIdx: number, reason: string }}
     */
    choose(ctx) {
        const o = this.o;
        const a = ctx.assessment;
        const shotEval = ctx.shotEval ?? {};
        const attached = ctx.ballAttached !== false;
        const dt = ctx.dt ?? 0.016;

        // 소유 교체 감지 — 리시브·탈취 후 홀드 타이머 리셋
        if (ctx.owner !== undefined && ctx.owner !== this._lastOwner) {
            this._lastOwner = ctx.owner;
            this._holdTime = 0;
        }
        this._holdTime += dt;

        // 볼이 발에 없으면(킥 사이클 중) 선택 없이 드리블 계속 — 터치를 기다린다
        if (!attached) return { action: ATTACK_ACTION.DRIBBLE, mateIdx: -1, reason: 'no-touch' };
        if (!a) return { action: ATTACK_ACTION.DRIBBLE, mateIdx: -1, reason: 'no-assessment' };

        // 1. 슛 — 결정적 찬스 우선
        if (shotEval.forced) {
            return { action: ATTACK_ACTION.SHOOT, mateIdx: -1, reason: 'forced' };
        }
        if (shotEval.shoot && (shotEval.quality ?? 0) >= o.shootQualityMin) {
            return { action: ATTACK_ACTION.SHOOT, mateIdx: -1, reason: 'quality' };
        }

        // 2·3. 패스 vs 드리블 — 최우선 동료와 수비수 상태로 결정
        const best = (a.mates ?? [])[0] ?? null;
        if (!best || best.idx < 0) {
            return { action: ATTACK_ACTION.DRIBBLE, mateIdx: -1, reason: 'no-mate' };
        }
        // 소유 직후 논스톱 패스 금지 — 터치 후 판단한다
        if (this._holdTime < o.minHoldTime) {
            return { action: ATTACK_ACTION.DRIBBLE, mateIdx: -1, reason: 'settling' };
        }
        const def = a.defender;
        const laneOk = best.lane >= o.passLaneMin;

        if (laneOk && def && def.onHolder) {
            // 수비수가 홀더에 붙었다 = 동료가 비었다 → 패스
            return { action: ATTACK_ACTION.PASS, mateIdx: best.idx, reason: 'drawn' };
        }
        if (laneOk && (!def || !def.inLane)) {
            // 레인이 비었어도 동료가 뒤에 있으면 지원 대형을 기다린다
            if ((best.gain ?? 0) < o.passMinGain) {
                return { action: ATTACK_ACTION.DRIBBLE, mateIdx: -1, reason: 'wait-support' };
            }
            // 전방이 탁 트였는데 후방 패스는 템포를 죽인다 — 캐리어가 직접 전진한다.
            // 압박 해제(drawn) 패스는 제외 — 불리해도 발을 빼야 할 때는 방향을 가리지 않는다.
            if ((a.spaceAhead ?? 0) >= o.openFieldMin && (best.gain ?? 0) < o.forwardGainMin) {
                return { action: ATTACK_ACTION.DRIBBLE, mateIdx: -1, reason: 'front-open-carry' };
            }
            // 레인이 비었다 → 패스
            return { action: ATTACK_ACTION.PASS, mateIdx: best.idx, reason: 'lane-open' };
        }
        if (def && def.inLane && !def.onHolder) {
            // 수비수가 레인을 막고 홀더에 붙지 않았다 → 드리블로 유인
            return { action: ATTACK_ACTION.DRIBBLE, mateIdx: -1, reason: 'draw-defender' };
        }
        // 레인이 닫혔고 압박 중 → 돌파/대기 (방법은 DribbleDecision 몫)
        return { action: ATTACK_ACTION.DRIBBLE, mateIdx: -1, reason: 'lane-closed' };
    }
}
