/**
 * SetPieceController - 세트피스 진행 공통 오케스트레이터
 *
 * 경기 재개 전체 흐름을 소유한다 (시나리오는 종류·지점·선수만 넘긴다):
 *   SETUP  공·선수 목표 계산(Placement) → PlayerMovement로 이동
 *   READY  전원 배치 완료 + 공 정지 → 재개 신호 대기
 *   KICK   키커가 킥 실행 (PassMovement — 지면·공중 자동 선택)
 *   LIVE   BallInPlay 인플레이 판정 → 경기 중 (후속은 호출자 몫)
 *
 * 중요:
 * - 시나리오에서 공을 직접 순간이동시키지 않는다.
 *   공 배치는 이 모듈의 placeBall() 단일 창구로만 수행한다 (데드볼 표시 포함).
 * - 선수 이동은 항상 PlayerMovement에 위임한다 (회전·가속 중앙화 원칙).
 * - 킥은 PassMovement에 위임한다 (물리 중복 구현 금지).
 * - 오프사이드 확장을 위해 getOffsideContext()를 그대로 노출한다.
 */
import { PlayerMovement } from './PlayerMovement.js';
import { PassMovement } from './PassMovement.js';
import { angleTo } from './Direction.js';
import { SET_PIECE, SET_PIECE_RULE, freeKickGoalRule, goalsForDir } from './SetPieceType.js';
import { BallInPlay } from './BallInPlay.js';
import { SetPiecePlacement } from './SetPiecePlacement.js';

export const SETUP_PHASE = Object.freeze({
    IDLE: 'idle',
    SETUP: 'setup',
    READY: 'ready',
    KICK: 'kick',
    LIVE: 'live',
});

const DEFAULTS = {
    arriveRadius: 14,   // 배치 완료 판정 반경
    setupTimeout: 6,    // 셋업 최대 시간 (초) — 초과 시 강제 READY
    cornerAerial: true, // 코너·골킥은 공중으로
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class SetPieceController {
    /**
     * @param {object} options
     *   ball {Ball}, ballMovement {BallMovement},
     *   placement {SetPiecePlacement}, inPlay {BallInPlay}
     */
    constructor(options = {}) {
        this._ball = options.ball;
        this._bm = options.ballMovement;
        this._placement = options.placement ?? new SetPiecePlacement({});
        this._inPlay = options.inPlay ?? new BallInPlay({});
        this.o = { ...DEFAULTS, ...options };

        this.phase = SETUP_PHASE.IDLE;
        this._type = null;
        this._dir = 1;
        this._direct = true;
        this._spot = null;
        this._kicker = null;
        this._kickTarget = null;
        this._units = []; // [{ player, movement }]
        this._setupT = 0;
    }

    get inPlay() { return this._inPlay; }
    get spot() { return this._spot; }
    /** 오프사이드 연계용 — BallInPlay 컨텍스트를 그대로 노출한다. */
    getOffsideContext() { return this._inPlay.getOffsideContext(); }

    /**
     * 재개를 시작한다.
     * @param {object} cfg
     *   type {string} SET_PIECE 종류
     *   dir {number} 공격 방향 (+1 = 오른쪽 공격)
     *   direct {boolean} 프리킥 직접 여부 (기본 true)
     *   kicker {Player} 키커
     *   units [{ player, movement }] 전원 (키커 포함, 골키퍼 포함 가능)
     *   attackers {Array<Player>} 공격 배치 대상 (미지정 시 units 중 키커 제외 전원)
     *   defenders {Array<Player>} 수비 배치 대상 (미지정 시 빈 배열)
     *   spotCtx {object} ballSpot 계산용 (exitX/exitY/foulX/... )
     *   kickTarget {x,y} 킥 목표 (미지정 시 전방 200)
     */
    begin(cfg = {}) {
        this._type = cfg.type;
        this._dir = cfg.dir ?? 1;
        this._direct = cfg.direct ?? true;
        this._kicker = cfg.kicker ?? null;
        this._units = cfg.units ?? [];
        this._kickTarget = cfg.kickTarget ?? null;

        const spot = this._placement.ballSpot(this._type, { dir: this._dir, ...(cfg.spotCtx ?? {}) });
        this._spot = spot;
        this._inPlay.openRestart(this._type, spot, { kicker: this._kicker, direct: this._direct });

        // 배치 목표 계산 (공격 10 · 수비 9 — 호출자가 준 명단 그대로, 하드코딩 없음)
        const attackers = cfg.attackers ?? this._units.map((u) => u.player).filter((p) => p !== this._kicker);
        const defenders = cfg.defenders ?? [];
        this._attackPlan = this._placement.attackShape(this._type, attackers, {
            dir: this._dir, spot, kicker: this._kicker,
        });
        this._defensePlan = this._placement.defenseShape(this._type, defenders, {
            dir: this._dir, spot,
        });

        // 상대 제한 적용 (수비 플랜에만 — 공격은 자유 배치)
        const rule = this._rule();
        this._placement.enforceRestriction(this._defensePlan, spot, {
            minDist: rule.oppMinDist,
            boxBlock: rule.oppOutsideBoxUntilKick === true,
            inBox: rule.oppOutsideBoxUntilKick === true ? this._defBoxTest() : null,
        });

        this.phase = SETUP_PHASE.SETUP;
        this._setupT = 0;
    }

    /**
     * 매 프레임 호출한다.
     * @param {number} dt
     * @returns {{ phase, ready, live }}
     */
    update(dt) {
        if (this.phase === SETUP_PHASE.IDLE || this.phase === SETUP_PHASE.LIVE) {
            return { phase: this.phase, ready: false, live: this.phase === SETUP_PHASE.LIVE };
        }

        // ── SETUP: 공 배치(단일 창구) + 선수 이동 ──
        if (this.phase === SETUP_PHASE.SETUP) {
            this.placeBall(this._spot.x, this._spot.y);
            this._setupT += dt;
            const done = this._moveUnits(dt);
            if (done || this._setupT > this.o.setupTimeout) {
                this.phase = SETUP_PHASE.READY;
                this._inPlay.markReady();
            }
            return { phase: this.phase, ready: this.phase === SETUP_PHASE.READY, live: false };
        }

        // ── READY: 정지 확인 후 킥 대기 — 호출자가 tryKick()을 호출한다 ──
        if (this.phase === SETUP_PHASE.READY) {
            this.placeBall(this._spot.x, this._spot.y);
            this._holdUnits(dt);
            return { phase: this.phase, ready: true, live: false };
        }

        // ── KICK: 킥 직후 1프레임 — 인플레이 판정 ──
        if (this.phase === SETUP_PHASE.KICK) {
            const res = this._inPlay.registerKick(this._lastKick);
            this.phase = res.live ? SETUP_PHASE.LIVE : SETUP_PHASE.READY;
            return { phase: this.phase, ready: !res.live, live: res.live };
        }

        return { phase: this.phase, ready: false, live: false };
    }

    /**
     * 공 배치 단일 창구 — 시나리오는 이 메서드 대신 공을 직접 옮기지 않는다.
     * 데드볼이므로 소유 해제 + 정지 + spot 고정한다.
     */
    placeBall(x, y) {
        this._bm.release(0, 0);
        this._ball.setPosition(x, y);
        this._ball.setHeight(0);
    }

    /**
     * 킥 실행 — READY일 때만 동작한다.
     * @param {object} target { x, y } 미지정 시 kickTarget 또는 전방 200
     * @param {object} opts { aerial } 미지정 시 종류별 자동 (코너·골킥·페널티클리어=공중)
     * @returns {boolean} 킥 성공 여부
     */
    tryKick(target = null, opts = {}) {
        if (this.phase !== SETUP_PHASE.READY) return false;
        if (!this._kicker) return false;
        const t = target ?? this._kickTarget ?? {
            x: this._spot.x + this._dir * 200, y: this._spot.y,
        };
        // 키커를 목표 방향으로 정렬 (순간 회전 금지 — 각도는 맞추되 물리는 Movement가 처리)
        this._kicker.setAngle(angleTo(this._kicker.x, this._kicker.y, t.x, t.y));
        this._bm.release(0, 0);
        this._ball.setPosition(this._spot.x, this._spot.y);

        const aerial = opts.aerial
            ?? (this.o.cornerAerial && (this._type === SET_PIECE.CORNER || this._type === SET_PIECE.GOAL_KICK));
        let speed = 0;
        if (aerial) {
            const dist = Math.hypot(t.x - this._spot.x, t.y - this._spot.y);
            const dur = clamp(dist / 330, 0.65, 1.4);
            const r = PassMovement.longPass(this._bm, t.x, t.y, {
                flightDuration: dur, maxHeight: 0.75 + Math.random() * 0.15,
                bounce: { duration: 0.38, maxHeight: 0.26, velocityScale: 0.5 },
            });
            speed = dist / Math.max(0.01, r.flightDuration);
        } else {
            const r = PassMovement.shortPass(this._bm, t.x, t.y, { arriveSpeed: 150 });
            speed = r.initialSpeed;
        }
        this._lastKick = {
            speed,
            fromX: this._spot.x,
            fromY: this._spot.y,
            enteredField: this._type === SET_PIECE.THROW_IN
                ? this._throwEntered(t) : true,
        };
        this.phase = SETUP_PHASE.KICK;
        return true;
    }

    /** 강제 종료 (시나리오 전환용). */
    reset() {
        this.phase = SETUP_PHASE.IDLE;
        this._inPlay.reset();
        for (const u of this._units) u.movement.stop();
        this._units = [];
        this._attackPlan = [];
        this._defensePlan = [];
    }

    /* ── private ─────────────────────────────────── */

    _rule() {
        const base = SET_PIECE_RULE[this._type] ?? { oppMinDist: 91.5 };
        if (this._type === SET_PIECE.FREE_KICK) {
            const g = freeKickGoalRule(this._direct);
            return { ...base, ...g };
        }
        return base;
    }

    _defBoxTest() {
        // 수비 박스 = 공격 골 앞 박스 (dir 기준 반대편이 아니라 공격 대상 앞)
        const { attackGoalX } = goalsForDir(this._dir);
        const dirToDef = this._dir > 0 ? 1 : -1; // 박스 깊이 방향 (골라인에서 필드 쪽)
        void dirToDef;
        const inBox = (x, y) => {
            const xMin = Math.min(attackGoalX, attackGoalX - this._dir * 165);
            const xMax = Math.max(attackGoalX, attackGoalX - this._dir * 165);
            return x >= xMin && x <= xMax && y >= 138.4 && y <= 541.6;
        };
        const guard = this._placement.boxGuard(attackGoalX, this._dir);
        return Object.assign(inBox, { exitX: guard.exitX });
    }

    /** 배치 목표대로 이동 — 전원 도착 시 true */
    _moveUnits(dt) {
        const plans = [...(this._attackPlan ?? []), ...(this._defensePlan ?? [])];
        const byPlayer = new Map(plans.map((p) => [p.player, p]));
        // 키커는 공 위치로
        if (this._kicker) byPlayer.set(this._kicker, {
            player: this._kicker,
            x: this._spot.x - this._dir * 18,
            y: this._spot.y + 8,
            role: 'kicker',
        });
        let allDone = true;
        for (const u of this._units) {
            const plan = byPlayer.get(u.player);
            if (!plan) { u.movement.update(dt); continue; }
            const d = Math.hypot(u.player.x - plan.x, u.player.y - plan.y);
            if (d > this.o.arriveRadius) {
                allDone = false;
                u.movement.speed = d > 120
                    ? PlayerMovement.SPEEDS[4] : PlayerMovement.SPEEDS[2];
                u.movement.clearFacingTarget();
                u.movement.moveTo(plan.x, plan.y);
            } else {
                u.movement.stop();
                u.movement.setFacingTarget(angleTo(u.player.x, u.player.y, this._spot.x, this._spot.y));
            }
            u.movement.update(dt);
        }
        return allDone;
    }

    _holdUnits(dt) {
        for (const u of this._units) u.movement.update(dt);
    }

    _throwEntered(t) {
        // 스로인 목표가 필드 안이면 입장으로 본다
        return t.y > 0 && t.y < 680 && t.x > 0 && t.x < 1050;
    }
}
