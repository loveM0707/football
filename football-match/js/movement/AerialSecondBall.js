/**
 * AerialSecondBall - 세컨드볼 대응 공통 모듈
 *
 * 10. 세컨드볼 대응을 전담한다.
 * 헤딩·펀칭·포스트 등으로 튄 볼을 누가 회수하러 가는지를 정한다.
 * (Decision + Intent — 실제 이동은 호출자가 PlayerMovement로 수행한다)
 *
 * 기존 HeadingSystem.findSecondBallReactor는 있었지만
 * 시나리오에서 호출하지 않아 사장되어 있었다.
 * 이 모듈이 그 역할을 이어받으며, 공중·바운드·지면 잔볼을 모두 다룬다.
 */
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS;

const DEFAULTS = {
    radius: 220,            // 반응 반경 (SVG)
    reactionDelay: 0.15,    // 반응 지연 (초)
    approachSpeed: SPEEDS[3],
};

export class AerialSecondBall {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * @param {object} ball 공 { x, y }
     * @param {Array} players 후보 선수 배열 (Player 엔티티)
     * @param {object} options { team, exclude:Set }
     * @returns {null | { reactor, reactionTime, targetX, targetY, speed }}
     */
    find(ball, players, options = {}) {
        const o = this.o;
        const team = options.team ?? null;
        const exclude = options.exclude ?? null;
        let best = null;
        let bestTime = Infinity;

        for (const p of players) {
            if (team && p.team !== team) continue;
            if (exclude && exclude.has(p)) continue;
            const dist = Math.hypot(ball.x - p.x, ball.y - p.y);
            if (dist > o.radius) continue;
            const total = o.reactionDelay + dist / o.approachSpeed;
            if (total < bestTime) {
                bestTime = total;
                best = p;
            }
        }
        if (!best) return null;
        return {
            reactor: best,
            reactionTime: bestTime,
            targetX: ball.x,
            targetY: ball.y,
            speed: SPEEDS[4],
        };
    }
}
