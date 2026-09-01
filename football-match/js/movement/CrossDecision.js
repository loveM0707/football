/**
 * CrossDecision - 크로스 판단 모듈
 *
 * 크로스는 "측면에서 이미 달려가고 있는 방향으로" 올려야 자연스럽다.
 * 이 모듈은 시나리오가 아무 때나 크로스를 올리지 못하도록 세 가지를 강제한다:
 *
 *   1) 볼 접촉  — 볼이 발에 붙어 있을 때만 올린다.
 *                 (킥 사이클 중 볼이 앞으로 떠 있는 순간의 크로스는 발에 닿지 않는다)
 *   2) 회전 제한 — 현재 몸 방향에서 maxTurnDeg 이내로만 올린다.
 *                 측면으로 달리다 갑자기 180도 반대편으로 올리는 현상을 차단한다.
 *   3) 전진성   — 크로스 지점은 크로서보다 앞이어야 한다. 뒤로 올리는 크로스는 없다.
 *
 * 조건을 만족하지 못하면 cross=false 와 reason 을 돌려준다.
 * 시나리오는 이때 크로스를 포기하고 드리블·패스를 이어가면 된다.
 */
import { angleTo, angleDiff } from './Direction.js';

const DEFAULTS = {
    centerY: 340,
    goalTopY: 303.4,
    goalBotY: 376.6,
    maxTurnDeg: 88,       // 몸 방향에서 허용하는 최대 크로스 각
                          // 정상적인 측면 크로스(앞·안쪽)는 통과하고,
                          // 달리던 방향의 반대편으로 올리는 크로스만 걸러낸다
    wideThreshold: 150,   // 이보다 중앙이면 크로스가 아니라 슛·스루패스 상황
    maxRange: 420,        // 골라인에서 이보다 멀면 크로스 사거리 밖
    minRange: 55,         // 골라인에 붙으면 컷백은 되지만 일반 크로스는 안 됨
    targetDepthMin: 75,   // 크로스 낙하지점 — 골라인에서 7.5m
    targetDepthMax: 115,  // 골라인에서 11.5m
    centralLimit: 175,    // 헤더 후보가 중앙에서 벗어날 수 있는 한계
    mateRangeLimit: 450,  // 헤더 후보가 골에서 떨어질 수 있는 한계
    minForward: -15,      // 크로스 지점이 크로서보다 뒤로 갈 수 있는 허용치
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

export class CrossDecision {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * 크로스 가능 여부와 목표를 평가한다.
     *
     * @param {object} ctx
     *   crosser      {x,y,angle} 볼 소유 선수
     *   ball         {x,y}       현재 볼 위치 (킥 시작점)
     *   attackGoalX  {number}
     *   dir          {number}    +1 = 오른쪽 골 공격
     *   teammates    {Array}     [{ player, idx }] 크로서를 제외한 동료
     *   ballAttached {boolean}
     *   relax        {boolean}   교착 탈출용 완화 모드 (조건을 조금 넓힘)
     * @returns {{ cross: boolean, reason?: string, headIdx?: number,
     *            aimX?: number, aimY?: number, turnDeg?: number }}
     */
    evaluate(ctx) {
        const o = this.o;
        const p = ctx.crosser;
        const ball = ctx.ball ?? p;
        const gx = ctx.attackGoalX;
        const dir = ctx.dir ?? 1;
        const mates = ctx.teammates ?? [];
        const relax = Boolean(ctx.relax);

        // ── 1. 볼이 발에 붙어 있어야 한다 ──
        // 킥 사이클 도중(볼이 전방으로 굴러가는 중)에는 크로스를 올릴 수 없다.
        if (ctx.ballAttached === false) return { cross: false, reason: 'ball-detached' };

        // ── 2. 사거리·측면성 ──
        const forwardDist = (gx - p.x) * dir;
        if (forwardDist > (relax ? o.maxRange + 30 : o.maxRange)) {
            return { cross: false, reason: 'too-far' };
        }
        if (forwardDist < o.minRange) return { cross: false, reason: 'on-goal-line' };

        const wide = Math.abs(p.y - o.centerY);
        const wideNeed = relax ? o.wideThreshold - 35 : o.wideThreshold;
        if (wide < wideNeed) return { cross: false, reason: 'too-central' };

        // ── 3. 헤더 후보 — 박스 중앙 자원 ──
        const centralLimit = relax ? o.centralLimit + 20 : o.centralLimit;
        const rangeLimit = relax ? o.mateRangeLimit + 25 : o.mateRangeLimit;
        let head = null, headScore = Infinity;
        for (const m of mates) {
            const mp = m.player;
            const central = Math.abs(mp.y - o.centerY);
            if (central > centralLimit) continue;
            const mdx = Math.abs(gx - mp.x);
            if (mdx > rangeLimit) continue;
            // 크로서와 같은 쪽 측면에 붙어 있으면 헤더 자원이 아니다
            if (Math.sign(mp.y - o.centerY) === Math.sign(p.y - o.centerY)
                && central > 110) continue;
            const score = central + mdx * 0.4;
            if (score < headScore) { headScore = score; head = m; }
        }
        if (!head) return { cross: false, reason: 'no-target' };

        // ── 4. 낙하지점 — 헤더 후보가 달려들 수 있는 박스 상공 ──
        const depth = rand(o.targetDepthMin, o.targetDepthMax);
        const aimX = gx - dir * depth;
        // 헤더 후보의 현재 Y 를 존중해 크로스 — 반대편으로 던지는 크로스 방지
        const towardMate = (head.player.y - o.centerY) * 0.45;
        const aimY = clamp(o.centerY + towardMate + rand(-28, 28),
            o.goalTopY - 60, o.goalBotY + 60);

        // ── 5. 전진성 — 뒤로 올리는 크로스는 없다 ──
        if ((aimX - p.x) * dir < o.minForward) {
            return { cross: false, reason: 'backward' };
        }

        // ── 6. 회전 제한 — 몸 방향에서 크게 벗어난 크로스는 올릴 수 없다 ──
        // 측면으로 달리던 선수가 갑자기 180도 반대편으로 올리는 현상을 여기서 막는다.
        const aimAngle = angleTo(ball.x, ball.y, aimX, aimY);
        const turnDeg = Math.abs(angleDiff(aimAngle, p.angle));
        const turnLimit = relax ? o.maxTurnDeg + 18 : o.maxTurnDeg;
        if (turnDeg > turnLimit) {
            return { cross: false, reason: 'turn-too-large', turnDeg };
        }

        return { cross: true, headIdx: head.idx, aimX, aimY, turnDeg, aimAngle };
    }
}
