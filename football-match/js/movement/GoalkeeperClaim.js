/**
 * GoalkeeperClaim - 골키퍼 볼 회수(클레임) 판단 모듈
 *
 * 골키퍼가 언제 골문을 떠나 볼을 직접 잡으러 나갈지를 결정한다.
 * 지면볼과 공중볼을 모두 다룬다.
 *
 * 공중볼(크로스·로빙패스):
 *   낙하지점이 자기 박스 안이고, 상대 공격수보다 먼저 닿을 수 있으면 나간다.
 *   실제 캐치는 볼 높이가 손이 닿는 범위(reachHeight)로 내려온 순간에만 성립한다.
 *   이것이 "골키퍼가 공중볼을 잡지 못하는" 현상을 해결한다.
 *
 * 지면볼:
 *   느리게 굴러오거나 박스 안에 멈춘 볼은 골키퍼가 직접 회수한다.
 *
 *   locked:
 *   배급 직후 GoalkeeperDistribution.locked 를 그대로 넘겨주면,
 *   골키퍼가 자기가 내준 패스를 되잡으러 달려가는 현상이 사라진다.
 *
 * 이 모듈은 좌·우 골 모두 실제 좌표 그대로 다룬다 (거울 변환 불필요).
 */
import { GOAL_TOP_Y, GOAL_BOT_Y, CENTER_Y } from './FieldGeometry.js';

const DEFAULTS = {
    goalTopY: GOAL_TOP_Y,
    goalBotY: GOAL_BOT_Y,
    centerY: CENTER_Y,
    boxDepth: 165,        // 페널티 박스 깊이 (16.5m)
    boxHalfWidth: 222,    // 박스 좌우 반폭 — 중앙선 기준
    catchRadius: 11,      // 이 안에 들어오면 캐치 성립
    reachHeight: 0.58,    // 손이 닿는 볼 높이 (Ball.height 0~1 스케일)
    groundSlowSpeed: 175, // 이보다 느린 지면볼은 회수 대상
    rushRadius: 105,      // 지면볼을 향해 달려나갈 수 있는 최대 거리
    aerialRushRadius: 175,// 공중볼 낙하지점까지 나갈 수 있는 최대 거리
    rivalMargin: 18,      // 상대보다 이만큼은 먼저 닿아야 나간다
};

export class GoalkeeperClaim {
    /**
     * @param {object} options
     *   ownGoalX {number} 자기 골라인 X
     *   dir      {number} 팀 공격 방향 (+1 = 오른쪽 골 공격 → 자기 골은 왼쪽)
     */
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this.ownGoalX = options.ownGoalX ?? 0;
        this.dir = options.dir ?? 1;
    }

    /** 좌표가 자기 페널티 박스 안인지 */
    inOwnBox(x, y) {
        const o = this.o;
        const depth = (x - this.ownGoalX) * this.dir; // 골라인에서 필드 쪽으로의 거리
        return depth >= -12 && depth <= o.boxDepth
            && Math.abs(y - o.centerY) <= o.boxHalfWidth;
    }

    /**
     * 클레임 여부를 평가한다.
     *
     * @param {object} ctx
     *   gk        {x,y}      골키퍼
     *   ball      {x,y,height}
     *   ballVel   {vx,vy}
     *   aerial    {boolean}  공중 비행 중
     *   bouncing  {boolean}  바운드 중
     *   owner     {object}   현재 볼 소유자 (없으면 null)
     *   landing   {x,y}      공중볼 예상 착지점 (없으면 null)
     *   opponents {Array}    상대 필드 선수
     *   locked    {boolean}  배급 직후 재클레임 금지 구간
     * @returns {{ claim: boolean, catch: boolean, targetX: number, targetY: number,
     *             aerial: boolean, urgency: number }}
     */
    evaluate(ctx) {
        const o = this.o;
        const gk = ctx.gk;
        const ball = ctx.ball;
        const none = { claim: false, catch: false, targetX: gk.x, targetY: gk.y, aerial: false, urgency: 0 };

        // 배급 직후에는 자기 패스를 되잡지 않는다
        if (ctx.locked) return none;
        // 누군가 소유 중인 볼은 클레임 대상이 아니다
        if (ctx.owner) return none;

        const aerial = Boolean(ctx.aerial || ctx.bouncing);

        if (aerial) {
            // ── 공중볼 ──
            const land = ctx.landing;
            if (!land) return none;
            if (!this.inOwnBox(land.x, land.y)) return none;

            const gkToLand = Math.hypot(gk.x - land.x, gk.y - land.y);
            if (gkToLand > o.aerialRushRadius) return none;

            // 상대보다 먼저 닿을 수 있어야 나간다
            let rival = Infinity;
            for (const opp of ctx.opponents ?? []) {
                rival = Math.min(rival, Math.hypot(opp.x - land.x, opp.y - land.y));
            }
            if (rival + o.rivalMargin < gkToLand) return none;

            // 캐치 성립: 볼이 손 닿는 높이로 내려왔고 몸에 닿을 만큼 가까울 때
            const height = ball.height ?? 0;
            const gkToBall = Math.hypot(gk.x - ball.x, gk.y - ball.y);
            const canCatch = height <= o.reachHeight && gkToBall <= o.catchRadius + 7;

            return {
                claim: true,
                catch: canCatch,
                targetX: land.x,
                targetY: land.y,
                aerial: true,
                urgency: 1,
            };
        }

        // ── 지면볼 ──
        if (!this.inOwnBox(ball.x, ball.y)) return none;

        const vel = ctx.ballVel ?? { vx: 0, vy: 0 };
        const speed = Math.hypot(vel.vx, vel.vy);
        const gkToBall = Math.hypot(gk.x - ball.x, gk.y - ball.y);

        const slow = speed < o.groundSlowSpeed;
        const stationaryNear = speed < 3 && gkToBall < o.rushRadius;
        if (!slow && !stationaryNear) return none;
        if (gkToBall > o.rushRadius) return none;

        // 상대가 훨씬 가까우면 무리해서 나가지 않는다 (박스 밖 노출 방지)
        let rival = Infinity;
        for (const opp of ctx.opponents ?? []) {
            rival = Math.min(rival, Math.hypot(opp.x - ball.x, opp.y - ball.y));
        }
        if (rival + o.rivalMargin < gkToBall && gkToBall > 45) return none;

        return {
            claim: true,
            catch: gkToBall <= o.catchRadius,
            targetX: ball.x,
            targetY: ball.y,
            aerial: false,
            urgency: speed < 3 ? 0.6 : 1,
        };
    }
}
