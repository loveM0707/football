/**
 * DefenderDuelAI - 대인 수비 듀얼 판단 공통 모듈
 *
 * 볼 소유자를 상대로 실제 수비처럼 반응한다. 1v1은 물론 2v1·3v2 같은
 * 수적 열세 지연 수비에서도 같은 모듈을 쓴다 — attackers 배열로 받으면
 * 볼에 가장 가까운 공격수를 1차로 막고, 가장 전진한 프리맨 쪽으로
 * 살짝 기울어 레인을 지킨다. 공격수가 1명이면 기존 1v1과 동일 동작.
 *
 * DribbleDecision(공격)과 대칭되는 구조 — 매 프레임 공격수를 재평가하고
 * 수비수의 PlayerMovement를 직접 구동한다. 사전 웨이포인트·스크립트 없음.
 *
 * 상태:
 *   APPROACH  멀리 있으면 골사이드로 접근 (공이 아닌 골사이드 지점을 목표로)
 *   JOCKEY    일정 거리 유지 + 골사이드 + 공격수 측면 미러링 (자키잉)
 *   LUNGE     킥 윈도우(볼이 발에서 떨어짐)에만 태클 커밋. 실패 시 스태거.
 *
 * 태클 판정은 이 모듈이 직접 하지 않는다. LUNGE 중에만 tackleIntent=true를
 * 내보내고, 시나리오는 CollisionSystem.isTackle && tackleIntent일 때만
 * PossessionContest로 넘긴다. 자키잉 중 몸 접촉은 탈취가 아니다.
 */
import { PlayerMovement } from './PlayerMovement.js';
import { angleTo, angleDiff } from './Direction.js';
import { CENTER_Y, Y_MIN, Y_MAX, FIELD_MIN_X, FIELD_MAX_X } from './FieldGeometry.js';

export const DUEL_DEFENSE_STATE = Object.freeze({
    APPROACH: 'approach',
    JOCKEY: 'jockey',
    LUNGE: 'lunge',
});

const SPEEDS = PlayerMovement.SPEEDS;

const DEFAULTS = {
    goalX: 1050,
    goalY: CENTER_Y,
    dir: 1,             // 상대 공격 방향 (+1 = 오른쪽 골 공격, 수비는 오른쪽 골을 지킴)
    centerY: CENTER_Y,
    yMin: Y_MIN,
    yMax: Y_MAX,
    fieldMinX: FIELD_MIN_X,
    fieldMaxX: FIELD_MAX_X,
    shadeWeight: 0.25,  // 복수 공격수 시 프리맨 쪽 기울기 (1v1이면 0)
    shadeMinGain: -40,  // 볼보다 이만큼 뒤처진 동료는 위협으로 보지 않음
    jockeyDist: 30,     // 자키잉 유지 거리 (TACKLE_DIST=19 밖 + 여유)
    jockeyRange: 120,   // 이 안이면 자키잉
    approachHysteresis: 30, // 자키잉 이탈 히스테리시스 (진동 방지)
    lungeRange: 32,     // 이 안에서 킥 윈도우가 나면 태클 커밋
    lungeTime: 0.55,    // 돌진 지속 시간
    lungeCooldown: 2.2, // 연속 태클 방지 — 헛발 후 공격수에게 돌파 기회 보장
    staggerTime: 0.45,  // 헛발 후 회복 시간 (이 동안 저속)
    predictTime: 0.45,  // 공격수 예측 시간 — 진로를 앞서 차단
    mirrorGain: 0.35,   // 측면 미러링 강도 (공격수 y속도 반영)
    facingTolerance: 55, // 태클 커밋 허용 몸 각도 오차 — 몸이 열리면 태클을 걸지 않음
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class DefenderDuelAI {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this._state = DUEL_DEFENSE_STATE.APPROACH;
        this._lungeTimer = 0;
        this._cooldown = 0;
        this._stagger = 0;
    }

    get state() { return this._state; }
    /** LUNGE 중에만 true — 시나리오는 이 때만 태클 성립을 판정한다 */
    get tackleIntent() { return this._state === DUEL_DEFENSE_STATE.LUNGE; }

    reset() {
        this._state = DUEL_DEFENSE_STATE.APPROACH;
        this._lungeTimer = 0;
        this._cooldown = 0;
        this._stagger = 0;
    }

    start() { this.reset(); }
    stop() {}

    /**
     * 매 프레임 호출. 수비수의 이동 목표를 갱신한다.
     *
     * @param {number} dt
     * @param {object} ctx
     *   defender         {x,y,angle}     수비수
     *   movement         PlayerMovement  수비수 이동 모듈 (직접 구동)
     *   attacker         {x,y,angle}     볼 소유 공격수 (단일 지정, attackers와排他)
     *   attackerMovement PlayerMovement  공격수 속도 예측용 (없으면 정지 예측)
     *   attackers        {Array}         [{x,y,angle}] 복수 공격수 (2v1·3v2 지연 수비)
     *   attackerMovements {Array}        attackers와 같은 순서의 이동 모듈 (선택)
     *   ball             {x,y}
     *   ballVelocity     {x,y}
     *   ballAttached     {boolean} 볼이 공격수 발에 붙어 있는지
     * @returns {string} 현재 DUEL_DEFENSE_STATE
     */
    update(dt, ctx) {
        const o = this.o;
        const d = ctx.defender;
        const pm = ctx.movement;
        const ball = ctx.ball ?? { x: d.x, y: d.y };
        const bv = ctx.ballVelocity ?? { x: 0, y: 0 };
        const attached = ctx.ballAttached !== false;

        // 1차 마크 대상 = 볼에 가장 가까운 공격수 (소유자가 항상 가장 가깝다)
        const attackers = ctx.attackers ?? (ctx.attacker ? [ctx.attacker] : []);
        const attMoves = ctx.attackerMovements
            ?? (ctx.attackerMovement ? [ctx.attackerMovement] : []);
        if (attackers.length === 0) return this._state;
        let pi = 0, pd = Infinity;
        attackers.forEach((at, i) => {
            const dd = Math.hypot(at.x - ball.x, at.y - ball.y);
            if (dd < pd) { pd = dd; pi = i; }
        });
        const a = attackers[pi];
        const am = attMoves[pi] ?? attMoves[0] ?? null;
        // 프리맨 위협 = 1차 대상外 가장 전진한 공격수 (없으면 기울기 없음)
        let threat = null;
        attackers.forEach((at, i) => {
            if (i === pi) return;
            if (o.dir * (at.x - ball.x) <= o.shadeMinGain) return;
            if (!threat || o.dir * at.x > o.dir * threat.x) threat = at;
        });

        if (this._cooldown > 0) this._cooldown -= dt;
        if (this._stagger > 0) this._stagger -= dt;

        const dAtt = Math.hypot(a.x - d.x, a.y - d.y);
        const dBall = Math.hypot(ball.x - d.x, ball.y - d.y);

        // 공격수 속도 예측 — 공개 API만 사용 (CooperativeDefenseAI와 동일 방식)
        let vx = 0, vy = 0;
        if (am && typeof am.getVelocity === 'function' && am.moving) {
            const v = am.getVelocity();
            vx = v.x; vy = v.y;
        }

        // ── LUNGE 진행 중 ──
        if (this._state === DUEL_DEFENSE_STATE.LUNGE) {
            this._lungeTimer -= dt;
            const tx = clamp(ball.x + bv.x * 0.12, o.fieldMinX, o.fieldMaxX);
            const ty = clamp(ball.y + bv.y * 0.12, o.yMin + 15, o.yMax - 15);
            pm.clearFacingTarget();
            pm.speed = SPEEDS[4];
            pm.moveTo(tx, ty);
            if (this._lungeTimer <= 0) {
                // 헛발 — 쿨다운 + 스태거 후 자키잉/어프로치로 복귀
                this._cooldown = o.lungeCooldown;
                this._stagger = o.staggerTime;
                this._state = dAtt <= o.jockeyRange
                    ? DUEL_DEFENSE_STATE.JOCKEY
                    : DUEL_DEFENSE_STATE.APPROACH;
            }
            pm.update(dt);
            return this._state;
        }

        // ── 태클 커밋 판단: 킥 윈도우 + 근거리 + 정면 + 쿨다운 완료 ──
        // 볼이 발에 붙어 있으면 절대 돌진하지 않는다 (무조건 돌진 방지)
        if (!attached && this._cooldown <= 0 && dBall <= o.lungeRange) {
            const toBall = angleTo(d.x, d.y, ball.x, ball.y);
            if (Math.abs(angleDiff(toBall, d.angle)) <= o.facingTolerance) {
                this._state = DUEL_DEFENSE_STATE.LUNGE;
                this._lungeTimer = o.lungeTime;
                pm.clearFacingTarget();
                pm.speed = SPEEDS[4];
                pm.moveTo(
                    clamp(ball.x + bv.x * 0.12, o.fieldMinX, o.fieldMaxX),
                    clamp(ball.y + bv.y * 0.12, o.yMin + 15, o.yMax - 15),
                );
                pm.update(dt);
                return this._state;
            }
        }

        // ── 상태 전이 (히스테리시스) ──
        if (this._state === DUEL_DEFENSE_STATE.APPROACH && dAtt <= o.jockeyRange) {
            this._state = DUEL_DEFENSE_STATE.JOCKEY;
        } else if (this._state === DUEL_DEFENSE_STATE.JOCKEY
            && dAtt > o.jockeyRange + o.approachHysteresis) {
            this._state = DUEL_DEFENSE_STATE.APPROACH;
        }

        // ── 목표점: 볼의 골사이드 + 공격수 측면 미러링 ──
        // 공을 직접 겨냥하지 않는다 — 골대와 볼 사이에서 공격수의 진행을 막는다
        const gx = ball.x - o.goalX, gy = ball.y - o.goalY;
        const gDist = Math.hypot(gx, gy) || 1;
        const predAx = a.x + vx * o.predictTime;
        const predAy = a.y + vy * o.predictTime;

        let tx = ball.x + (gx / gDist) * o.jockeyDist;
        let ty = ball.y + (gy / gDist) * o.jockeyDist;
        // 공격수가 움직이는 쪽으로 함께 이동 — 돌파 방향을 미리 막는다
        ty += (predAy - a.y) * o.mirrorGain + vy * 0.1;
        // 복수 공격수: 프리맨 쪽으로 살짝 기울어 레인을 지킨다 (지연 수비)
        // 1v1이면 threat이 없어 아래 분기가 동작하지 않는다
        if (threat) {
            const goalSign = Math.sign(o.goalX - ball.x) || 1;
            const shadeX = (a.x + threat.x) / 2 + goalSign * 15;
            const shadeY = (a.y + threat.y) / 2;
            tx = tx * (1 - o.shadeWeight) + shadeX * o.shadeWeight;
            ty = ty * (1 - o.shadeWeight) + shadeY * o.shadeWeight;
        }
        tx = clamp(tx, o.fieldMinX, o.fieldMaxX);
        ty = clamp(ty, o.yMin + 15, o.yMax - 15);

        // ── 속도: 거리 서보 ──
        let speed;
        if (this._state === DUEL_DEFENSE_STATE.JOCKEY) {
            // 자키잉 거리 서보 — 목표 간격에서 벗어나면 후퇴 가속, 붙으면 셔플
            // (공격수 최고속 150에 셔플 75~100으로는 간격 유지가 불가했음)
            // 크게 벌어지면 골사이드 복귀 스프린트 — 목표가 공이 아닌 골사이드라
            // 무모한 돌진이 아니라 각을 끊는 복귀다
            const gapErr = dAtt - o.jockeyDist;
            speed = gapErr > 25 ? SPEEDS[4]
                  : gapErr > 8  ? SPEEDS[3]
                  : gapErr < -8 ? SPEEDS[1]
                  : SPEEDS[2];
            // 볼을 보며 셔플 (등지지 않음)
            pm.setFacingTarget(angleTo(d.x, d.y, ball.x, ball.y));
        } else {
            // 어프로치 — 뒤처졌으면 전력 복귀, 아니면 중速 접근
            const behindPlay = (ball.x - d.x) * o.dir > 12;
            const dTarget = Math.hypot(tx - d.x, ty - d.y);
            speed = (behindPlay || dTarget > 140) ? SPEEDS[4] : SPEEDS[3];
            pm.clearFacingTarget();
        }
        // 스태거 중에는 회복이 우선 — 속도를 낮춘다
        if (this._stagger > 0) speed = Math.min(speed, SPEEDS[1]);

        pm.speed = speed;
        pm.moveTo(tx, ty);
        pm.update(dt);
        return this._state;
    }
}
