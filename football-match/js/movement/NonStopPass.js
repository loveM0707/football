/**
 * NonStopPass - 원터치 논스톱 패스 결정 모듈
 *
 * 수신자의 발에 공이 닿은 순간 다음 패스 방향으로 몸을 돌리고,
 * 호출자가 전달한 패스 콜백을 같은 프레임에 실행한다.
 * 수비수가 가까울수록 논스톱 패스 선택 확률이 높아진다.
 */
import { angleTo } from './Direction.js';

const DEFAULT_BASE_CHANCE = 0.22;
const DEFAULT_PRESSURE_DISTANCE = 110;
const DEFAULT_PRESSURE_BONUS = 0.55;
const DEFAULT_MAX_CHANCE = 0.82;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function playerOf(defender) {
    return defender?.player ?? defender;
}

export class NonStopPass {
    /**
     * @param {object} [options]
     *   baseChance       {number} 수비 압박이 없을 때 기본 확률
     *   pressureDistance {number} 이 거리부터 압박 보너스가 적용되는 거리
     *   pressureBonus    {number} 최대 압박 보너스
     *   maxChance        {number} 최종 확률 상한
     */
    constructor(options = {}) {
        this._baseChance = options.baseChance ?? DEFAULT_BASE_CHANCE;
        this._pressureDistance = options.pressureDistance ?? DEFAULT_PRESSURE_DISTANCE;
        this._pressureBonus = options.pressureBonus ?? DEFAULT_PRESSURE_BONUS;
        this._maxChance = options.maxChance ?? DEFAULT_MAX_CHANCE;
    }

    /** 수신자와 가장 가까운 수비수까지의 거리를 반환한다. */
    nearestDefenderDistance(receiver, defenders = []) {
        let nearest = Infinity;
        for (const defender of defenders) {
            const player = playerOf(defender);
            if (!player) continue;
            nearest = Math.min(nearest, Math.hypot(player.x - receiver.x, player.y - receiver.y));
        }
        return nearest;
    }

    /** 현재 상황의 논스톱 패스 확률을 반환한다. */
    probability(receiver, defenders = []) {
        const nearest = this.nearestDefenderDistance(receiver, defenders);
        if (!Number.isFinite(nearest)) return clamp(this._baseChance, 0, this._maxChance);

        const pressure = clamp(1 - nearest / this._pressureDistance, 0, 1);
        return clamp(this._baseChance + pressure * this._pressureBonus, 0, this._maxChance);
    }

    /**
     * 논스톱 패스를 시도한다.
     * @returns {boolean} 이번 수신에서 논스톱 패스를 실행했는지 여부
     */
    tryPass({ receiver, target, defenders = [], onPass }) {
        if (!receiver || !target || typeof onPass !== 'function') return false;

        const chance = this.probability(receiver, defenders);
        if (Math.random() >= chance) return false;

        // 일반 회전 관성보다 먼저 방향을 확정해 발을 댄 즉시 킥한다.
        const angle = angleTo(receiver.x, receiver.y, target.x, target.y);
        receiver.setAngle(angle);
        onPass({ angle, chance });
        return true;
    }
}
