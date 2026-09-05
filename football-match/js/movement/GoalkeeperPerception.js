/**
 * GoalkeeperPerception - 골키퍼 지각 공통 모듈
 *
 * 골키퍼가 판단에 필요한 정보를 한 곳에서 수집한다.
 * 시나리오마다 흩어져 있던 공·상대·골대 거리 계산을 여기로 통합한다.
 * (코드 중복 제거 원칙 — angleTo/거리 계산을 각자 구현하지 않는다)
 *
 * 순수 수집 모듈이다 — 이동·판단을 직접 수행하지 않으며,
 * Situation/Decision 단계가 참조할 스냅샷만 만든다.
 *
 * 파이프라인 위치:
 *   Perception → Situation Evaluation → Decision → Intent → Movement → Ball Interaction
 */
import { angleTo } from './Direction.js';
import {
    GOAL_TOP_Y, GOAL_BOT_Y, CENTER_Y,
} from './FieldGeometry.js';

const DEFAULTS = {
    goalTopY: GOAL_TOP_Y,
    goalBotY: GOAL_BOT_Y,
    centerY: CENTER_Y,
    boxDepth: 165,      // 페널티 박스 깊이 (16.5m)
    boxHalfWidth: 222,  // 박스 좌우 반폭 (중앙선 기준)
    sixYardDepth: 55,   // 골박스 깊이 (5.5m)
};

function dist(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
}

export class GoalkeeperPerception {
    /**
     * @param {object} options
     *   ownGoalX {number} 자기 골라인 X (기본 0 = 왼쪽 골)
     *   dir      {number} 팀 공격 방향 (+1 = 오른쪽 공격, -1 = 왼쪽 공격)
     */
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this.ownGoalX = options.ownGoalX ?? 0;
        this.dir = options.dir ?? 1;
    }

    /** 좌표가 자기 페널티 박스 안인지 */
    inOwnBox(x, y) {
        const o = this.o;
        // 골라인에서 필드 쪽으로의 깊이 (dir 부호로 좌·우 골 모두 동일 처리)
        const depth = (x - this.ownGoalX) * this.dir;
        return depth >= -12 && depth <= o.boxDepth
            && Math.abs(y - o.centerY) <= o.boxHalfWidth;
    }

    /** 좌표가 골박스(6야드) 안인지 */
    inSixYard(x, y) {
        const o = this.o;
        const depth = (x - this.ownGoalX) * this.dir;
        const halfGoal = (o.goalBotY - o.goalTopY) / 2 + 28;
        return depth >= -12 && depth <= o.sixYardDepth
            && Math.abs(y - o.centerY) <= halfGoal;
    }

    /**
     * 지각 스냅샷을 만든다.
     * @param {object} ctx
     *   gk            {x,y,angle}     골키퍼
     *   ball          {x,y,height}    공
     *   ballVel       {vx,vy}         공 속도
     *   aerial        {boolean}       공중 비행 중
     *   bouncing      {boolean}       바운드 중
     *   owner         {object|null}   볼 소유자 (없으면 null)
     *   landing       {x,y|null}      공중볼 예상 착지점
     *   opponents     {Array}         상대 선수 [{x,y}]
     *   teammates     {Array}         아군 선수 [{x,y}]
     *   defenseLineX  {number|null}   수비 라인 X (연계용, 없으면 null)
     *   shotTrajectory{object|null}   비행 중 슛 궤적 (ShotExecution 형태)
     * @returns {object} 지각 스냅샷 (읽기 전용으로 취급)
     */
    perceive(ctx = {}) {
        const o = this.o;
        const gk = ctx.gk;
        const ball = ctx.ball;
        const vel = ctx.ballVel ?? { vx: 0, vy: 0 };
        const ballSpeed = Math.hypot(vel.vx, vel.vy);
        const opponents = ctx.opponents ?? [];
        const teammates = ctx.teammates ?? [];

        // 공-골 기하 (자기 골 기준)
        const goalCX = this.ownGoalX;
        const goalCY = o.centerY;
        const ballGoalDist = dist(ball.x, ball.y, goalCX, goalCY);
        const gkBallDist = dist(gk.x, gk.y, ball.x, ball.y);
        // 공이 골문을 향하는지 (자기 골 쪽으로 접근 중인지)
        const towardGoal = (ball.x - goalCX) * this.dir > 0
            ? vel.vx * this.dir < -10
            : false;
        // 공의 골문 안 여부 (Y 범위)
        const ballInMouth = ball.y >= o.goalTopY && ball.y <= o.goalBotY;
        // 골키퍼가 바라봐야 할 각도 (공 방향)
        const facingAngle = angleTo(gk.x, gk.y, ball.x, ball.y);

        // 가장 가까운 상대·아군까지 거리 (압박·크라우드 판단용)
        let nearestOppBall = Infinity;
        let nearestOppGoal = Infinity;
        for (const opp of opponents) {
            nearestOppBall = Math.min(nearestOppBall, dist(opp.x, opp.y, ball.x, ball.y));
            nearestOppGoal = Math.min(nearestOppGoal, dist(opp.x, opp.y, goalCX, goalCY));
        }
        let nearestMateBall = Infinity;
        for (const mate of teammates) {
            // 골키퍼 본인은 제외 (호출자가 이미 제외하거나, 거리 0이면 무시)
            const d = dist(mate.x, mate.y, ball.x, ball.y);
            if (d > 1) nearestMateBall = Math.min(nearestMateBall, d);
        }

        // 볼 소유자 정보
        const owner = ctx.owner ?? null;
        const ownerIsOpponent = owner
            ? opponents.includes(owner)
            : false;
        const ownerDistGoal = owner
            ? Math.abs((owner.x - goalCX) * this.dir)
            : Infinity;

        // 측면 크로스 여부 — 공이 박스 밖 측면에 있고 공중이면 크로스로 본다
        const aerial = Boolean(ctx.aerial || ctx.bouncing);
        const landing = ctx.landing ?? null;
        const wideY = Math.abs(ball.y - o.centerY) > (o.goalBotY - o.goalTopY) / 2 + 60;
        const crossLike = aerial && wideY && landing && this.inOwnBox(landing.x, landing.y);

        // 수비 라인과의 간격 (연계용)
        const lineX = ctx.defenseLineX ?? null;
        const lineGap = lineX !== null
            ? Math.abs((lineX - gk.x) * this.dir)
            : null;

        return {
            gk: { x: gk.x, y: gk.y, angle: gk.angle },
            ball: { x: ball.x, y: ball.y, height: ball.height ?? 0 },
            ballVel: { vx: vel.vx, vy: vel.vy },
            ballSpeed,
            aerial,
            owner,
            ownerIsOpponent,
            ownerDistGoal,
            landing,
            crossLike,
            ballGoalDist,
            gkBallDist,
            towardGoal,
            ballInMouth,
            facingAngle,
            nearestOppBall,
            nearestOppGoal,
            nearestMateBall,
            ballInBox: this.inOwnBox(ball.x, ball.y),
            ballInSixYard: this.inSixYard(ball.x, ball.y),
            landingInBox: landing ? this.inOwnBox(landing.x, landing.y) : false,
            defenseLineX: lineX,
            lineGap,
            shotTrajectory: ctx.shotTrajectory ?? null,
            goal: { x: goalCX, topY: o.goalTopY, botY: o.goalBotY, centerY: goalCY },
        };
    }
}
