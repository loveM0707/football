/**
 * BallInPlay - 볼 인플레이 상태 기계 공통 모듈
 *
 * 각 재개 방식의 아래 5가지를 명확히 분리한다 (작업 요구사항).
 *   - 공 위치: spot (SetPiecePlacement가 계산, 여기는 검증·보관만)
 *   - 선수 위치: 관여하지 않음 (Placement·Controller 담당)
 *   - 상대 선수 제한: 거리 규칙 위반 여부 판정만
 *   - 플레이 재개 조건: setup 완료 + 심판 휘슬(호출자 신호)
 *   - 공이 인플레이되는 조건: 종류별 킥·이동·터치 규칙
 *
 * 상태 흐름: DEAD → READY → LIVE
 *   DEAD:  공 배치 전/이동 중 — 플레이 금지
 *   READY: 공이 spot에 정지 + 재개 신호 대기 — 킥 전
 *   LIVE:  인플레이 조건 충족 — 경기 중
 *
 * 간접·스로인·킥오프의 두 번째 터치 규칙과 키커 재터치 금지를 함께 추적한다.
 * 향후 오프사이드 연계를 위해 getOffsideContext()를 제공한다 (확장 지점).
 */
import { SET_PIECE, SET_PIECE_RULE, freeKickGoalRule } from './SetPieceType.js';

export const BALL_STATE = Object.freeze({
    DEAD: 'dead',
    READY: 'ready',
    LIVE: 'live',
});

const DEFAULTS = {
    moveEpsilon: 5,     // 킥오프 "분명히 움직임" 판정 거리 (SVG)
    minKickSpeed: 60,   // 킥 최소 속도 (SVG/s) — 그 이하 release는 무효
};

export class BallInPlay {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this.state = BALL_STATE.DEAD;
        this.type = null;
        this.direct = true;
        this.spot = null;       // { x, y }
        this.touches = [];      // [{ player, kind }] — 두 번째 터치 판정용
        this.kicker = null;
        this._movedFrom = null;
    }

    /** 새로운 재개를 연다 (공 배치 전). */
    openRestart(type, spot, options = {}) {
        this.state = BALL_STATE.DEAD;
        this.type = type;
        this.direct = options.direct ?? true;
        this.spot = { x: spot.x, y: spot.y };
        this.touches = [];
        this.kicker = options.kicker ?? null;
        this._movedFrom = null;
    }

    /** 공이 spot에 정지하면 호출 — 재개 신호 대기 상태로 전환한다. */
    markReady() {
        if (this.state !== BALL_STATE.DEAD) return;
        this.state = BALL_STATE.READY;
    }

    get isLive() { return this.state === BALL_STATE.LIVE; }
    get isReady() { return this.state === BALL_STATE.READY; }

    /**
     * 상대 제한 위반 여부를 판정한다 (위치 계산이 아니라 판정만 담당).
     * @param {{ x, y }} oppPos 상대 위치
     * @param {object} ruleCtx { minDist, boxBlock } — Controller가 규칙표+상황에서 조립
     * @returns {boolean} 위반이면 true
     */
    static isOpponentViolation(oppPos, ballPos, ruleCtx) {
        const d = Math.hypot(oppPos.x - ballPos.x, oppPos.y - ballPos.y);
        if (d < (ruleCtx.minDist ?? 0) - 1e-6) return true;
        if (ruleCtx.boxBlock && ruleCtx.inBox && ruleCtx.inBox(oppPos.x, oppPos.y)) return true;
        return false;
    }

    /**
     * 킥 실행을 기록하고 인플레이 조건을 판정한다.
     * Controller가 PassMovement 등으로 release한 직후 호출한다.
     * @param {object} kick { speed, fromX, fromY, enteredField }
     * @returns {{ live: boolean, reason: string }}
     */
    registerKick(kick = {}) {
        if (this.state !== BALL_STATE.READY) {
            return { live: false, reason: '준비 상태 아님' };
        }
        const speed = kick.speed ?? 0;
        if (speed < this.o.minKickSpeed) {
            return { live: false, reason: '킥 속도 부족' };
        }
        // 스로인은 필드 안으로 들어와야 인플레이
        if (this.type === SET_PIECE.THROW_IN && kick.enteredField === false) {
            return { live: false, reason: '스로인 미입장' };
        }
        this.state = BALL_STATE.LIVE;
        this._movedFrom = { x: kick.fromX, y: kick.fromY };
        if (this.kicker) this.touches.push({ player: this.kicker, kind: 'kick' });
        return { live: true, reason: '인플레이' };
    }

    /** 킥오프는 "분명히 움직임" 추가 확인 — 이동량 미달 시 아직 DEAD 취급. */
    confirmKickoffMove(ballPos) {
        if (this.type !== SET_PIECE.KICKOFF || this.state !== BALL_STATE.LIVE) return true;
        if (!this._movedFrom) return true;
        const moved = Math.hypot(ballPos.x - this._movedFrom.x, ballPos.y - this._movedFrom.y);
        return moved >= this.o.moveEpsilon;
    }

    /** 볼 터치를 기록한다 (간접 득점·키커 재터치 판정용). */
    registerTouch(player, kind = 'touch') {
        this.touches.push({ player, kind });
    }

    /** 키커가 다른 선수 터치 전에 다시 건드리면 true (재터치 반칙). */
    isKickerRetouch(player) {
        if (!this.kicker || this.touches.length === 0) return false;
        if (player !== this.kicker) return false;
        // 킥 이후 다른 선수의 터치가 하나라도 있으면 정상
        return !this.touches.slice(1).some((t) => t.player !== this.kicker);
    }

    /** 이 재개에서 나온 골이 유효한지 판정한다. */
    isGoalValid() {
        const base = SET_PIECE_RULE[this.type];
        if (!base) return { valid: false, reason: '알 수 없는 재개' };
        let needsSecond = base.needsSecondTouchForGoal;
        if (this.type === SET_PIECE.FREE_KICK) {
            needsSecond = freeKickGoalRule(this.direct).needsSecondTouchForGoal;
        }
        if (!needsSecond) return { valid: true, reason: '직접 득점 가능' };
        // 간접 계열 — 킥 외 다른 선수의 터치가 있어야 유효
        const second = this.touches.slice(1).some((t) => t.player !== this.kicker);
        if (second) return { valid: true, reason: '두 번째 터치 후 득점' };
        return { valid: false, reason: '간접 — 두 번째 터치 없음' };
    }

    /**
     * 향후 오프사이드 연계용 컨텍스트 (확장 지점).
     * 오프사이드 모듈이 세컨드-라스트·킥 시점을 물을 때 이 구조를 그대로 쓴다.
     */
    getOffsideContext() {
        return {
            restartType: this.type,
            kickSpot: this.spot ? { ...this.spot } : null,
            kicker: this.kicker,
            live: this.isLive,
            // 다음 확장: secondLastOppX, kickMoment, phase
            secondLastOppX: null,
            kickMoment: null,
        };
    }

    /** 강제 리셋 (시나리오 종료·전환용). */
    reset() {
        this.state = BALL_STATE.DEAD;
        this.type = null;
        this.spot = null;
        this.touches = [];
        this.kicker = null;
        this._movedFrom = null;
    }
}
