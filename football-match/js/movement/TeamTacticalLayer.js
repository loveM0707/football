/**
 * TeamTacticalLayer - 팀 전술 레이어 공통 모듈
 *
 * 4v4 기준, 11v11 확장 가능한 N-범용 팀 전술 실행기다.
 * 인원 하드코딩(2인·3인 전용 AI)과 달리 선수 수와 무관하게 동작한다.
 *
 * 역할 분담 (중복 구현 금지):
 *   - 공격 형태: OffBallDecision (침투/지원) + TeamShape (폭·깊이 앵커)
 *   - 수비 실행: CooperativeDefenseAI에 위임 (자체 구동 — 이중 구동 금지)
 *   - 국소 전술: TeamSupport (삼각형·수적 우열·커버·패스후이동)
 *   - 14·15 전환: MatchState + TransitionDecision/Intent (TransitionController 조각 재사용)
 *
 * 원칙:
 *   - 볼 소유자(캐리어)의 이동은 건드리지 않는다 (온볼 모듈 소유)
 *   - Scenario는 인원·초기 위치만 설정하고, 전술 판단은 이 레이어가 소유
 *   - 이동 실행은 PlayerMovement에 위임 (중앙화 원칙)
 */
import { PlayerMovement } from './PlayerMovement.js';
import { OffBallDecision } from './OffBallDecision.js';
import { CooperativeDefenseAI } from './CooperativeDefenseAI.js';
import { TeamShape } from './TeamShape.js';
import { TeamSupport } from './TeamSupport.js';
import { MatchState, TEAM_STATE } from './MatchState.js';
import { TransitionDecision } from './TransitionDecision.js';
import { TransitionIntent } from './TransitionIntent.js';
import { angleTo } from './Direction.js';
import { CENTER_Y } from './FieldGeometry.js';

const SPEEDS = PlayerMovement.SPEEDS;

const DEFAULTS = {
    dir: 1,                 // 공격 방향
    attackGoalX: 1050,
    ownGoalX: 0,
    centerY: CENTER_Y,
    retargetAttack: 0.15,   // 공격 리타겟 주기
    retargetLoose: 0.3,     // 루즈볼 리타겟 주기
};

export class TeamTacticalLayer {
    /**
     * @param {object} options
     *   players {Array<Player>} 우리 팀 (순서 고정)
     *   movements {Array<PlayerMovement>} players와 같은 순서
     *   opponents {Array<Player>} 상대 팀
     *   myKey {'A'|'B'} MatchState 식별자 (기본 'A')
     *   dir, attackGoalX, ownGoalX, ...
     */
    constructor(options = {}) {
        this.players = options.players ?? [];
        this.movements = options.movements ?? [];
        this.opponents = options.opponents ?? [];
        this.o = { ...DEFAULTS, ...options };
        const dir = this.o.dir;

        this._shape = new TeamShape({
            dir, attackGoalX: this.o.attackGoalX, ownGoalX: this.o.ownGoalX,
        });
        this._support = new TeamSupport({ dir });
        this._offBall = new OffBallDecision({
            dir, attackGoalX: this.o.attackGoalX, centerY: this.o.centerY,
        });
        this._defense = new CooperativeDefenseAI(
            this.players.map((p, i) => ({ player: p, movement: this.movements[i] })),
            { assignmentInterval: 0.25, retargetInterval: 0.12 },
        );
        // 14·15 전환 상태 — 양 팀 로스터를 공유해 소유권을 관찰한다
        const myKey = options.myKey ?? 'A';
        this._myKey = myKey;
        const mine = { players: this.players };
        const foe = { players: this.opponents };
        this._match = new MatchState({
            teamA: myKey === 'A' ? mine : foe,
            teamB: myKey === 'A' ? foe : mine,
        });
        this._trDecision = new TransitionDecision({});
        this._trIntent = new TransitionIntent({
            dir, attackGoalX: this.o.attackGoalX, ownGoalX: this.o.ownGoalX,
        });

        this._prevRoles = new Map(); // player → 역할 (진동 방지)
        this._retargetT = 0;
        this._wait = new Map();      // 전환 반응 대기 player → 잔여 시간
        this._activeMoves = new Set(); // 발행된 이동 (매 프레임 펌프용)
        this._lastPhase = null;
    }

    get phase() { return this._lastPhase; }

    /**
     * 매 프레임 호출한다.
     * @param {number} dt
     * @param {object} ctx
     *   ball {x,y}, owner {Player|null}, ballVelocity {x,y},
     *   clock {number}, passEvent {passer, receiver} (13. 패스 후 이동용, 선택)
     * @returns {{ phase, decision }}
     */
    update(dt, ctx = {}) {
        const ball = ctx.ball;
        const owner = ctx.owner ?? null;
        const clock = ctx.clock ?? 0;
        const myState = this._teamState(dt, owner, ball);

        // 전환 반응 대기 차감 — 대기 중 선수는 기존 이동 유지
        this._tickWait(dt);

        if (myState === TEAM_STATE.TRANSITION_ATTACK) {
            this._updateTransitionAttack(dt, ball, owner, clock);
            this._lastPhase = myState;
            return { phase: myState, decision: this._lastDecision ?? null };
        }
        if (myState === TEAM_STATE.TRANSITION_DEFENSE) {
            this._updateTransitionDefense(dt, ball);
            this._lastPhase = myState;
            return { phase: myState, decision: this._lastDecision ?? null };
        }
        if (myState === TEAM_STATE.ATTACK) {
            this._retargetT -= dt;
            if (this._retargetT <= 0) {
                this._retargetT = this.o.retargetAttack;
                this._updateAttack(ball, owner, clock, ctx.passEvent ?? null);
            }
            this._driveTargets(dt, owner);
            this._lastPhase = myState;
            return { phase: myState, decision: 'shape' };
        }
        if (myState === TEAM_STATE.DEFENSE) {
            // 수비 실행은 협력수비 AI에 위임 (이중 구동 금지 — 여기서 movement.update 호출 안 함)
            this._activeMoves.clear();
            this._defense.update(dt, {
                ball,
                ballVelocity: ctx.ballVelocity ?? { x: 0, y: 0 },
                attackers: this.opponents,
                holder: owner,
                inFlight: false,
            });
            this._lastPhase = myState;
            return { phase: myState, decision: 'defend' };
        }
        // LOOSE — 최근접 1명은 볼로, 나머지는 수비 앵커로
        this._retargetT -= dt;
        if (this._retargetT <= 0) {
            this._retargetT = this.o.retargetLoose;
            this._updateLoose(ball, owner);
        }
        this._driveTargets(dt, owner);
        this._lastPhase = myState;
        return { phase: myState, decision: 'loose' };
    }

    /** 외부에서 소유권을 확정했을 때 전환 상태를 리셋한다 (킥오프 등). */
    reset(ownerKey = null) {
        this._match.reset(ownerKey);
        this._wait.clear();
        this._prevRoles.clear();
        this._activeMoves.clear();
    }

    /* ── private ─────────────────────────────────── */

    _teamState(dt, owner, ball) {
        const { states } = this._match.update(dt, { owner, ball });
        const mine = states[this._myKey];
        return mine;
    }

    _tickWait(dt) {
        for (const [p, t] of this._wait) {
            const nt = t - dt;
            if (nt <= 0) this._wait.delete(p);
            else this._wait.set(p, nt);
        }
    }

    _armWait(ball) {
        this._wait.clear();
        for (const p of this.players) {
            this._wait.set(p, this._match.reactionOf(p, ball));
        }
    }

    /** 이동 목표 버퍼 — _driveTargets가 일괄 실행한다 (캐리어 제외). */
    _setTarget(player, x, y, speed) {
        if (!this._targets) this._targets = new Map();
        this._targets.set(player, { x, y, speed });
    }

    // 14·15 전환 — TransitionDecision/Intent 조각 재사용 (중복 없음)
    _updateTransitionAttack(dt, ball, owner, clock) {
        if (this._wait.size === 0 && this._match.changed) this._armWait(ball);
        const mates = this.players.filter((p) => p !== owner);
        const dec = this._trDecision.decideAttack({
            turnover: this._match.turnover, dir: this.o.dir, ball,
            mates, opponents: this.opponents, transitionLeft: this._match.transitionLeft,
        });
        this._lastDecision = dec.decision;
        const intents = this._trIntent.attackIntents({
            carrier: owner, mates, opponents: this.opponents,
            dir: this.o.dir, decision: dec.decision, clock,
        });
        for (const it of intents) {
            if (it.player === owner) continue; // 캐리어 이동은 온볼 모듈 몫
            this._setTarget(it.player, it.targetX, it.targetY, it.speed);
        }
        this._driveTargets(dt, owner);
    }

    _updateTransitionDefense(dt, ball) {
        if (this._wait.size === 0 && this._match.changed) this._armWait(ball);
        const dec = this._trDecision.decideDefense({
            turnover: this._match.turnover, ball,
            mates: this.players, opponents: this.opponents, dir: this.o.dir,
        });
        this._lastDecision = dec.decision;
        const intents = this._trIntent.defenseIntents({
            ball, mates: this.players, dir: this.o.dir,
            ownGoalX: this.o.ownGoalX, decision: dec.decision,
        });
        for (const it of intents) this._setTarget(it.player, it.targetX, it.targetY, it.speed);
        this._driveTargets(dt, null);
    }

    /** 목표 버퍼를 일괄 구동한다 (캐리어·반응 대기자는 제외). */
    _driveTargets(dt, owner) {
        // 캐리어는 온볼 모듈 소유 — 펌프 집합에서 제외 (이중 구동 방지)
        if (owner) {
            const oi = this.players.indexOf(owner);
            if (oi >= 0) this._activeMoves.delete(this.movements[oi]);
        }
        if (!this._targets) { this._pumpActive(dt); return; }
        const pending = this._targets;
        this._targets = new Map();
        for (const [player, t] of pending) {
            if (player === owner) continue;
            if (this._wait.has(player)) { this._targets.set(player, t); continue; }
            const i = this.players.indexOf(player);
            if (i < 0) continue;
            const mv = this.movements[i];
            mv.speed = t.speed;
            mv.clearFacingTarget();
            mv.setFacingTarget(angleTo(player.x, player.y, t.x, t.y));
            mv.moveTo(t.x, t.y);
            this._activeMoves.add(mv);
        }
        this._pumpActive(dt);
    }

    /** 발행된 이동을 매 프레임 펌프한다 (리타겟 사이에도 정지 금지). */
    _pumpActive(dt) {
        for (const mv of this._activeMoves) mv.update(dt);
    }

    // 공격 — 형태(OffBallDecision) + 국소(TeamSupport) 혼합
    _updateAttack(ball, owner, clock, passEvent) {
        const mates = this.players.filter((p) => p !== owner);
        const prevRoles = mates.map((p) => this._prevRoles.get(p) ?? null);
        const shaped = this._offBall.evaluate({
            carrier: owner,
            mates: mates.map((p, i) => ({ player: p, idx: i })),
            opponents: this.opponents,
            clock,
            prevRoles,
        });
        // 10·11 수적 우열 — 우위면 침투 가점, 열세면 지원 후퇴
        const numbers = this._support.numbersAround(ball, mates, this.opponents);
        // 12 삼각형 — 상위 2개 패스 옵션과 삼각형 품질을 대조해 목표 미세 조정
        const tri = this._support.triangles(owner, mates, this.opponents);

        shaped.forEach((s) => {
            const player = mates[s.idx];
            this._prevRoles.set(player, s.role);
            let { targetX: tx, targetY: ty, speed } = s;
            if (numbers.verdict === 'underload' && s.role === 'penetrate') {
                // 열세 — 무리한 침투 대신 한 단계 후퇴
                tx = owner.x + (tx - owner.x) * 0.6;
                ty = owner.y + (ty - owner.y) * 0.6;
                speed = SPEEDS[3];
            }
            if (tri && (player === tri.a || player === tri.b)) {
                speed = Math.max(speed, SPEEDS[3]); // 삼각형 구성원은 각도 유지 우선
            }
            this._setTarget(player, tx, ty, speed);
        });

        // 13. 패스 후 이동 — 방금 패스한 선수는 전방 런
        if (passEvent && passEvent.passer && passEvent.receiver) {
            const { passer, receiver } = passEvent;
            if (this.players.includes(passer) && passer !== owner) {
                const go = this._support.passAndGo(passer, receiver, { dir: this.o.dir });
                this._setTarget(passer, go.x, go.y, SPEEDS[4]);
            }
        }
    }

    // 루즈볼 — 최근접 압박 + 나머지 수비 앵커
    _updateLoose(ball) {
        const press = this._support.pressTarget(this.players, ball);
        const anchors = this._shape.formationAnchors(this.players.length, {
            phase: 'defense', ballX: ball.x, ballY: ball.y,
            dir: this.o.dir, attackGoalX: this.o.attackGoalX, ownGoalX: this.o.ownGoalX,
        });
        // 앵커를 선수에 최근접 순으로 배정 (헝가리안 없이 탐욕 배정 — 루즈볼용)
        const assigned = new Set();
        if (press) assigned.add(press.player);
        const free = this.players.filter((p) => !assigned.has(p));
        free.forEach((p, k) => {
            const a = anchors[(k + 1) % anchors.length];
            this._setTarget(p, a.x, a.y, SPEEDS[3]);
        });
        if (press) this._setTarget(press.player, press.x, press.y, SPEEDS[4]);
    }
}
