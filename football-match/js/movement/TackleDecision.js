/**
 * TackleDecision - 태클 커밋 판단 공통 모듈
 *
 * "지금 발을 뻗어도 되는가"를 인원수 무관(NvM)하게 결정한다.
 * DefenderDuelAI의 LUNGE 게이트와 동일 기준을 순수 판단으로 분리한 것으로,
 * 이동을 직접 구동하지 않는 시나리오(DefensiveDecision 조합 — 1v2·3v2·11v11)가
 * 태클 타이밍만 재사용한다:
 *   - 볼이 발에 붙어 있으면 절대 커밋하지 않는다 (무모한 돌진 방지)
 *   - 킥 국면(볼이 발에서 떨어짐) + 근거리 + 정면 + 쿨다운 완료일 때만 커밋
 *
 * 커밋 후 실제 탈취 여부는 PossessionContest가 해소한다.
 * 이 모듈은 "발을 뻗는 순간"만 결정한다.
 *
 * 순수 판단 모듈이다 — 이동·킥을 수행하지 않고 커밋 여부만 반환한다.
 * 쿨다운은 수비수 객체 기준으로 내부 유지하므로 호출자는 dt만 넘긴다.
 */
import { angleTo, angleDiff } from './Direction.js';

const DEFAULTS = {
    lungeRange: 32,       // 이 안에서 킥 윈도우가 나면 태클 커밋 (DefenderDuelAI와 동일)
    facingTolerance: 55,  // 태클 커밋 허용 몸 각도 오차 (DefenderDuelAI와 동일)
    cooldown: 2.2,        // 연속 태클 방지 — 헛발 후 공격수에게 돌파 기회 보장
};

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export class TackleDecision {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this._cooldowns = new Map(); // defender → 잔여 쿨다운(초)
    }

    reset() {
        this._cooldowns.clear();
    }

    /** 매 프레임 호출 — 전원 쿨다운 차감 (판정과 무관하게 항상 흐른다) */
    update(dt) {
        for (const [d, t] of this._cooldowns) {
            const nt = t - dt;
            if (nt <= 0) this._cooldowns.delete(d);
            else this._cooldowns.set(d, nt);
        }
    }

    /**
     * @param {object} defender {x,y,angle} 태클 시도 수비수
     * @param {object} ball {x,y} 볼 위치
     * @param {boolean} ballAttached 볼이 공격수 발에 붙어 있는지
     *   (DribbleController.ballAttached — 킥 국면이면 false)
     * @returns {boolean} true면 이번 프레임 태클 커밋 (쿨다운 리셋됨)
     */
    decide(defender, ball, ballAttached) {
        const o = this.o;
        // 볼이 발에 붙어 있으면 절대 돌진하지 않는다
        // (미지정 시 attached로 간주 — DefenderDuelAI와 동일 보수 기준)
        if (ballAttached !== false) return false;
        if ((this._cooldowns.get(defender) ?? 0) > 0) return false;
        if (dist(defender, ball) > o.lungeRange) return false;
        const toBall = angleTo(defender.x, defender.y, ball.x, ball.y);
        if (Math.abs(angleDiff(toBall, defender.angle)) > o.facingTolerance) return false;
        this._cooldowns.set(defender, o.cooldown);
        return true;
    }
}
