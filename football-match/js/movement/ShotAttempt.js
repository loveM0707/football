/**
 * ShotAttempt - 슈팅 발사 오케스트레이션 공통 모듈
 *
 * "슛을 차는 순서"를 한 곳에서만 정의한다.
 * 기존에 슈팅·슈팅(GK)·1:1·2:2·3:3 시나리오 5곳에 복사되어 있던
 * 조준→몸 정렬→소유 해제→발사→궤적 생성 순서를 이 모듈 하나로 통합한다.
 *
 * 파이프라인 (Intent → Execution → Physics):
 *   Intent    ShotExecution.plan (노리는 지점 + 오차 + 힘)
 *   Execution 몸을 목표에 정렬하고 소유를 해제한 뒤 ShotMovement.shoot
 *   Physics   이후 볼 이동·골 판정은 ShotMovement가 담당
 *
 * "언제 찰지" 판단(ShotDecision)과 세이브 감시(GoalkeeperController)는
 * 호출자(시나리오/AI)가 그대로 소유한다.
 */
import { ShotExecution } from './ShotExecution.js';

export class ShotAttempt {
    /**
     * @param {object} options
     *   shotExec {ShotExecution} 조준·오차·힘 모듈 (기본값: 기본 설정 인스턴스)
     */
    constructor(options = {}) {
        this._exec = options.shotExec ?? new ShotExecution();
    }

    /**
     * 슈팅을 발사한다.
     *
     * @param {object} ctx
     *   shooter      {Player}         슈터 ({x, y, angle})
     *   movement     {PlayerMovement} 슈터 이동 모듈 (몸 정렬·속도 참조용)
     *   dribble      {DribbleController} 소유 중인 드리블 (발사 시 정지, 선택)
     *   ballMovement {BallMovement}   볼 (소유 중이어야 발사)
     *   shot         {ShotMovement}   발사할 슛 물리 인스턴스
     *   goalX        {number}         목표 골라인 X
     *   aimY         {number}         노리는 지점 (없으면 모듈이 결정)
     *   defenders    {Array}          압박 계산용 상대 (선택)
     *   accuracy     {number}         정확도 보정 0~1 (선택)
     * @returns {{ fired: boolean, plan?, trajectory? }}
     *   fired=false면 plan/trajectory 없음 (소유 없음 등)
     */
    fire(ctx) {
        const bm = ctx.ballMovement;
        if (!bm || !bm.owner) return { fired: false };

        const shooter = ctx.shooter;
        const goalX = ctx.goalX;

        // ── Intent: 노리는 지점·오차·힘 (슈터 이동 속도 반영) ──
        const plan = this._exec.plan({
            ball: bm.ball,
            goalX,
            shooter,
            aimY: ctx.aimY,
            defenders: ctx.defenders,
            accuracy: ctx.accuracy,
            shooterSpeed: ctx.movement ? ctx.movement.speed : 0,
        });

        // ── Execution: 몸 정렬 → 소유 해제 → 발사 ──
        if (ctx.movement) {
            ctx.movement.stop();
            ctx.movement.resetTurn(plan.aimAngle);
            ctx.movement.setFacingTarget(plan.aimAngle);
        }
        if (ctx.dribble) ctx.dribble.stop();
        const fired = ctx.shot.shoot(bm, ShotExecution.toShootOptions(plan, goalX));
        if (!fired) return { fired: false };

        return {
            fired: true,
            plan,
            trajectory: ShotExecution.toTrajectory(plan, bm.ball, goalX),
        };
    }
}
