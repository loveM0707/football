/**
 * GoalkeeperDecision - 골키퍼 의사결정 공통 모듈
 *
 * Situation + Perception을 받아 "무엇을 할 것인가"를 정한다.
 * 어디로·어떻게(좌표·속도)는 Intent 단계가 정하므로,
 * 여기서는 행동 종류와 판단 근거만 다룬다.
 *
 * Decision 종류:
 *   DISTRIBUTE  품은 볼 배급
 *   DIVE_TRACK  슛 궤적 추적·다이빙
 *   RUSH        1:1 좁히기 (전진)
 *   CLAIM_CROSS 크로스 크레임 (낙하지점 선점)
 *   CLAIM       공중볼·지면볼 직접 캐치
 *   SWEEP       세컨드볼 쓸어내기 (캐치 불가 시 클리어)
 *   HOLD        기본 위치 유지·미세 조정
 */
import { GK_SITUATION } from './GoalkeeperSituation.js';

export const GK_DECISION = Object.freeze({
    DISTRIBUTE: 'distribute',
    DIVE_TRACK: 'dive-track',
    RUSH: 'rush',
    CLAIM_CROSS: 'claim-cross',
    CLAIM: 'claim',
    SWEEP: 'sweep',
    HOLD: 'hold',
});

const DEFAULTS = {
    sweepCatchRadius: 11,   // 이 안에서만 캐치 시도, 밖이면 클리어
    punchCrowdDist: 26,     // 세이브 지점 주변 이 안에 상대가 있으면 펀칭
    punchHeight: 1.05,      // 이보다 높으면 펀칭 우선 (Ball 높이 m 단위 환산 전 스케일)
};

export class GoalkeeperDecision {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * @param {object} perception Perception 스냅샷
     * @param {object} situation  Situation 결과 { type, urgency }
     * @returns {{ action: string, urgency: number, punch: boolean, reason: string }}
     *   punch — 캐치 대신 펀칭(쳐내기)으로 처리해야 하는지
     */
    decide(perception, situation) {
        const p = perception;
        const urgency = situation.urgency ?? 0.5;

        switch (situation.type) {
            case GK_SITUATION.DISTRIBUTION:
                return { action: GK_DECISION.DISTRIBUTE, urgency, punch: false, reason: situation.reason };

            case GK_SITUATION.SHOT_FLIGHT:
                // 혼전·높은 볼은 펀칭으로 — 캐치 실패(튕김)보다 안전한 선택
                return {
                    action: GK_DECISION.DIVE_TRACK,
                    urgency,
                    punch: this._shouldPunch(p),
                    reason: situation.reason,
                };

            case GK_SITUATION.ONE_ON_ONE:
                return { action: GK_DECISION.RUSH, urgency, punch: false, reason: situation.reason };

            case GK_SITUATION.CROSS:
                // 크로스는 기본적으로 크레임 — 멀거나 늦으면 HOLD로 폴백은 Brain이 판단
                return {
                    action: GK_DECISION.CLAIM_CROSS,
                    urgency,
                    punch: this._shouldPunch(p),
                    reason: situation.reason,
                };

            case GK_SITUATION.AERIAL_CLAIM:
            case GK_SITUATION.GROUND_CLAIM:
                return {
                    action: GK_DECISION.CLAIM,
                    urgency,
                    punch: this._shouldPunch(p),
                    reason: situation.reason,
                };

            case GK_SITUATION.SECOND_BALL: {
                // 가까우면 캐치, 멀거나 상대가 먼저면 쓸어내기
                const canCatch = p.gkBallDist <= this.o.sweepCatchRadius + 7
                    && p.nearestOppBall > p.gkBallDist - 6;
                return {
                    action: canCatch ? GK_DECISION.CLAIM : GK_DECISION.SWEEP,
                    urgency,
                    punch: false,
                    reason: situation.reason,
                };
            }

            case GK_SITUATION.POSITIONING:
            default:
                return { action: GK_DECISION.HOLD, urgency, punch: false, reason: situation.reason };
        }
    }

    /**
     * 펀칭 조건 — 다음 중 하나라도 해당하면 캐치 대신 펀칭한다.
     * - 볼이 손 닿는 높이보다 높게 올 때 (높이 스케일 환산)
     * - 세이브·낙하지점 주변에 상대가 몰려 있을 때
     */
    _shouldPunch(p) {
        // 높이: Ball.height(0~1 스케일)를 m 느낌으로 환산 — 0.35 이상이면 머리 위
        const high = (p.ball.height ?? 0) > 0.35;
        if (high) return true;
        // 혼전: 볼 근처 상대가 코앞이면 펀칭이 안전
        if (p.nearestOppBall < this.o.punchCrowdDist) return true;
        // 궤적 목표가 포스트 근처(구석)면 뻗어 쳐내기
        const traj = p.shotTrajectory;
        if (traj && typeof traj.targetY === 'number') {
            const toTop = Math.abs(traj.targetY - p.goal.topY);
            const toBot = Math.abs(traj.targetY - p.goal.botY);
            if (Math.min(toTop, toBot) < 14) return true;
        }
        return false;
    }
}
