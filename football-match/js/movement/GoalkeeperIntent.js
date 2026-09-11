/**
 * GoalkeeperIntent - 골키퍼 의도 공통 모듈
 *
 * Decision을 받아 "어디로·어떤 방식으로"를 정한다.
 * 좌표·속도·상호작용 종류를 담은 Intent를 만들며,
 * 실제 이동(가속·회전)은 PlayerMovement가,
 * 볼 처리(캐치·펀칭·다이브)는 Brain + 기존 모듈이 수행한다.
 * (행동과 판단 분리 원칙)
 *
 * Intent 형태:
 *   { targetX, targetY, facingAngle, speed, interaction, urgency }
 * interaction:
 *   { type: 'none' | 'catch' | 'punch' | 'dive' | 'distribute' | 'clear' }
 */
import { GK_DECISION } from './GoalkeeperDecision.js';
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

const DEFAULTS = {
    maxDepth: 48,        // 기본 최대 전진 (GoalkeeperMovement와 동일)
    rushDepth: 150,      // 1:1 러시 최대 전진
    crossAdvance: 60,    // 크로스 대응 추가 전진
    lineMaxGap: 260,     // 수비 라인과 최대 간격 (이보다 벌어지면 라인 쪽으로 당김)
    lineMinGap: 60,      // 수비 라인과 최소 간격 (이보다 좁히지 않음)
    catchRadius: 11,
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class GoalkeeperIntent {
    /**
     * @param {object} options
     *   ownGoalX {number} 자기 골라인 X
     *   dir      {number} 팀 공격 방향
     */
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this.ownGoalX = options.ownGoalX ?? 0;
        this.dir = options.dir ?? 1;
    }

    /**
     * @param {object} p        Perception 스냅샷
     * @param {object} decision Decision 결과 { action, urgency, punch }
     * @param {object} base     기본 위치 { x, y } (GoalkeeperMovement 결과)
     * @returns {object} Intent
     */
    create(p, decision, base) {
        const o = this.o;
        const urgency = decision.urgency ?? 0.5;

        // 기본값 — 골대 기준 위치 + 공 추적 facing
        let tx = base?.x ?? this.ownGoalX;
        let ty = base?.y ?? p.goal.centerY;
        let speed = SPEEDS[2];
        let interaction = { type: 'none' };

        switch (decision.action) {
            case GK_DECISION.DISTRIBUTE:
                // 배급 중에는 제자리 유지 — 움직임은 Distribution이 볼만 다룬다
                tx = p.gk.x; ty = p.gk.y;
                speed = SPEEDS[0];
                interaction = { type: 'distribute' };
                break;

            case GK_DECISION.DIVE_TRACK: {
                // 다이빙 추적 — 세이브 지점이 있으면 그쪽으로, 없으면 슛 방향으로
                const traj = p.shotTrajectory;
                if (traj && typeof traj.targetY === 'number') {
                    tx = base?.x ?? tx;
                    ty = clamp(traj.targetY, p.goal.topY - 12, p.goal.botY + 12);
                }
                speed = SPEEDS[4];
                interaction = decision.punch
                    ? { type: 'punch' }
                    : { type: 'dive' };
                break;
            }

            case GK_DECISION.RUSH: {
                // 1:1 대응 — 소유자와 골대 사이로 전진해 각도를 좁힌다
                const owner = p.owner ?? p.ball;
                // 소유자 쪽으로 골라인에서 전진 (sweeper 제한은 Brain이 클램프)
                const rushX = owner.x - this.dir * 26;
                const rushY = (owner.y + p.goal.centerY) / 2;
                tx = this.dir > 0 ? Math.max(base.x, Math.min(rushX, this.ownGoalX + this.dir * o.rushDepth))
                                  : Math.min(base.x, Math.max(rushX, this.ownGoalX + this.dir * o.rushDepth));
                ty = clamp(rushY, p.goal.topY - 30, p.goal.botY + 30);
                speed = SPEEDS[4];
                interaction = { type: 'none' };
                break;
            }

            case GK_DECISION.CLAIM_CROSS: {
                // 크로스 대응 — 낙하지점 선점 + 전진
                const land = p.landing ?? p.ball;
                tx = land.x - this.dir * 8;
                ty = land.y;
                speed = SPEEDS[4];
                interaction = decision.punch ? { type: 'punch' } : { type: 'catch' };
                break;
            }

            case GK_DECISION.CLAIM: {
                // 공중볼·지면볼 캐치 — 볼(또는 낙하지점)으로
                const dest = (p.aerial && p.landing) ? p.landing : p.ball;
                tx = dest.x; ty = dest.y;
                speed = urgency >= 0.9 ? SPEEDS[4] : SPEEDS[3];
                interaction = decision.punch ? { type: 'punch' } : { type: 'catch' };
                break;
            }

            case GK_DECISION.SWEEP: {
                // 세컨드볼 쓸어내기 — 볼 위치로 전력 질주 후 클리어
                tx = p.ball.x; ty = p.ball.y;
                speed = SPEEDS[4];
                interaction = { type: 'clear' };
                break;
            }

            case GK_DECISION.HOLD:
            default: {
                // 기본 위치 선정 — base 그대로, 수비 라인 연계만 보정
                speed = urgency > 0.7 ? SPEEDS[3] : urgency > 0.4 ? SPEEDS[2] : SPEEDS[1];
                interaction = { type: 'none' };
                break;
            }
        }

        // 수비 라인 연계 — 라인과의 간격이 벌어지면 라인 쪽으로 당긴다
        if (p.defenseLineX !== null && p.defenseLineX !== undefined) {
            const gap = (p.defenseLineX - tx) * this.dir;
            if (gap > o.lineMaxGap) {
                tx = p.defenseLineX - this.dir * o.lineMaxGap;
            } else if (gap < 0) {
                // 라인이 골키퍼보다 뒤(골 쪽)에 있으면 최소 간격 유지
                tx = Math.min(tx, p.defenseLineX - this.dir * o.lineMinGap * 0.2);
            }
        }

        return {
            targetX: tx,
            targetY: ty,
            facingAngle: p.facingAngle,
            speed,
            interaction,
            urgency,
            action: decision.action,
        };
    }
}
