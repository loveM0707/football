/**
 * TransitionIntent - 전환 의도 공통 모듈
 *
 * Decision을 받아 선수별 역할·목표·속도를 정한다.
 * (Player Role 재평가 → Movement Intent 변경)
 *
 * 역할:
 *   DRIVE     3. 탈취 직후 전진 (볼 획득자)
 *   PRESS     4. 상실 직후 압박 (가장 가까운 1~2명)
 *   RUN       5. 역습 침투 (전방 런)
 *   SWARM     6. 역압박 포위 (볼 주변 2~3명)
 *   DELAY     7. 상대 역습 지연 (볼-골 사이)
 *   REALIGN   8. 수비 라인 재정렬 (골 사이드 복귀)
 *   RESHAPE   9. 공격 진형 재구성 (폭·깊이 — OffBallDecision 재사용)
 *
 * N명 인원에 대해 동작하므로 11v11 그대로 재사용 가능하다.
 * 실제 이동은 호출자가 PlayerMovement로 수행한다 (순수 의도 모듈).
 */
import { PlayerMovement } from './PlayerMovement.js';
import { OffBallDecision } from './OffBallDecision.js';

const SPEEDS = PlayerMovement.SPEEDS;

export const TRANSITION_ROLE = Object.freeze({
    DRIVE: 'drive',
    PRESS: 'press',
    RUN: 'run',
    SWARM: 'swarm',
    DELAY: 'delay',
    REALIGN: 'realign',
    RESHAPE: 'reshape',
});

const DEFAULTS = {
    driveDist: 130,     // 탈취 후 전진 거리
    pressDist: 26,      // 압박 목표 간격 (볼-골 사이드)
    swarmN: 3,          // 역압박 포위 인원
    pressN: 2,          // 상실 직후 압박 인원
    runN: 2,            // 역습 침투 인원
    lineDepth: 120,     // 재정렬 라인 깊이 (골에서 앞)
    dir: 1,
    attackGoalX: 1050,
    ownGoalX: 0,
    centerY: 340,
    minX: 25,
    maxX: 1025,
    yMin: 45,
    yMax: 635,
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class TransitionIntent {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this._offBall = new OffBallDecision({
            dir: this.o.dir,
            attackGoalX: this.o.attackGoalX,
            centerY: this.o.centerY,
        });
    }

    /**
     * 공격 전환 의도를 만든다 (3 · 5 · 9).
     * @param {object} ctx
     *   carrier {Player} 볼 획득자, mates {Array<Player>} (캐리어 제외),
     *   opponents, dir, decision ('counter' | 'buildup'), clock
     * @returns {Array} [{ player, role, targetX, targetY, speed }]
     */
    attackIntents(ctx = {}) {
        const o = this.o;
        const dir = ctx.dir ?? o.dir;
        const carrier = ctx.carrier;
        const mates = ctx.mates ?? [];
        const opponents = ctx.opponents ?? [];
        const isCounter = (ctx.decision ?? 'buildup') === 'counter';
        const out = [];

        // 3. 탈취 직후 전진 — 획득자는 앞 공간으로 몰고 간다
        if (carrier) {
            out.push({
                player: carrier,
                role: TRANSITION_ROLE.DRIVE,
                targetX: clamp(carrier.x + dir * o.driveDist, o.minX, o.maxX),
                targetY: clamp(carrier.y, o.yMin, o.yMax),
                speed: SPEEDS[4],
            });
        }

        if (!isCounter) {
            // 9. 지공 재구성 — OffBallDecision 재사용 (중복 구현 금지)
            const shaped = this._offBall.evaluate({
                carrier,
                mates: mates.map((p, i) => ({ player: p, idx: i })),
                opponents,
                clock: ctx.clock ?? 0,
            });
            shaped.forEach((s, k) => {
                out.push({
                    player: mates[k],
                    role: TRANSITION_ROLE.RESHAPE,
                    targetX: s.targetX, targetY: s.targetY, speed: s.speed,
                });
            });
            return out;
        }

        // 5. 역습 침투 — 볼에서 가장 먼 앞쪽 2명을 전방 런으로
        const ranked = [...mates].sort((a, b) => dir * (b.x - a.x));
        ranked.forEach((p, k) => {
            if (k < o.runN) {
                out.push({
                    player: p,
                    role: TRANSITION_ROLE.RUN,
                    targetX: clamp(p.x + dir * 160, o.minX, o.maxX),
                    targetY: clamp(k === 0 ? o.centerY - 55 : o.centerY + 55, o.yMin, o.yMax),
                    speed: SPEEDS[4],
                });
            } else {
                out.push({
                    player: p,
                    role: TRANSITION_ROLE.RESHAPE,
                    targetX: clamp(carrier.x + dir * 75, o.minX, o.maxX),
                    targetY: clamp(carrier.y + (p.y < carrier.y ? -95 : 95), o.yMin, o.yMax),
                    speed: SPEEDS[3],
                });
            }
        });
        return out;
    }

    /**
     * 수비 전환 의도를 만든다 (4 · 6 · 8).
     * @param {object} ctx
     *   ball {x,y}, mates {Array<Player>}, dir, ownGoalX,
     *   decision ('counterpress' | 'fallback')
     * @returns {Array} [{ player, role, targetX, targetY, speed }]
     */
    defenseIntents(ctx = {}) {
        const o = this.o;
        const dir = ctx.dir ?? o.dir;
        const ball = ctx.ball;
        const mates = [...(ctx.mates ?? [])].sort(
            (a, b) => Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y),
        );
        const isPress = (ctx.decision ?? 'fallback') === 'counterpress';
        const ownGoalX = ctx.ownGoalX ?? o.ownGoalX;
        const out = [];

        mates.forEach((p, k) => {
            if (isPress && k < o.swarmN) {
                // 4·6. 상실 직후 압박·포위 — 볼로 수렴하되 골 사이드 유지
                const gx = ownGoalX, gy = o.centerY;
                const dx = ball.x - p.x, dy = ball.y - p.y;
                const d = Math.max(1, Math.hypot(dx, dy));
                const press = k < o.pressN;
                out.push({
                    player: p,
                    role: press ? TRANSITION_ROLE.PRESS : TRANSITION_ROLE.SWARM,
                    targetX: clamp(ball.x - (ball.x - gx) / Math.max(1, Math.hypot(ball.x - gx, ball.y - gy)) * (press ? o.pressDist : o.pressDist + 30), o.minX, o.maxX),
                    targetY: clamp(ball.y, o.yMin, o.yMax),
                    speed: k === 0 ? SPEEDS[4] : SPEEDS[3],
                });
                void d;
            } else {
                // 8. 수비 라인 재정렬 — 골 앞 라인으로 복귀
                const lineX = ownGoalX + dir * -1 * 0 + (dir > 0 ? o.lineDepth : -o.lineDepth);
                // dir>0(우공격)이면 자기 골은 왼쪽 → 라인X = ownGoalX + lineDepth
                const lx = dir > 0 ? ownGoalX + o.lineDepth : ownGoalX - o.lineDepth;
                out.push({
                    player: p,
                    role: TRANSITION_ROLE.REALIGN,
                    targetX: clamp(lx + (k % 3) * 18, o.minX, o.maxX),
                    targetY: clamp(o.centerY + (k - (mates.length - 1) / 2) * 55, o.yMin, o.yMax),
                    speed: SPEEDS[4],
                });
                void lineX;
            }
        });
        return out;
    }

    /**
     * 상대 역습 대응 의도 (7) — 볼-골 사이 지연 + 라인 복귀 혼합.
     * @param {object} ctx { ball, mates, dir, ownGoalX }
     */
    antiCounterIntents(ctx = {}) {
        const o = this.o;
        const dir = ctx.dir ?? o.dir;
        const ball = ctx.ball;
        const ownGoalX = ctx.ownGoalX ?? o.ownGoalX;
        const mates = [...(ctx.mates ?? [])].sort(
            (a, b) => Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y),
        );
        return mates.map((p, k) => {
            if (k === 0) {
                // 선두 1명은 볼-골 사이에서 지연 (태클이 아니라 속도 늦추기)
                const t = 0.35;
                return {
                    player: p,
                    role: TRANSITION_ROLE.DELAY,
                    targetX: clamp(ball.x + (ownGoalX - ball.x) * t, o.minX, o.maxX),
                    targetY: clamp(ball.y + (o.centerY - ball.y) * t, o.yMin, o.yMax),
                    speed: SPEEDS[4],
                };
            }
            const lx = dir > 0 ? ownGoalX + o.lineDepth : ownGoalX - o.lineDepth;
            return {
                player: p,
                role: TRANSITION_ROLE.REALIGN,
                targetX: clamp(lx, o.minX, o.maxX),
                targetY: clamp(o.centerY + (k - mates.length / 2) * 60, o.yMin, o.yMax),
                speed: SPEEDS[4],
            };
        });
    }
}
