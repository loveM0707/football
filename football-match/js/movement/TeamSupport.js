/**
 * TeamSupport - 팀 지원 전술 공통 모듈
 *
 * 공 주변의 국소 전술을 순수 계산으로 제공한다 (이동은 수행하지 않음).
 * N명 인원에 대해 동작하므로 4v4→11v11 그대로 재사용된다.
 *
 * 담당 (구현 대상 6~13):
 *   6. 패스 옵션 생성 — 캐리어 기준 순위 산출
 *   7. 지원 — 근거리에 패스 각도 제공
 *   8. 커버 — 최후방의 골사이드 보호
 *   9. 압박 — 근접 시 볼 압박 트리거
 *   10. 수적 우위 활용 — 여유 인원의 전방 침투
 *   11. 수적 열세 대응 — 지연 + 컴팩트 신호
 *   12. 공 주변 삼각형 형성 — 최적 2명 선정
 *   13. 패스 후 이동 — 패서의 전방 런 목표
 *
 * 패스 레인 개방도는 Geometry.segmentClearance를 재사용한다 (중복 구현 금지).
 */
import { segmentClearance } from './Geometry.js';

const DEFAULTS = {
    dir: 1,
    nearRadius: 150,        // 공 주변 판정 반경
    supportDist: 100,       // 지원 거리
    pressTrigger: 130,      // 압박 트리거 거리
    triMin: 70,             // 삼각형 변 하한
    triMax: 170,            // 삼각형 변 상한
    minX: 25,
    maxX: 1025,
    yMin: 45,
    yMax: 635,
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export class TeamSupport {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * 6. 패스 옵션을 순위대로 반환한다.
     * @param {object} carrier {x,y}
     * @param {Array} mates 후보 (Player 배열)
     * @param {Array} opponents 상대 배열
     * @param {object} ctx { dir, attackGoalX }
     * @returns {Array} [{ player, score, openness, forwardness }] 내림차순
     */
    passOptions(carrier, mates, opponents, ctx = {}) {
        const dir = ctx.dir ?? this.o.dir;
        const attackGoalX = ctx.attackGoalX ?? 1050;
        const scored = mates.map((p) => {
            const forwardness = clamp(dir * (p.x - carrier.x) / 200, -1, 1.5);
            let nearestOpp = Infinity;
            for (const opp of opponents) {
                nearestOpp = Math.min(nearestOpp, Math.hypot(opp.x - p.x, opp.y - p.y));
            }
            const openness = clamp(nearestOpp / 120, 0, 1);
            // 레인 개방도 — Geometry 공통 함수 재사용
            const lane = segmentClearance(opponents, carrier.x, carrier.y, p.x, p.y);
            const laneOpen = clamp(lane / 60, 0, 1);
            // 박스 안 동료 가점 (마무리 연결)
            const boxBonus = Math.abs(attackGoalX - p.x) < 260 ? 0.25 : 0;
            const score = forwardness * 0.5 + openness * 0.35 + laneOpen * 0.15 + boxBonus;
            return { player: p, score, openness, forwardness, laneOpen };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    /**
     * 12. 공 주변 최적 삼각형을 이룰 2명을 선정한다.
     * @returns {null | { a, b, quality }} quality 0~1
     */
    triangles(carrier, mates, opponents) {
        const o = this.o;
        const near = mates.filter((p) => {
            const d = dist(p, carrier);
            return d >= o.triMin && d <= o.triMax;
        });
        if (near.length < 2) return null;
        let best = null;
        for (let i = 0; i < near.length; i++) {
            for (let j = i + 1; j < near.length; j++) {
                const a = near[i], b = near[j];
                // 캐리어 기준 두 선수의 각도 분리 — 60~120도가 이상적
                const angA = Math.atan2(a.y - carrier.y, a.x - carrier.x);
                const angB = Math.atan2(b.y - carrier.y, b.x - carrier.x);
                let sep = Math.abs(angA - angB) * 180 / Math.PI;
                if (sep > 180) sep = 360 - sep;
                const angleScore = sep >= 60 && sep <= 120 ? 1
                    : sep >= 40 && sep <= 150 ? 0.6 : 0.2;
                // 압박 하 삼각형 가점 — 상대가 붙어 있을수록 통과선 가치 상승
                let pressNear = 0;
                for (const opp of opponents) {
                    if (Math.hypot(opp.x - carrier.x, opp.y - carrier.y) < o.nearRadius) pressNear++;
                }
                const quality = angleScore * 0.7 + clamp(pressNear / 3, 0, 1) * 0.3;
                if (!best || quality > best.quality) best = { a, b, quality };
            }
        }
        return best;
    }

    /**
     * 8. 커버 목표 — 최후방 1명의 골사이드 위치.
     * @returns {{ player, x, y } | null}
     */
    coverTarget(mates, ball, ownGoal) {
        if (mates.length === 0) return null;
        // 골에 가장 가까운 선수가 커버 담당
        let cover = mates[0], bd = Infinity;
        for (const p of mates) {
            const d = Math.hypot(p.x - ownGoal.x, p.y - ownGoal.y);
            if (d < bd) { bd = d; cover = p; }
        }
        const dx = ownGoal.x - ball.x, dy = ownGoal.y - ball.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const t = 0.3; // 볼-골 사이 30% 지점
        return {
            player: cover,
            x: clamp(ball.x + dx * t, this.o.minX, this.o.maxX),
            y: clamp(ball.y + dy * t, this.o.yMin, this.o.yMax),
        };
    }

    /**
     * 9. 압박 트리거 — 볼에 가장 가까운 1명, 조건 충족 시에만.
     * @returns {{ player, x, y } | null}
     */
    pressTarget(mates, ball) {
        if (mates.length === 0) return null;
        let best = mates[0], bd = Infinity;
        for (const p of mates) {
            const d = Math.hypot(p.x - ball.x, p.y - ball.y);
            if (d < bd) { bd = d; best = p; }
        }
        if (bd > this.o.pressTrigger) return null;
        return { player: best, x: ball.x, y: ball.y };
    }

    /**
     * 10·11. 수적 우열 판정 — 공 주변 150 반경 인원 비교.
     * @returns {{ mine, theirs, verdict: 'overload'|'even'|'underload' }}
     */
    numbersAround(ball, mates, opponents) {
        const o = this.o;
        let mine = 0, theirs = 0;
        for (const p of mates) {
            if (Math.hypot(p.x - ball.x, p.y - ball.y) < o.nearRadius) mine++;
        }
        for (const p of opponents) {
            if (Math.hypot(p.x - ball.x, p.y - ball.y) < o.nearRadius) theirs++;
        }
        const verdict = mine > theirs ? 'overload' : mine < theirs ? 'underload' : 'even';
        return { mine, theirs, verdict };
    }

    /**
     * 13. 패스 후 이동 — 패서는 전방으로 런한다 (give-and-go 골격).
     * @returns {{ x, y }}
     */
    passAndGo(passer, receiver, ctx = {}) {
        const o = this.o;
        const dir = ctx.dir ?? o.dir;
        return {
            x: clamp(passer.x + dir * 110, o.minX, o.maxX),
            y: clamp(receiver.y + (passer.y < receiver.y ? -35 : 35), o.yMin, o.yMax),
        };
    }
}
