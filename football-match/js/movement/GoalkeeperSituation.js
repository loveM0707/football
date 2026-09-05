/**
 * GoalkeeperSituation - 골키퍼 상황 평가 공통 모듈
 *
 * Perception 스냅샷을 받아 "지금이 어떤 상황인지"를 판정한다.
 * 특정 슈팅·크로스 시나리오에 종속되지 않으며,
 * 11v11 실제 경기에서도 그대로 쓸 수 있는 상황 분류만 담는다.
 *
 * 상황 우선순위 (위에서부터 먼저 성립 확인):
 *   DISTRIBUTION  볼을 품고 있음 → 배급
 *   SHOT_FLIGHT   슛이 골문을 향해 비행 중 → 다이빙 추적
 *   ONE_ON_ONE    상대 소유로 골전 근접 → 1:1 대응
 *   CROSS         측면 공중볼이 박스로 → 크로스 대응
 *   AERIAL_CLAIM  박스 안 공중볼 낙하지점 도달 가능 → 공중볼 대응
 *   GROUND_CLAIM  박스 안 느린 지면볼 → 캐치 회수
 *   SECOND_BALL   박스 근처 무소유 루즈볼 → 세컨드볼 대응
 *   POSITIONING   그 외 → 기본 위치 선정
 */
export const GK_SITUATION = Object.freeze({
    DISTRIBUTION: 'distribution',
    SHOT_FLIGHT: 'shot-flight',
    ONE_ON_ONE: 'one-on-one',
    CROSS: 'cross',
    AERIAL_CLAIM: 'aerial-claim',
    GROUND_CLAIM: 'ground-claim',
    SECOND_BALL: 'second-ball',
    POSITIONING: 'positioning',
});

const DEFAULTS = {
    oneOnOneDist: 260,   // 소유자가 이보다 가까우면 1:1로 본다
    oneOnOneBoxOnly: false, // 박스 밖 1:1도 허용 (스위퍼 대응은 Brain에서 제한)
    aerialRushRadius: 175,  // 낙하지점까지 나갈 수 있는 최대 거리
    rivalMargin: 18,        // 상대보다 이만큼은 먼저 닿아야 한다
    groundSlowSpeed: 175,   // 이보다 느린 지면볼은 회수 대상
    rushRadius: 105,        // 지면볼을 향해 나갈 수 있는 최대 거리
    secondBallRadius: 200,  // 세컨드볼 대응 반경 (박스 + 주변)
};

export class GoalkeeperSituation {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * 상황을 평가한다.
     * @param {object} p Perception 스냅샷
     * @param {object} extra { gkHasBall: boolean, locked: boolean }
     * @returns {{ type: string, urgency: number, reason: string }}
     */
    evaluate(p, extra = {}) {
        const o = this.o;

        // 1. 배급 — 볼을 품고 있으면 다른 판단은 하지 않는다
        if (extra.gkHasBall) {
            return { type: GK_SITUATION.DISTRIBUTION, urgency: 1, reason: '볼 소유 중' };
        }
        // 배급 직후 잠금 구간에는 클레임 계열을 건너뛴다 (자기 패스 되잡기 방지)
        const locked = Boolean(extra.locked);

        // 2. 슛 비행 — 골문을 향한 궤적이 있으면 최우선 추적
        const traj = p.shotTrajectory;
        if (traj) {
            const onTarget = this._trajOnTarget(traj, p.goal);
            if (onTarget) {
                return { type: GK_SITUATION.SHOT_FLIGHT, urgency: 1, reason: '슛 비행 중' };
            }
        }

        // 소유 중인 볼은 클레임/세컨드볼 대상이 아니다
        const owned = Boolean(p.owner);

        // 3. 1:1 — 상대가 소유하고 골전에 가까우면 좁히기 대응
        if (p.ownerIsOpponent && p.ownerDistGoal < o.oneOnOneDist) {
            // 긴급도: 가까울수록 1에 수렴
            const urgency = Math.max(0.5, Math.min(1, 1 - p.ownerDistGoal / (o.oneOnOneDist * 1.6) + 0.4));
            return { type: GK_SITUATION.ONE_ON_ONE, urgency, reason: '상대 돌파 근접' };
        }

        // 4. 크로스 — 측면 공중볼이 박스로 오면 크로스 대응
        if (p.crossLike && !owned && !locked) {
            return { type: GK_SITUATION.CROSS, urgency: 1, reason: '측면 크로스' };
        }

        // 5. 공중볼 클레임 — 낙하지점이 박스 안이고 먼저 닿을 수 있으면
        if (p.aerial && p.landing && p.landingInBox && !owned && !locked) {
            const gkToLand = Math.hypot(p.gk.x - p.landing.x, p.gk.y - p.landing.y);
            if (gkToLand <= o.aerialRushRadius) {
                return { type: GK_SITUATION.AERIAL_CLAIM, urgency: 0.9, reason: '공중볼 낙하' };
            }
        }

        // 6. 지면볼 클레임 — 박스 안 느린 볼은 직접 회수
        if (!p.aerial && p.ballInBox && !owned && !locked) {
            const slow = p.ballSpeed < o.groundSlowSpeed;
            const stillNear = p.ballSpeed < 3 && p.gkBallDist < o.rushRadius;
            if ((slow || stillNear) && p.gkBallDist <= o.rushRadius) {
                const urgency = p.ballSpeed < 3 ? 0.6 : 1;
                return { type: GK_SITUATION.GROUND_CLAIM, urgency, reason: '박스 안 지면볼' };
            }
        }

        // 7. 세컨드볼 — 박스 근처 무소유 루즈볼 (튕긴 볼·클리어 잔볼)
        if (!owned && !p.aerial && !locked) {
            const nearBox = p.ballGoalDist <= o.boxDepth + o.secondBallRadius * 0.5;
            const reachable = p.gkBallDist <= o.secondBallRadius;
            const loose = p.ballSpeed < 320;
            if (nearBox && reachable && loose) {
                // 상대가 압도적으로 가까우면 무리하지 않는다 — Brain에서 최종 확인
                return { type: GK_SITUATION.SECOND_BALL, urgency: 0.7, reason: '세컨드볼' };
            }
        }

        // 8. 기본 위치 선정
        const urgency = p.towardGoal ? 0.8 : p.ballGoalDist < 320 ? 0.5 : 0.25;
        return { type: GK_SITUATION.POSITIONING, urgency, reason: '기본 위치' };
    }

    /** 궤적 목표가 골문 안인지 (높이는 ShotMovement가 판정하므로 Y만 본다) */
    _trajOnTarget(traj, goal) {
        const y = traj.targetY ?? traj.y ?? null;
        if (y === null) return true; // 목표 불명 — 추적 우선
        return y >= goal.topY - 4 && y <= goal.botY + 4;
    }
}
