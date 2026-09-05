/**
 * TransitionController - 공격/수비 전환 공통 오케스트레이터
 *
 * 소유권 변화를 경기 상황 기반으로 전환 동작으로 바꾼다.
 * 시나리오 타이머를 쓰지 않으며, 흐름은 다음과 같다.
 *
 *   Possession Change (BallMovement.owner 관찰)
 *     → Team State 변경 (MatchState)
 *     → Player Role 재평가 (Decision)
 *     → Decision 재평가 (counter/buildup/counterpress/fallback/anti-counter)
 *     → Movement Intent 변경 (TransitionIntent → PlayerMovement)
 *
 * 호출자는 매 프레임 update()만 호출하면 된다. 이동 실행은
 * PlayerMovement에 위임하므로 회전·가속 중앙화 원칙을 지킨다.
 * 선수별 반응 차이(reaction)는 MatchState.reactionOf() 스냅샷으로
 * 표현하며, 11v11에서는 인원·역할 그대로 확장된다.
 */
import { MatchState, TEAM_STATE } from './MatchState.js';
import { TransitionDecision } from './TransitionDecision.js';
import { TransitionIntent } from './TransitionIntent.js';
import { angleTo } from './Direction.js';

const DEFAULTS = {
    dirA: 1,            // A팀 공격 방향
    dirB: -1,           // B팀 공격 방향
    attackGoalXA: 1050,
    attackGoalXB: 0,
};

export class TransitionController {
    /**
     * @param {object} options
     *   ballMovement {BallMovement} 소유권 관찰용 (필수)
     *   teamA {players, movements} A팀 (movements는 players와 같은 순서)
     *   teamB {players, movements} B팀
     *   matchState {MatchState} 외부 주입 시 재사용 (없으면 내부 생성)
     */
    constructor(options = {}) {
        this._bm = options.ballMovement;
        this._teamA = options.teamA ?? { players: [], movements: [] };
        this._teamB = options.teamB ?? { players: [], movements: [] };
        this.o = { ...DEFAULTS, ...options };
        this._match = options.matchState ?? new MatchState({
            teamA: { players: this._teamA.players },
            teamB: { players: this._teamB.players },
        });
        this._decision = new TransitionDecision({});
        this._intent = new TransitionIntent({});
        // 반응 대기 — player → 남은 시간. 전환 순간에만 설정된다.
        this._wait = new Map();
        this._clock = 0;
        this.last = { states: null, changed: false, intents: [] };
    }

    get states() { return this._match.states; }
    get changed() { return this._match.changed; }
    get transitionLeft() { return this._match.transitionLeft; }

    /** 킥오프·시나리오 전환용 리셋. */
    reset(ownerKey = null) {
        this._match.reset(ownerKey);
        this._wait.clear();
    }

    /**
     * 매 프레임 호출한다.
     * @param {number} dt
     * @param {object} ctx { ball, clock }
     * @returns {{ states, changed, intents }}
     */
    update(dt, ctx = {}) {
        const ball = ctx.ball ?? this._bm.ball;
        const owner = this._bm.owner;
        this._clock += dt;

        // 1. 소유권 → 팀 상태 (시간 창구는 MatchState가 소유)
        const { changed, states } = this._match.update(dt, { owner, ball });
        if (changed) this._armReactions(ball);

        // 2·3. 역할·결정 재평가 → 4. 의도 변경 (상태가 전이 중이거나 안정 수비 대응)
        const intents = this._buildIntents(ball, states, ctx.clock ?? this._clock);
        this._drive(dt, intents);

        this.last = { states: { ...states }, changed, intents };
        return this.last;
    }

    /* ── private ─────────────────────────────────── */

    /** 전환 순간 선수별 반응 지연을 스냅샷한다 (이후 프레임에서 차감). */
    _armReactions(ball) {
        this._wait.clear();
        const all = [...this._teamA.players, ...this._teamB.players];
        for (const p of all) {
            this._wait.set(p, this._match.reactionOf(p, ball));
        }
    }

    _ready(dt) {
        // 대기 중인 선수는 차감만 하고 움직이지 않는다 (반응 차이 표현)
        const ready = new Set();
        for (const [p, t] of this._wait) {
            const nt = t - dt;
            if (nt <= 0) { this._wait.delete(p); ready.add(p); }
            else this._wait.set(p, nt);
        }
        return ready;
    }

    _buildIntents(ball, states, clock) {
        const out = [];
        const owner = this._bm.owner;
        const teams = [
            { key: 'A', ...this._teamA, dir: this.o.dirA, attackGoalX: this.o.attackGoalXA, ownGoalX: 0 },
            { key: 'B', ...this._teamB, dir: this.o.dirB, attackGoalX: this.o.attackGoalXB, ownGoalX: 1050 },
        ];
        for (const t of teams) {
            const st = states[t.key];
            const mates = t.players;
            const opps = t.key === 'A' ? this._teamB.players : this._teamA.players;
            if (st === TEAM_STATE.TRANSITION_ATTACK) {
                // 2·3·5·9 — 탈취 팀: 역습 or 지공
                const carrier = owner;
                const rest = mates.filter((p) => p !== carrier);
                const dec = this._decision.decideAttack({
                    turnover: this._match.turnover, dir: t.dir, ball,
                    mates: rest, opponents: opps, transitionLeft: this._match.transitionLeft,
                });
                const intents = this._intent.attackIntents({
                    carrier, mates: rest, opponents: opps,
                    dir: t.dir, decision: dec.decision, clock,
                });
                out.push({ key: t.key, state: st, decision: dec.decision, intents });
            } else if (st === TEAM_STATE.TRANSITION_DEFENSE) {
                // 1·4·6·8 — 상실 팀: 역압박 or 폴백
                const dec = this._decision.decideDefense({
                    turnover: this._match.turnover, ball, mates, opponents: opps, dir: t.dir,
                });
                const intents = this._intent.defenseIntents({
                    ball, mates, dir: t.dir, ownGoalX: t.ownGoalX, decision: dec.decision,
                });
                out.push({ key: t.key, state: st, decision: dec.decision, intents });
            } else if (st === TEAM_STATE.DEFENSE) {
                // 7 — 안정 수비 팀이 상대 전환 공격을 맞는 경우만 대응
                const foeKey = t.key === 'A' ? 'B' : 'A';
                if (states[foeKey] === TEAM_STATE.TRANSITION_ATTACK) {
                    const dec = this._decision.decideAntiCounter({ ball, mates, dir: t.dir });
                    const intents = this._intent.antiCounterIntents({
                        ball, mates, dir: t.dir, ownGoalX: t.ownGoalX,
                    });
                    out.push({ key: t.key, state: st, decision: dec.decision, intents });
                }
            }
            // ATTACK 안정·LOOSE는 기존 공격·수비 AI 몫 — 전환 모듈은 건드리지 않는다
        }
        return out;
    }

    _drive(dt, groups) {
        const ready = this._ready(dt);
        const armed = this._wait.size > 0 || ready.size > 0;
        const byPlayer = new Map();
        for (const g of groups) {
            for (const it of g.intents) byPlayer.set(it.player, it);
        }
        const movOf = (p) => {
            let i = this._teamA.players.indexOf(p);
            if (i >= 0) return this._teamA.movements[i];
            i = this._teamB.players.indexOf(p);
            if (i >= 0) return this._teamB.movements[i];
            return null;
        };
        for (const [player, it] of byPlayer) {
            const mv = movOf(player);
            if (!mv) continue;
            // 반응 전에는 기존 이동 유지 (멈추지 않고 대기 — 급정지 방지)
            if (armed && !ready.has(player) && this._wait.has(player)) continue;
            mv.speed = it.speed;
            mv.clearFacingTarget();
            mv.setFacingTarget(angleTo(player.x, player.y, it.targetX, it.targetY));
            mv.moveTo(it.targetX, it.targetY);
        }
        // 이동 실행 — 전환 대상만 갱신 (다른 선수의 AI와 충돌 방지)
        const touched = new Set([...byPlayer.keys()].map((p) => movOf(p)).filter(Boolean));
        for (const mv of touched) mv.update(dt);
    }
}

export { TEAM_STATE };
