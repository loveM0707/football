/**
 * MatchState - 경기·팀 상태 공통 모듈
 *
 * 소유권 변화를 감지해 팀 상태를 전이시킨다.
 * 시나리오의 타이머·상태머신(OneVsOne ATTACK/RETURN,
 * ThreeVsThree OPEN/CONTEST/LOOSE)을 대체하는 단일 진실 공급원이다.
 *
 * 흐름:
 *   Possession Change → Team State 변경 → (Controller가 Role/Decision/Intent 갱신)
 *
 * 팀 상태:
 *   ATTACK              볼 소유 중 (안정 공격)
 *   DEFENSE             상대 소유 중 (안정 수비)
 *   TRANSITION_ATTACK   탈취 직후 (역습 창구)
 *   TRANSITION_DEFENSE  상실 직후 (역압박 창구)
 *   LOOSE               무소유 (루즈볼·공중·세트피스 준비는 호출자 판단)
 *
 * 전환 창구(transition window) 동안만 역습·역압박이 유효하고,
 * 창구가 닫히면 안정 상태로 복귀한다. 시간은 이 모듈이 소유하므로
 * 시나리오는 타이머를 직접 다루지 않는다.
 *
 * 11v11 확장: 선수별 반응 차이는 reactionOf()로 조회한다.
 */
export const TEAM_STATE = Object.freeze({
    ATTACK: 'attack',
    DEFENSE: 'defense',
    TRANSITION_ATTACK: 'transition-attack',
    TRANSITION_DEFENSE: 'transition-defense',
    LOOSE: 'loose',
});

const DEFAULTS = {
    transitionWindow: 5,    // 전환 창구 (초) — 역습·역압박 유효 시간
    baseReaction: 0.25,     // 기본 반응 지연 (초)
    ballWinnerBonus: -0.12, // 볼 획득자는 더 빨리 반응 (전진)
    nearestPressBonus: -0.08, // 볼 상실 시 가장 가까운 1명은 더 빨리 압박
    farPenaltyPer100: 0.06, // 볼에서 100 멀어질수록 반응 가산 (초, 상한 별도)
    farPenaltyMax: 0.45,
    jitter: 0.08,           // 무작위 편차 (초) — 매번 같은 반응 방지
};

function teamOf(player, teamA, teamB) {
    if (!player) return null;
    if (teamA.players.includes(player)) return 'A';
    if (teamB.players.includes(player)) return 'B';
    return null;
}

export class MatchState {
    /**
     * @param {object} options
     *   teamA {players} A팀 선수 배열 (참조 비교용)
     *   teamB {players} B팀 선수 배열
     *   transitionWindow, baseReaction, ... (DEFAULTS 참조)
     */
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this._teamA = options.teamA ?? { players: [] };
        this._teamB = options.teamB ?? { players: [] };
        this._states = { A: TEAM_STATE.LOOSE, B: TEAM_STATE.LOOSE };
        this._ownerKey = null;      // 'A' | 'B' | null
        this._transitionT = 0;      // 전환 창구 경과
        this._inTransition = false;
        this._turnover = null;      // { from, to, x, y, t }
        this._clock = 0;
        this._changed = false;      // 이번 프레임 상태 변화 여부
        this._reactions = new Map(); // player → 반응 시점(시계)
    }

    get states() { return { ...this._states }; }
    get changed() { return this._changed; }
    get turnover() { return this._turnover ? { ...this._turnover } : null; }
    /** 전환 창구 잔여 시간 (0이면 안정 상태) */
    get transitionLeft() {
        if (!this._inTransition) return 0;
        return Math.max(0, this.o.transitionWindow - this._transitionT);
    }

    /**
     * 매 프레임 호출 — 소유권을 관찰해 상태를 전이시킨다.
     * @param {number} dt
     * @param {object} ctx { owner, ball }
     *   owner {Player|null} BallMovement.owner (공중·루즈볼이면 null)
     *   ball {x,y} 턴오버 위치 기록용
     * @returns {{ changed: boolean, states }}
     */
    update(dt, ctx = {}) {
        this._clock += dt;
        this._changed = false;
        const owner = ctx.owner ?? null;
        const key = teamOf(owner, this._teamA, this._teamB);

        if (key !== this._ownerKey) {
            this._onPossessionChange(key, owner, ctx.ball);
        } else if (this._inTransition) {
            this._transitionT += dt;
            if (this._transitionT >= this.o.transitionWindow) {
                // 창구 종료 — 안정 상태로 복귀
                this._inTransition = false;
                this._settle();
            }
        }
        return { changed: this._changed, states: this.states };
    }

    /** 특정 선수의 반응 지연을 반환한다 (전환 순간 스냅샷 기준). */
    reactionOf(player, ball) {
        const o = this.o;
        let r = o.baseReaction;
        if (this._turnover) {
            if (player === this._turnover.winner) r += o.ballWinnerBonus;
            if (player === this._turnover.presser) r += o.nearestPressBonus;
        }
        if (ball && player) {
            const d = Math.hypot(player.x - ball.x, player.y - ball.y);
            r += Math.min(o.farPenaltyMax, (d / 100) * o.farPenaltyPer100);
        }
        r += (Math.random() * 2 - 1) * o.jitter;
        return Math.max(0.05, r);
    }

    /** 강제 리셋 (킥오프·시나리오 전환용). */
    reset(ownerKey = null) {
        this._ownerKey = ownerKey;
        this._inTransition = false;
        this._transitionT = 0;
        this._turnover = null;
        this._reactions.clear();
        this._settle();
        this._changed = true;
    }

    /* ── private ─────────────────────────────────── */

    _onPossessionChange(key, owner, ball) {
        const prev = this._ownerKey;
        this._ownerKey = key;
        this._transitionT = 0;
        this._reactions.clear();

        if (key === null) {
            // 소유 상실 → 루즈볼 (태클·펀칭·포스트 등)
            this._states.A = TEAM_STATE.LOOSE;
            this._states.B = TEAM_STATE.LOOSE;
            this._inTransition = false;
            this._turnover = null;
        } else {
            const winnerKey = key;
            const loserKey = key === 'A' ? 'B' : 'A';
            this._states[winnerKey] = TEAM_STATE.TRANSITION_ATTACK;  // 2. 수비→공격
            this._states[loserKey] = TEAM_STATE.TRANSITION_DEFENSE;  // 1. 공격→수비
            this._inTransition = true;
            // 턴오버 스냅샷 — Decision/Intent이 위치·대상 참조
            this._turnover = {
                from: prev,
                to: winnerKey,
                winner: owner,
                presser: this._nearestOf(loserKey, ball),
                x: ball ? ball.x : 0,
                y: ball ? ball.y : 0,
                t: this._clock,
            };
        }
        this._changed = true;
    }

    _settle() {
        if (this._ownerKey === 'A') {
            this._states.A = TEAM_STATE.ATTACK;
            this._states.B = TEAM_STATE.DEFENSE;
        } else if (this._ownerKey === 'B') {
            this._states.A = TEAM_STATE.DEFENSE;
            this._states.B = TEAM_STATE.ATTACK;
        } else {
            this._states.A = TEAM_STATE.LOOSE;
            this._states.B = TEAM_STATE.LOOSE;
        }
        this._changed = true;
    }

    _nearestOf(key, ball) {
        if (!ball) return null;
        const team = key === 'A' ? this._teamA : this._teamB;
        let best = null, bd = Infinity;
        for (const p of team.players ?? []) {
            const d = Math.hypot(p.x - ball.x, p.y - ball.y);
            if (d < bd) { bd = d; best = p; }
        }
        return best;
    }
}
