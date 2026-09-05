/**
 * GoalkeeperBrain - 골키퍼 공통 오케스트레이터
 *
 * 13개 골키퍼 행동을 하나의 파이프라인으로 묶는다:
 *   Perception → Situation Evaluation → Decision → Intent → Movement → Ball Interaction
 *
 * 설계 원칙 준수:
 * - 특정 시나리오에 종속되지 않는다 (슛 궤적·착지점·라인을 외부 입력으로 받음)
 * - 방향·회전은 PlayerMovement에 위임한다 (직접 setAngle 점프 금지)
 * - 위치 기반은 GoalkeeperMovement, 세이브 판정은 GoalkeeperSave,
 *   클레임 판정은 GoalkeeperClaim, 배급은 GoalkeeperDistribution을 재사용한다
 *   (중복 구현 금지 — Brain은 조율만 담당)
 * - 기존 GoalkeeperController API(watchShot/updateDive/checkIntercept/reset)와
 *   호환되는 메서드명을 제공해 시나리오가 점진적으로 이전할 수 있다
 *
 * 담당 범위 (13 항목):
 *   1 기본 위치 선정 · 2 골대 기준 조정 · 3 슈팅 각도 이동 · 4 공 추적
 *   5 캐치 · 6 펀칭 · 7 다이빙
 *   8 1:1 대응 · 9 크로스 대응 · 10 공중볼 대응 · 11 세컨드볼 대응
 *   12 킥/패스 배급 · 13 수비 라인 연계
 */
import { PlayerMovement } from './PlayerMovement.js';
import { PassMovement } from './PassMovement.js';
import { GoalkeeperPerception } from './GoalkeeperPerception.js';
import { GoalkeeperSituation, GK_SITUATION } from './GoalkeeperSituation.js';
import { GoalkeeperDecision, GK_DECISION } from './GoalkeeperDecision.js';
import { GoalkeeperIntent } from './GoalkeeperIntent.js';
import { SAVE_RESULT } from './GoalkeeperSave.js';

const DEFAULTS = {
    ownGoalX: 0,
    dir: 1,                 // +1 = 오른쪽 공격 (자기 골은 왼쪽)
    catchRadius: 11,
    reachHeight: 0.58,      // 손이 닿는 높이 (Ball 0~1 스케일)
    punchSpeed: 420,        // 펀칭初速
    clearDist: 620,         // 쓸어내기 거리
    reactionTime: 0.1,      // 슛 반응 지연
    diveFacing: 90,
    saveMargin: 15,         // 세이브 지점 골라인 앞 제한
    interceptLead: 5,
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class GoalkeeperBrain {
    /**
     * @param {object} options
     *   goalkeeper      {Player}             골키퍼 엔티티
     *   gkMovement      {GoalkeeperMovement} 기본 위치 모듈 (필수)
     *   gkSave          {GoalkeeperSave}     세이브 판정 모듈 (필수)
     *   gkClaim         {GoalkeeperClaim}    클레임 판정 모듈 (선택)
     *   gkDistrib       {GoalkeeperDistribution} 배급 모듈 (선택)
     *   ballMovement    {BallMovement}       볼 상태 참조용 (필수)
     *   gkPlayerMovement{PlayerMovement}     골키퍼 이동 모듈 (없으면 내부 생성)
     *   ownGoalX, dir, catchRadius, ... (DEFAULTS 참조)
     */
    constructor(options = {}) {
        this._gk = options.goalkeeper;
        this._movement = options.gkMovement;
        this._save = options.gkSave;
        this._claim = options.gkClaim ?? null;
        this._distrib = options.gkDistrib ?? null;
        this._bm = options.ballMovement;
        this._pm = options.gkPlayerMovement
            ?? new PlayerMovement(this._gk, { driftScale: 0 });

        this.o = { ...DEFAULTS, ...options };
        this.ownGoalX = options.ownGoalX ?? DEFAULTS.ownGoalX;
        this.dir = options.dir ?? DEFAULTS.dir;

        this._perception = new GoalkeeperPerception({
            ownGoalX: this.ownGoalX, dir: this.dir,
        });
        this._situation = new GoalkeeperSituation(options.situation ?? {});
        this._decision = new GoalkeeperDecision(options.decision ?? {});
        this._intent = new GoalkeeperIntent({
            ownGoalX: this.ownGoalX, dir: this.dir,
            ...(options.intent ?? {}),
        });

        // 슛 추적 상태 (Controller 호환)
        this._saveInfo = null;
        this._diveTarget = null;
        this._reactT = 0;
        this._diving = false;

        // 마지막 파이프라인 결과 (디버그·테스트용)
        this.lastSituation = null;
        this.lastDecision = null;
        this.lastIntent = null;
        this.lastPerception = null;
        this._lastCtx = {};
    }

    get diving() { return this._diving; }
    get saveInfo() { return this._saveInfo; }
    /** 배급 직후 재클레임 금지 구간인지 */
    get locked() { return this._distrib ? this._distrib.locked : false; }
    get distributing() { return this._distrib ? this._distrib.active : false; }

    /**
     * 풀 파이프라인 업데이트 — 오픈플레이 매 프레임 호출한다.
     * 슛 비행 중에는 updateShot()을 대신 호출한다.
     * @param {number} dt
     * @param {object} ctx
     *   opponents {Array}, teammates {Array}, landing {x,y|null},
     *   defenseLineX {number|null}, aerial {boolean}, bouncing {boolean}
     * @returns {{ situation, decision, intent }}
     */
    update(dt, ctx = {}) {
        this._lastCtx = ctx;
        const bm = this._bm;
        const ball = bm.ball;

        // 배급 중이면 배급 모듈에 위임 (움직임은 정지, 볼은 발 앞 고정)
        if (this._distrib && this._distrib.active) {
            this._distrib.update(dt);
            this._pm.stop();
            this._pm.update(dt);
            return this._snapshot();
        }
        // 볼을 품은 순간 배급 시작 (12. 골키퍼 킥/패스)
        if (bm.owner === this._gk && this._distrib && !this._distrib.active && !this._distrib.locked) {
            this._distrib.begin(this._gk, bm, {
                teammates: ctx.teammates ?? [],
                opponents: ctx.opponents ?? [],
            });
            this._pm.stop();
            this._pm.update(dt);
            return this._snapshot();
        }

        // 1. Perception
        const p = this._perception.perceive({
            gk: this._gk,
            ball,
            ballVel: { vx: bm.vx, vy: bm.vy },
            aerial: ctx.aerial ?? bm.isAerial,
            bouncing: ctx.bouncing ?? bm.isBouncing,
            owner: bm.owner,
            landing: ctx.landing ?? null,
            opponents: ctx.opponents ?? [],
            teammates: ctx.teammates ?? [],
            defenseLineX: ctx.defenseLineX ?? null,
            shotTrajectory: this._saveInfo ? this._saveInfo.shotTrajectory : null,
        });

        // 2. Situation
        const situation = this._situation.evaluate(p, {
            gkHasBall: bm.owner === this._gk,
            locked: this.locked,
        });

        // 3. Decision
        let decision = this._decision.decide(p, situation);

        // 클레임 계열은 Claim 모듈로 재확인 (상대 선점 검증 — 중복 방지)
        if (this._claim && (decision.action === GK_DECISION.CLAIM
            || decision.action === GK_DECISION.CLAIM_CROSS)) {
            const verdict = this._claim.evaluate({
                gk: this._gk, ball, ballVel: { vx: bm.vx, vy: bm.vy },
                aerial: p.aerial, bouncing: ctx.bouncing ?? bm.isBouncing,
                owner: bm.owner, landing: p.landing,
                opponents: ctx.opponents ?? [], locked: this.locked,
            });
            if (!verdict.claim) {
                // 무리한 크레임 — 기본 위치로 폴백 (골문 비우기 방지)
                decision = { action: GK_DECISION.HOLD, urgency: 0.4, punch: false, reason: '클레임 불가·복귀' };
                situation.type = GK_SITUATION.POSITIONING;
            }
        }

        // 세컨드볼 — 상대가 압도적으로 가까우면 무리하지 않는다
        if (decision.action === GK_DECISION.SWEEP) {
            if (p.nearestOppBall + 18 < p.gkBallDist && p.gkBallDist > 45) {
                decision = { action: GK_DECISION.HOLD, urgency: 0.4, punch: false, reason: '세컨드볼 경합 열세·복귀' };
                situation.type = GK_SITUATION.POSITIONING;
            }
        }

        // 4. Intent — 기본 위치는 기존 Movement 모듈 재사용 (중복 계산 금지)
        const base = this._movement.update(
            { x: ball.x, y: ball.y, vx: bm.vx, vy: bm.vy },
            this._gk,
        );
        const intent = this._intent.create(p, decision, base);

        // 5. Movement — PlayerMovement에 위임 (회전·가속 중앙화 원칙)
        this._pm.speed = intent.speed;
        this._pm.clearFacingTarget();
        this._pm.setFacingTarget(intent.facingAngle);
        this._pm.moveTo(intent.targetX, intent.targetY);
        this._pm.update(dt);

        // 6. Ball Interaction — 캐치·펀칭·클리어
        this._interact(intent, p);

        this.lastPerception = p;
        this.lastSituation = situation;
        this.lastDecision = decision;
        this.lastIntent = intent;
        return { situation, decision, intent, perception: p };
    }

    /** 슛 발사 시 호출 — 세이브 사전 판정 + 다이빙 예약 (Controller.watchShot 호환) */
    watchShot(trajectory) {
        const evaluation = this._save.evaluateSave(trajectory, this._gk);
        // 세이브 지점을 골라인보다 앞쪽으로 제한 (골라인 동시 체크 방지)
        const cappedX = this.dir > 0
            ? Math.min(evaluation.savePointX, this._save.goalX - this.o.saveMargin)
            : Math.max(evaluation.savePointX, this._save.goalX + this.o.saveMargin);
        this._saveInfo = {
            shotTrajectory: trajectory,
            savePointX: cappedX,
            savePointY: evaluation.savePointY,
            canSave: evaluation.canSave,
            decidedResult: evaluation.result,
        };
        this._reactT = this.o.reactionTime;
        this._diving = true;
        this._diveTarget = { x: cappedX, y: evaluation.savePointY };
    }

    /** 감시·다이빙 해제 (빗나가는 슛·리셋용, Controller.reset 호환) */
    reset() {
        this._diving = false;
        this._reactT = 0;
        this._diveTarget = null;
        this._saveInfo = null;
        this.lastSituation = null;
        this.lastDecision = null;
        this.lastIntent = null;
    }

    /** 기존 Controller.updatePosition 호환 — 오픈플레이 위치 조정만 수행 */
    updatePosition(dt, ctx = null) {
        return this.update(dt, ctx ?? this._lastCtx ?? {});
    }

    /** 슛 비행 중 매 프레임 호출 — 반응 지연 후 다이브 목표로 이동 */
    updateDive(dt) {
        if (this._reactT > 0) this._reactT -= dt;
        if (this._diving && this._reactT <= 0 && this._diveTarget) {
            this._pm.speed = PlayerMovement.SPEEDS[4];
            this._pm.clearFacingTarget();
            this._pm.setFacingTarget(this.o.diveFacing);
            this._pm.moveTo(this._diveTarget.x, this._diveTarget.y);
        }
        this._pm.update(dt);
    }

    /** 슛 비행 전용 업데이트 — updateDive + checkIntercept를 한 번에 */
    updateShot(dt) {
        this.updateDive(dt);
        return this.checkIntercept();
    }

    /**
     * 세이브 지점 도달 시 판정 (Controller.checkIntercept 호환)
     * @returns {null | { saved: boolean, saveType?: string }}
     */
    checkIntercept() {
        const info = this._saveInfo;
        if (!info || info.intercepted) return null;
        const ball = this._bm.ball;
        const reached = this.dir > 0
            ? ball.x >= info.savePointX - this.o.interceptLead
            : ball.x <= info.savePointX + this.o.interceptLead;
        if (!reached) return null;
        info.intercepted = true;

        const gd = Math.hypot(
            this._gk.x - info.savePointX,
            this._gk.y - info.savePointY,
        );
        if (gd >= this._save.reachRadius) {
            this._saveInfo = null;
            return { saved: false };
        }

        const saveType = this._save.determineSaveType(
            info.shotTrajectory,
            this._gk,
            { x: info.savePointX, y: info.savePointY },
        );
        if (saveType === SAVE_RESULT.GOAL) {
            this._saveInfo = null;
            return { saved: false };
        }

        if (saveType === SAVE_RESULT.CATCH) {
            // 5. 캐치 — 공을 골키퍼 앞(필드 방향)에 고정
            ball.setPosition(info.savePointX - this.dir * 12, info.savePointY);
            ball.setHeight(0);
        } else {
            // 6. 펀칭·쳐내기 — 기존 deflection을 펀칭으로 처리 (멀리·높게)
            const deflection = this._save.calculateDeflection(
                saveType,
                { x: info.savePointX, y: info.savePointY },
                info.shotTrajectory,
            );
            ball.setPosition(info.savePointX - this.dir * 8, info.savePointY);
            this._bm.release(deflection.vx, deflection.vy);
        }
        return { saved: true, saveType };
    }

    /* ── private ─────────────────────────────────── */

    _snapshot() {
        return {
            situation: this.lastSituation,
            decision: this.lastDecision,
            intent: this.lastIntent,
            perception: this.lastPerception,
        };
    }

    /** 캐치·펀칭·클리어 실행 */
    _interact(intent, p) {
        const bm = this._bm;
        const ball = bm.ball;
        if (bm.owner) return; // 소유 중 볼은 건드리지 않는다
        const type = intent.interaction?.type ?? 'none';
        const gkToBall = Math.hypot(this._gk.x - ball.x, this._gk.y - ball.y);
        const height = ball.height ?? 0;

        if (type === 'catch') {
            // 5. 캐치 — 손 닿는 높이 + 몸 근처에서만 성립
            if (height <= this.o.reachHeight && gkToBall <= this.o.catchRadius + 7) {
                bm.possess(this._gk, this.o.catchRadius + 7);
                bm.snapToFront();
            }
        } else if (type === 'punch') {
            // 6. 펀칭 — 캐치 불가(높음·혼전) 시 멀리 쳐낸다
            if (gkToBall <= this._save.reachRadius + 6) {
                this._punch(ball, p);
            }
        } else if (type === 'clear') {
            // 11. 세컨드볼 쓸어내기 — 닿으면 측면으로 길게 걷어낸다
            if (gkToBall <= this.o.catchRadius + 5 && height <= this.o.reachHeight) {
                const side = ball.y >= p.goal.centerY ? 1 : -1;
                const aimX = clamp(
                    ball.x + this.dir * this.o.clearDist * 0.7, 25, 1025,
                );
                const aimY = clamp(ball.y + side * 180, 45, 635);
                PassMovement.longPass(bm, aimX, aimY, {
                    flightDuration: 0.9,
                    maxHeight: 0.7,
                    bounce: { duration: 0.38, maxHeight: 0.26, velocityScale: 0.5 },
                });
            }
        }
    }

    /** 펀칭 — 골대에서 멀어지는 방향으로 강하게 쳐낸다 */
    _punch(ball, p) {
        const side = ball.y > p.goal.centerY ? 1 : ball.y < p.goal.centerY ? -1 : (Math.random() < 0.5 ? -1 : 1);
        const vx = this.dir * this.o.punchSpeed * 0.85;
        const vy = side * this.o.punchSpeed * (0.55 + Math.random() * 0.25);
        // 공중 펀칭 — 혼전에서 바로 발 앞에 떨어지지 않게 띄운다
        const dist = Math.hypot(vx, vy);
        const duration = clamp(dist / 480, 0.5, 0.9);
        this._bm.releaseAerial(vx, vy, duration, 0.55 + Math.random() * 0.15, null, {
            duration: 0.38, maxHeight: 0.26, velocityScale: 0.5,
        });
    }
}
