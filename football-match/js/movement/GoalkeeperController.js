/**
 * GoalkeeperController - 골키퍼 위치·다이브·세이브 감시 공통 모듈
 *
 * 드리블 중 위치 조정(GoalkeeperMovement)부터 슈팅 비행 중 다이브와
 * 세이브 지점 감시(GoalkeeperSave)까지 골키퍼의 경기 중 행동을 소유한다.
 * 기존에 슈팅·1:1·2:2·헤딩슛·크로스 시나리오 5곳에 복사되어 있던
 * 위치 이동·다이브·세이브 판정 블록을 이 모듈 하나로 통합한다.
 *
 * 책임 분리:
 *   - 이 모듈: GK가 "어떻게 움직이고 언제 잡는가" (위치·다이브·감시·볼 처리)
 *   - 시나리오: 슈팅 "궤적 생성"과 세이브 "결과 연출" (saveTimer·점수·리셋)
 *   - 슛 발사 오케스트레이션(조준·발사)은 별도 공통화 대상 (A4)
 *
 * 사용법:
 *   const gkc = new GoalkeeperController({ goalkeeper, gkMovement, gkSave, ballMovement });
 *   // 드리블 중 매 프레임: gkc.updatePosition(dt);
 *   // 슈팅 발사 시: gkc.watchShot(trajectory) 또는 빗나가면 gkc.reset();
 *   // 슈팅 비행 중 매 프레임: gkc.updateDive(dt); const hit = gkc.checkIntercept();
 *   //   hit === null → 아직 도달 전, { saved:false } → 실패(슛 계속),
 *   //   { saved:true, saveType } → 성공(볼 처리 완료, 시나리오는 연출만)
 */
import { SAVE_RESULT } from './GoalkeeperSave.js';

const DEFAULT_POSITION_SPEED = 350; // 5개 시나리오 공통 위치 조정 속도
const DEFAULT_DIVE_SPEED = 450;
const DEFAULT_REACTION_TIME = 0.1;
const SAVE_POINT_MARGIN = 15; // 세이브 지점을 골라인보다 앞쪽으로 제한 (골라인 동시 체크 방지)
const INTERCEPT_LEAD = 5;     // 세이브 지점 도달 판정 여유

/** 엔티티를 목표까지 속도로 이동시킨다 (1 SVG 이내면 정지). */
function moveToward(entity, tx, ty, speed, dt) {
    const dx = tx - entity.x;
    const dy = ty - entity.y;
    const d = Math.hypot(dx, dy);
    if (d > 1) {
        const s = Math.min(speed * dt, d);
        entity.setPosition(entity.x + (dx / d) * s, entity.y + (dy / d) * s);
    }
}

export class GoalkeeperController {
    /**
     * @param {object} options
     *   goalkeeper    {Player}         골키퍼 엔티티
     *   gkMovement    {GoalkeeperMovement} 위치 계산 모듈
     *   gkSave        {GoalkeeperSave} 세이브 판정 모듈
     *   ballMovement  {BallMovement}   볼 상태 참조용
     *   positionSpeed {number}  위치 조정 속도 (기본 350)
     *   diveSpeed     {number}  다이브 속도
     *   reactionTime  {number}  슈팅 후 반응 지연 (초)
     *   dir           {number}  공격 방향 (+1 = 오른쪽 골 공격, -1 = 왼쪽)
     *   diveFacing    {number}  다이브 중 바라볼 각도 (기본 90 = 왼쪽)
     */
    constructor(options = {}) {
        this._gk = options.goalkeeper;
        this._movement = options.gkMovement;
        this._save = options.gkSave;
        this._bm = options.ballMovement;
        this._positionSpeed = options.positionSpeed ?? DEFAULT_POSITION_SPEED;
        this._diveSpeed = options.diveSpeed ?? DEFAULT_DIVE_SPEED;
        this._reactionTime = options.reactionTime ?? DEFAULT_REACTION_TIME;
        this._dir = options.dir ?? 1;
        this._diveFacing = options.diveFacing ?? 90;

        this._diving = false;
        this._reactT = 0;
        this._diveTarget = null;
        this._saveInfo = null;
    }

    /** 현재 세이브 감시 정보 (포스트 판정용 decidedResult 참조 가능) */
    get saveInfo() { return this._saveInfo; }

    /** 다이브 중인지 */
    get diving() { return this._diving; }

    /**
     * 드리블 중 매 프레임 호출 — 골대 기하 기반 위치로 이동하고 공을 바라본다.
     * @returns {object} 목표 위치 { x, y, facingAngle }
     */
    updatePosition(dt) {
        const ball = this._bm.ball;
        const target = this._movement.update(
            { x: ball.x, y: ball.y, vx: this._bm.vx, vy: this._bm.vy },
            this._gk,
        );
        moveToward(this._gk, target.x, target.y, this._positionSpeed, dt);
        this._gk.setAngle(target.facingAngle);
        return target;
    }

    /**
     * 슈팅 궤적(ShotExecution.toTrajectory 형태)을 받아 세이브를 사전 판정하고
     * 다이브를 예약한다. 빗나가는 슛에는 호출하지 말고 reset()을 호출한다.
     */
    watchShot(trajectory) {
        const evaluation = this._save.evaluateSave(trajectory, this._gk);
        // 세이브 지점을 골라인보다 앞쪽으로 제한
        const cappedX = this._dir > 0
            ? Math.min(evaluation.savePointX, this._save.goalX - SAVE_POINT_MARGIN)
            : Math.max(evaluation.savePointX, this._save.goalX + SAVE_POINT_MARGIN);
        this._saveInfo = {
            shotTrajectory: trajectory,
            savePointX: cappedX,
            savePointY: evaluation.savePointY,
            canSave: evaluation.canSave,
            decidedResult: evaluation.result,
        };
        // 골키퍼 다이브 시작 (반응 지연 후)
        this._reactT = this._reactionTime;
        this._diving = true;
        this._diveTarget = { x: cappedX, y: evaluation.savePointY };
    }

    /** 감시·다이브 상태를 해제한다 (빗나가는 슛, 시나리오 반복 리셋). */
    reset() {
        this._diving = false;
        this._reactT = 0;
        this._diveTarget = null;
        this._saveInfo = null;
    }

    /** 슈팅 비행 중 매 프레임 호출 — 반응 지연 후 다이브 목표로 이동한다. */
    updateDive(dt) {
        if (this._reactT > 0) this._reactT -= dt;
        if (this._diving && this._reactT <= 0 && this._diveTarget) {
            moveToward(this._gk, this._diveTarget.x, this._diveTarget.y, this._diveSpeed, dt);
            // 공이 오는 방향(필드 쪽)을 바라본다
            this._gk.setAngle(this._diveFacing);
        }
    }

    /**
     * 세이브 지점 도달 시 판정한다.
     * @returns {null | { saved: boolean, saveType?: string }}
     *   null → 감시 중이 아니거나 아직 도달 전
     *   { saved: false } → GK 실패 (감시 해제됨, 슛 계속)
     *   { saved: true, saveType } → 성공 (볼 재배치·튕김까지 완료)
     */
    checkIntercept() {
        const info = this._saveInfo;
        if (!info || info.intercepted) return null;
        const ball = this._bm.ball;
        const reached = this._dir > 0
            ? ball.x >= info.savePointX - INTERCEPT_LEAD
            : ball.x <= info.savePointX + INTERCEPT_LEAD;
        if (!reached) return null;
        info.intercepted = true;

        // 골키퍼가 세이브 지점에 충분히 가까운지 확인
        const gd = Math.hypot(
            this._gk.x - info.savePointX,
            this._gk.y - info.savePointY,
        );
        if (gd >= this._save.reachRadius) {
            // 도달하지 못함 → 공이 계속 골라인으로 향함
            this._saveInfo = null;
            return { saved: false };
        }

        const saveType = this._save.determineSaveType(
            info.shotTrajectory,
            this._gk,
            { x: info.savePointX, y: info.savePointY },
        );
        if (saveType === SAVE_RESULT.GOAL) {
            // 가까이 있지만 쳐내지 못함 → 슛 계속
            this._saveInfo = null;
            return { saved: false };
        }

        if (saveType === SAVE_RESULT.CATCH) {
            // 잡기: 공을 골키퍼 앞쪽(필드 방향)에 둔다
            ball.setPosition(info.savePointX - this._dir * 12, info.savePointY);
            ball.setHeight(0);
        } else {
            // 쳐내기(PARRY/DEFLECTION): 공을 골키퍼 앞쪽에서 튕긴다
            const deflection = this._save.calculateDeflection(
                saveType,
                { x: info.savePointX, y: info.savePointY },
                info.shotTrajectory,
            );
            ball.setPosition(info.savePointX - this._dir * 8, info.savePointY);
            this._bm.release(deflection.vx, deflection.vy);
        }
        return { saved: true, saveType };
    }
}
