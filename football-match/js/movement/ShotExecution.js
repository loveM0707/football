/**
 * ShotExecution - 슈팅 실행(조준·높이·구질·힘) 공통 모듈
 *
 * "언제 때릴까"는 ShotDecision 이, "어떻게 때릴까"는 이 모듈이 담당한다.
 * 모든 슈팅 계열 시나리오(1:1, 2:2, 3:3, 슈팅, 슈팅-골키퍼, 그리고 앞으로
 * 만들 4:4·11:11)가 이 모듈 하나만 쓰면 슛의 느낌이 어디서나 동일해진다.
 *
 * 시나리오별로 randomAimY()·randomShotHeight()·shotSpeed 를 각자 복사해 두면
 * 같은 상황에서도 시나리오마다 다른 슛이 나온다. 그 중복을 여기서 없앤다.
 *
 * 모델:
 *   1) 의도(intent)  — 노리는 지점. ShotDecision 이 준 aimY 또는 골문 안 임의 지점.
 *   2) 실행 오차     — 거리·압박·각도에 비례해 의도에서 벗어난다.
 *                      가까이서 여유 있게 때리면 정확하고, 멀거나 쫓기면 빗나간다.
 *   3) 높이 프로파일 — 낮게 깔기 / 중간 / 상단 구석 / 크로스바 위.
 *   4) 힘            — 거리에 비례. 근거리 대포알과 원거리 솜방망이를 모두 방지.
 *
 * plan() 이 돌려주는 값은 ShotMovement.shoot() 의 옵션과 GoalkeeperSave 의
 * 궤적 인자로 그대로 넣을 수 있다.
 */
import { angleTo, angleDiff } from './Direction.js';
import { GOAL_TOP_Y, GOAL_BOT_Y, CROSSBAR_HEIGHT } from './FieldGeometry.js';

const DEFAULTS = {
    goalTopY: GOAL_TOP_Y,
    goalBotY: GOAL_BOT_Y,
    crossbarHeight: CROSSBAR_HEIGHT,
    postMargin: 9,        // 포스트 안쪽 여유 — 볼 반지름 고려
    // 실행 오차: 기본 + 거리 비례 + 압박 비례 (SVG)
    // 골문 반폭이 36.6 SVG 이므로, 오차가 그 부근을 넘어야 실제로 빗나간다.
    // 10m(100 SVG)에서 ±23, 18m에서 ±34, 30m에서 ±51 — 거리에 따라 정확도가 확실히 갈린다.
    baseError: 9,
    distanceError: 0.14,  // 거리 1 SVG 당 오차 증가폭
    pressureError: 22,    // 압박이 최대일 때 추가되는 오차
    pressureRadius: 110,  // 이 안에 수비수가 있으면 압박으로 본다
    speedError: 0.06,     // 슈터 속도 1 SVG/s 당 오차 (스프린트 150에서 +9)
    turnError: 0.18,      // 몸 회전각 1도 당 오차 (45도 틀면 +8)
    // 힘: 거리에 비례 (SVG/s)
    minSpeed: 300,
    speedPerDistance: 0.62,
    maxSpeed: 560,
    speedJitter: 20,
    // 높이 분포
    lowChance: 0.30,      // 낮게 깔기
    midChance: 0.48,      // 중간 높이
    topCornerChance: 0.12,// 상단 구석
    // 나머지는 크로스바 위로 뜨는 실축
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

export class ShotExecution {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /** 골문 안쪽(포스트 여유 포함) 임의 조준점 — 의도가 주어지지 않았을 때 */
    randomIntent() {
        const o = this.o;
        return rand(o.goalTopY + o.postMargin, o.goalBotY - o.postMargin);
    }

    /**
     * 슛 실행 계획을 세운다.
     *
     * @param {object} ctx
     *   ball      {x,y}    킥 시작점
     *   goalX     {number} 목표 골라인 X
     *   aimY      {number} 노리는 지점 (없으면 골문 안 임의 지점)
     *   defenders {Array}  압박 계산용 상대 선수 (선택)
     *   shooter   {x,y,angle} 슈터 — 압박·회전각 계산용 (없으면 ball 기준)
     *   shooterSpeed {number} 슈터 이동 속도 (SVG/s, 기본 0) — 달릴수록 오차 증가
     *   accuracy  {number} 0~1 정확도 보정. 1이면 오차 그대로, 낮을수록 부정확
     * @returns {{
     *   targetY, targetHeight, arcHeight, speed, startHeight,
     *   aimAngle, onTarget, overBar, sideMiss, distance,
     *   turnDeg, shooterSpeed, pressure
     * }}
     */
    plan(ctx) {
        const o = this.o;
        const ball = ctx.ball;
        const goalX = ctx.goalX;
        const shooter = ctx.shooter ?? ball;
        const distance = Math.abs(goalX - ball.x);

        // ── 1. 의도 ──
        const intent = ctx.aimY ?? this.randomIntent();

        // ── 2. 실행 오차 — 거리·압박·이동·회전에 비례 ──
        let pressure = 0;
        if (ctx.defenders && ctx.defenders.length) {
            let nearest = Infinity;
            for (const d of ctx.defenders) {
                nearest = Math.min(nearest, Math.hypot(d.x - shooter.x, d.y - shooter.y));
            }
            pressure = clamp(1 - nearest / o.pressureRadius, 0, 1);
        }
        // 슈터 이동 속도·몸 회전각도 오차에 반영 (달리면서·틀어진 자세로 찰수록 부정확)
        const shooterSpeed = Math.max(0, ctx.shooterSpeed ?? 0);
        const preAim = angleTo(ball.x, ball.y, goalX, intent);
        const turnDeg = (shooter && typeof shooter.angle === 'number')
            ? Math.abs(angleDiff(preAim, shooter.angle)) : 0;
        const accuracy = ctx.accuracy ?? 1;
        const spread = (o.baseError
                      + distance * o.distanceError
                      + pressure * o.pressureError
                      + shooterSpeed * o.speedError
                      + turnDeg * o.turnError) / Math.max(0.35, accuracy);
        // 골문 밖까지 벗어날 수 있어야 빗나가는 슛이 나온다
        const targetY = clamp(intent + rand(-spread, spread),
            o.goalTopY - 42, o.goalBotY + 42);

        // ── 3. 높이 프로파일 ──
        const height = this._pickHeight();

        // 옆으로 이미 빗나갔으면 크로스바 위 판정은 적용하지 않는다
        const sideMiss = targetY < o.goalTopY || targetY > o.goalBotY;
        const overBar = height.overBar && !sideMiss;
        const finalY = overBar ? o.goalTopY + 20 : targetY;

        // ── 4. 힘 — 거리에 비례 ──
        const speed = clamp(
            o.minSpeed + distance * o.speedPerDistance + rand(-o.speedJitter, o.speedJitter),
            o.minSpeed, o.maxSpeed);

        const onTarget = !sideMiss && !overBar
            && finalY >= o.goalTopY && finalY <= o.goalBotY
            && height.targetHeight <= o.crossbarHeight;

        return {
            targetY: finalY,
            targetHeight: height.targetHeight,
            arcHeight: height.arcHeight,
            startHeight: height.targetHeight * 0.1,
            speed,
            aimAngle: angleTo(ball.x, ball.y, goalX, finalY),
            onTarget, overBar, sideMiss, distance,
            turnDeg, shooterSpeed, pressure,
        };
    }

    /**
     * ShotMovement.shoot() 에 그대로 넘길 옵션으로 변환한다.
     * @param {object} plan plan()의 반환값
     * @param {number} [goalX]
     */
    static toShootOptions(plan, goalX = null) {
        const opt = {
            targetY: plan.targetY,
            targetHeight: plan.targetHeight,
            arcHeight: plan.arcHeight,
            speed: plan.speed,
        };
        if (goalX !== null) opt.goalX = goalX;
        return opt;
    }

    /**
     * GoalkeeperSave.evaluateSave() 에 넘길 궤적으로 변환한다.
     * @param {object} plan
     * @param {object} ball  {x,y}
     * @param {number} goalX
     */
    static toTrajectory(plan, ball, goalX) {
        return {
            startX: ball.x, startY: ball.y,
            targetX: goalX, targetY: plan.targetY,
            speed: plan.speed,
            startHeight: plan.startHeight,
            targetHeight: plan.targetHeight,
            arcHeight: plan.arcHeight,
        };
    }

    /* ── private ─────────────────────────────────── */

    _pickHeight() {
        const o = this.o;
        const r = Math.random();
        if (r < o.lowChance) {
            // 낮게 깔아 차기 — 가장 흔한 마무리
            return { targetHeight: 0.06 + Math.random() * 0.22, arcHeight: 0.08 };
        }
        if (r < o.lowChance + o.midChance) {
            // 중간 높이
            return { targetHeight: 0.4 + Math.random() * 1.2, arcHeight: 0.15 + Math.random() * 0.2 };
        }
        if (r < o.lowChance + o.midChance + o.topCornerChance) {
            // 상단 구석 — 크로스바 바로 아래
            return { targetHeight: 2.05 + Math.random() * 0.3, arcHeight: 0.07 };
        }
        // 크로스바 위로 뜨는 실축
        return { targetHeight: 2.62 + Math.random() * 0.4, arcHeight: 0.09, overBar: true };
    }
}
