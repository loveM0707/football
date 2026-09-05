/**
 * OverloadAssessment - 수적 우위 상황 평가 공통 모듈
 *
 * "지금 수적 우위인가, 프리맨은 누구인가, 패스 레인은 열려 있는가"를
 * 인원수 무관(NvM)하게 평가한다. 2v1은 물론 3v2·4v3·11v10에서도 같은
 * 입력({ carrier, mates[], opponents[] })으로 호출한다.
 *
 * 순수 판단 모듈이다 — 이동·킥을 수행하지 않고 상황만 반환한다.
 * 행동 선택은 AttackChoice가, 이동 실행은 각 Decision/시나리오가 담당한다.
 *
 * 재사용 (중복 구현 금지):
 *   - 동료 순위 = TeamSupport.passOptions (전진성·개방도·레인·박스 보너스)
 *   - 레인 개방 = Geometry.segmentClearance / distPointToSegment
 *   - 프리맨 거리 = PassAccuracy.nearestOpponent
 */
import { segmentClearance, distPointToSegment } from './Geometry.js';
import { TeamSupport } from './TeamSupport.js';
import { PassAccuracy } from './PassAccuracy.js';

const DEFAULTS = {
    dir: 1,             // 공격 방향 (+1 = 오른쪽 골 공격)
    nearRadius: 150,    // 수적 우열 판정 반경 (TeamSupport와 동일 기준)
    laneBand: 45,       // 캐리어→동료 선분에서 이 안이면 "레인에 있음"
    // passLaneMin(AttackChoice, 기본 28)보다 크게 — "차단(<28)"과
    // "레인에 있음(<45)"을 구분해야 유인 드리블(draw-defender)이 성립한다
    commitDist: 70,     // 캐리어에게 이보다 가까우면 "홀더에 붙음" (압박 거리 기준)
    // 70~laneBand 사이에서 레인을 지키면 "붙지 않고 막음" → 유인 드리블 대상
    freeScale: 120,     // 프리맨 정규화 거리 (TeamSupport openness와 동일)
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class OverloadAssessment {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this._support = new TeamSupport({
            dir: this.o.dir,
            nearRadius: this.o.nearRadius,
        });
    }

    /**
     * @param {object} ctx
     *   carrier     {x,y}       볼 소유자
     *   mates       {Array}     [{ player:{x,y}, idx }] 소유자 제외 동료 (1~10명)
     *   opponents   {Array}     [{x,y}] 상대 (1~10명)
     *   ball        {x,y}       볼 위치 (기본 carrier)
     *   dir         {number}    공격 방향 (기본 생성자)
     *   attackGoalX {number}    공격 골라인 X (기본 1050)
     * @returns {object}
     *   numbers { mine, theirs, verdict: 'overload'|'even'|'underload' }
     *     mine은 소유자 포함. 반경 밖 인원은 세지 않는다.
     *   mates   [{ player, idx, score, openness, forwardness, laneOpen,
     *              lane(레인 원시 거리 SVG), freedom(0~1), dist,
     *              gain(공격 방향 전진 이득 SVG, 후방이면 음수) }] 점수 내림차순
     *   defender { player, distToCarrier, onHolder, inLane } | null
     *     onHolder: 홀더 압박 중 / inLane: 최우선 동료 레인 차단 중
     *   spaceAhead {number} 볼 전방 열린 공간 (상대 없으면 Infinity)
     */
    assess(ctx) {
        const o = this.o;
        const carrier = ctx.carrier;
        const mates = ctx.mates ?? [];
        const opponents = ctx.opponents ?? [];
        const ball = ctx.ball ?? carrier;
        const dir = ctx.dir ?? o.dir;
        const attackGoalX = ctx.attackGoalX ?? 1050;

        // ── 수적 우열 (소유자 포함) ──
        let mine = 1; // carrier
        for (const m of mates) {
            if (Math.hypot(m.player.x - ball.x, m.player.y - ball.y) < o.nearRadius) mine++;
        }
        let theirs = 0;
        for (const p of opponents) {
            if (Math.hypot(p.x - ball.x, p.y - ball.y) < o.nearRadius) theirs++;
        }
        const verdict = mine > theirs ? 'overload' : mine < theirs ? 'underload' : 'even';

        // ── 동료 순위 (TeamSupport 기준) + 프리맨·레인 원시값 ──
        const ranked = this._support.passOptions(
            carrier, mates.map(m => m.player), opponents, { dir, attackGoalX });
        // passOptions는 player 배열을 받으므로 idx를 좌표로 역매핑한다
        const enriched = ranked.map(r => {
            const src = mates.find(m => m.player === r.player)
                ?? mates.find(m => m.player.x === r.player.x && m.player.y === r.player.y);
            const lane = segmentClearance(opponents, carrier.x, carrier.y, r.player.x, r.player.y);
            const nearestOpp = PassAccuracy.nearestOpponent(r.player, opponents);
            const freedom = clamp((nearestOpp ?? Infinity) / o.freeScale, 0, 1);
            return {
                player: r.player,
                idx: src ? src.idx : -1,
                score: r.score, openness: r.openness,
                forwardness: r.forwardness, laneOpen: r.laneOpen,
                lane, freedom,
                dist: Math.hypot(r.player.x - carrier.x, r.player.y - carrier.y),
                gain: dir * (r.player.x - carrier.x),
            };
        });

        // ── 수비수 상태: 홀더 압박 vs 레인 차단 ──
        let defender = null;
        if (opponents.length > 0) {
            let best = opponents[0], bd = Infinity;
            for (const p of opponents) {
                const d = Math.hypot(p.x - carrier.x, p.y - carrier.y);
                if (d < bd) { bd = d; best = p; }
            }
            let inLane = false;
            if (enriched.length > 0) {
                const m0 = enriched[0];
                inLane = distPointToSegment(best.x, best.y,
                    carrier.x, carrier.y, m0.player.x, m0.player.y) < o.laneBand;
            }
            defender = {
                player: best,
                distToCarrier: bd,
                onHolder: bd < o.commitDist,
                inLane,
            };
        }

        // ── 전방 공간 (TransitionDecision과 동일 방식) ──
        let spaceAhead = Infinity;
        for (const p of opponents) {
            const gain = dir * (p.x - ball.x);
            if (gain > -20 && gain < spaceAhead) spaceAhead = gain;
        }

        return { numbers: { mine, theirs, verdict }, mates: enriched, defender, spaceAhead };
    }
}
