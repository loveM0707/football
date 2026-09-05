/**
 * AerialDuel - 헤딩 경합 공통 모듈
 *
 * 8. 헤딩 경합을 전담한다.
 * 같은 공중볼을 노리는 N명의 선수 중 누가 헤딩하는지를 판정한다.
 *
 * 기존에 2곳(HeadingSystem.resolveAerialDuel·ThreeVsThree 인라인 roll)에
 * 흩어져 있던 위치+랜덤 판정을 이 모듈 하나로 통합한다.
 *
 * 판정 요소 (11v11 재사용 가능):
 * - 위치: 낙하지점에 가까울수록 유리
 * - 타이밍: 점프를 이미 썼는지·접촉 창구에 있는지
 * - 체격·능력: headingAbility (없으면 0.5)
 * - 확률: ±15% 랜덤 (매번 같은 결과가 나오지 않게)
 */
const DEFAULTS = {
    posWeight: 0.55,    // 위치 비중
    timeWeight: 0.15,   // 타이밍 비중 (점프 준비 여부)
    abilityWeight: 0.30,// 능력 비중
    maxDist: 90,        // 이 밖이면 경합 참가 불가
    jitter: 0.15,       // 랜덤 폭 (±15%)
};

function rand(a, b) { return a + Math.random() * (b - a); }

export class AerialDuel {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * 경합 참가자를 추린다 (낙하지점 반경 안만 참가).
     * @param {Array} contenders [{ player, jumpBoost, ability }]
     * @param {object} landing { x, y }
     * @returns {Array} 참가자 [{ player, dist, posScore, timeScore, ability, ... }]
     */
    rank(contenders, landing) {
        const o = this.o;
        const scored = [];
        for (const c of contenders) {
            const dist = Math.hypot(c.player.x - landing.x, c.player.y - landing.y);
            if (dist > o.maxDist) continue;
            const posScore = Math.max(0, 1 - dist / o.maxDist);
            // 타이밍: 점프 체공 중이거나 접촉 창구면 가점
            const timeScore = c.contact ? 1 : c.jumpBoost > 0.3 ? 0.8 : 0.4;
            const ability = c.ability ?? 0.5;
            const score = posScore * o.posWeight
                + timeScore * o.timeWeight
                + ability * o.abilityWeight;
            scored.push({ ...c, dist, posScore, timeScore, ability, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    /**
     * 승자를 판정한다.
     * @param {Array} contenders [{ player, jumpBoost, contact, ability }]
     * @param {object} landing { x, y }
     * @returns {null | { winner, runnerUp, power, ranked }}
     */
    resolve(contenders, landing) {
        const ranked = this.rank(contenders, landing);
        if (ranked.length === 0) return null;
        if (ranked.length === 1) {
            return {
                winner: ranked[0].player,
                runnerUp: null,
                contested: false,
                power: this._power(ranked[0]),
                ranked,
            };
        }
        // 상위 2명의 지터 대결 — 위치가 좋아도 항상 이기지는 않는다
        const [a, b] = ranked;
        const rollA = a.score * rand(1 - this.o.jitter, 1 + this.o.jitter);
        const rollB = b.score * rand(1 - this.o.jitter, 1 + this.o.jitter);
        const win = rollA >= rollB ? a : b;
        const lose = win === a ? b : a;
        return {
            winner: win.player,
            runnerUp: lose.player,
            contested: true,
            power: this._power(win),
            ranked,
        };
    }

    /** 헤딩 파워 — 낙하지점에 정확히 있을수록 강하게 맞는다 */
    _power(entry) {
        return 150 + entry.posScore * 200 + entry.ability * 100;
    }
}
