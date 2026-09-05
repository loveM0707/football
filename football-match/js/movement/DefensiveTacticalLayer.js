/**
 * DefensiveTacticalLayer - 수비 전술 레이어 공통 모듈
 *
 * 팀 단위 협력 수비를 실행하는 N-범용 레이어다. 인원수와 무관하게
 * 같은 호출로 동작하므로 2v3 메뉴는 물론 11v11 협력 수비에 그대로 쓴다.
 *
 * 역할 분담 (중복 구현 금지):
 *   - 역할 판단: DefensiveDecision (press/cover/lane-block/mark + 목표·속도)
 *   - 태클 판단: TackleDecision (킥 국면에 PRESS만 커밋 + 쿨다운)
 *   - 이동 실행: PlayerMovement에 위임 (중앙화 원칙)
 *
 * 원칙:
 *   - Scenario는 인원·초기 위치·국면 전환만 담당하고, 수비 판단은 이 레이어가 소유
 *   - 이동 구동은 이 레이어가 전담 — 호출자는 movement.update를 직접 호출 금지
 *     (이중 구동 금지. LOOSE 공방 등 레이어 밖에선 stop() 후 contest 등이 구동)
 *   - 태클 해소(PossessionContest)는 국면 배관이므로 시나리오 몫.
 *     레이어는 커밋 여부(tackle)만 intent에 싣는다.
 */
import { DefensiveDecision } from './DefensiveDecision.js';
import { DEFENSE_ROLE } from './CooperativeDefenseAI.js';
import { TackleDecision } from './TackleDecision.js';
import { angleTo } from './Direction.js';

const DEFAULTS = {
    dir: 1,                 // 공격 방향 (위협 순위용)
    attackGoalX: 1050,      // 공격 골라인 X (위협 순위용)
    goalX: 1050,            // 수비 골 X (커버·마킹 앵커)
    goalY: 340,             // 수비 골 Y
    retargetInterval: 0.12, // 역할·목표 재계산 주기 (그 사이엔 펌프만)
};

export class DefensiveTacticalLayer {
    /**
     * @param {object} options
     *   players {Array<Player>} 수비수 (순서 고정)
     *   movements {Array<PlayerMovement>} players와 같은 순서 (레이어가 구동)
     *   opponents {Array<Player>} 상대 공격수 (위협 순위용, 기본 [])
     *   dir, attackGoalX, goalX, goalY, retargetInterval
     */
    constructor(options = {}) {
        this.players = options.players ?? [];
        this.movements = options.movements ?? [];
        this.opponents = options.opponents ?? [];
        this.o = { ...DEFAULTS, ...options };

        this._decision = new DefensiveDecision({
            dir: this.o.dir,
            attackGoalX: this.o.attackGoalX,
            goalX: this.o.goalX,
            goalY: this.o.goalY,
        });
        this._tackle = new TackleDecision({});

        this._active = false;
        this._retargetT = 0;
        this._prevRoles = null;   // players 순서와 같은 이전 역할 (진동 방지)
        this._intents = [];       // 최근 intent 스냅샷
        this._activeMoves = new Set();
    }

    start() {
        this._active = true;
        this._retargetT = 0;
    }

    stop() {
        this._active = false;
        for (const mv of this.movements) mv.stop();
        this._activeMoves.clear();
    }

    /** 역할 기록·쿨다운 초기화 (킥오프·소유 확정 등 국면 전환 시) */
    reset() {
        this._prevRoles = null;
        this._intents = [];
        this._tackle.reset();
        this._retargetT = 0;
        this._activeMoves.clear();
    }

    /** 현재 역할 배치 확인용 스냅샷. 검증 이벤트·디버그 UI용. */
    getAssignments() {
        return this._intents.map(it => ({
            player: this.players[it.idx],
            role: it.role,
            target: { x: it.targetX, y: it.targetY },
            tackle: it.tackle,
        }));
    }

    /**
     * 매 프레임 호출한다.
     * @param {number} dt
     * @param {object} ctx
     *   ball {x,y}, holder {Player|null} 볼 소유 공격수 (비행 중엔 수신 예정자),
     *   attackers {Array<Player>} (기본 생성자 opponents),
     *   ballAttached {boolean} 볼이 발에 붙어 있는지 (태클 게이트용, 기본 true)
     * @returns {Array} players 순서와 같은
     *   [{ idx, role, targetX, targetY, speed, tackle }]
     */
    update(dt, ctx = {}) {
        if (!this._active || this.players.length === 0) return this._intents;

        const ball = ctx.ball;
        if (!ball) return this._intents;
        const attackers = ctx.attackers ?? this.opponents;
        const holder = ctx.holder ?? null;
        const holderIdx = holder ? attackers.indexOf(holder) : -1;
        const attached = ctx.ballAttached !== false;

        this._tackle.update(dt);

        this._retargetT -= dt;
        if (this._intents.length === 0 || this._retargetT <= 0) {
            this._retargetT = this.o.retargetInterval;
            const decided = this._decision.evaluate({
                ball,
                attackers,
                holderIdx,
                defenders: this.players,
                prevRoles: this._prevRoles,
            });
            this._prevRoles = decided.map(d => d.role);
            this._intents = decided.map(d => ({ ...d, tackle: false }));
        }

        // 태클 커밋은 매 프레임 판정 (킥 윈도우를 놓치지 않게)
        for (const it of this._intents) {
            it.tackle = it.role === DEFENSE_ROLE.PRESS
                && this._tackle.decide(this.players[it.idx], ball, attached);
        }

        this._driveTargets();
        this._pumpActive(dt);
        return this._intents;
    }

    /** 목표 버퍼를 이동 모듈에 발행한다 (레이어가 유일한 구동자). */
    _driveTargets() {
        for (const it of this._intents) {
            const mv = this.movements[it.idx];
            if (!mv) continue;
            mv.speed = it.speed;
            mv.clearFacingTarget();
            mv.setFacingTarget(angleTo(
                this.players[it.idx].x, this.players[it.idx].y, it.targetX, it.targetY));
            mv.moveTo(it.targetX, it.targetY);
            this._activeMoves.add(mv);
        }
    }

    /** 발행된 이동을 매 프레임 펌프한다 (리타겟 사이에도 정지 금지). */
    _pumpActive(dt) {
        for (const mv of this._activeMoves) mv.update(dt);
    }
}
