/**
 * AttackerDuelAI - 공격수 1v1 대결 AI
 *
 * PlayerMovement / DribbleController와 직접 연결되지 않으며,
 * 상태 전환 시 콜백만 발행한다. 실제 이동 명령은 상위 레이어(시나리오)가 수행.
 *
 * 상태:
 *   IDLE    – 비활성 (start() 이전)
 *   NORMAL  – 수비수 감시, 웨이포인트 체인 진행 가능
 *   BEATEN  – 수비수를 제침 (종료 상태)
 *   DUEL_A  – 슬로우 볼키핑 후 폭발적 이탈
 *   DUEL_B  – 즉시 방향전환 + 질주 (BEATEN으로 즉시 전환)
 *
 * @example
 *   const ai = new AttackerDuelAI(player, defender, {
 *       onBeaten:    ()     => goToGoal(),
 *       onDuelA:     ()     => startSlowKeep(),
 *       onDuelBurst: (sign) => lateralBurst(sign),
 *   });
 *   ai.start();
 *   // 매 프레임: ai.update(dt)  — 상태 전환 시 true 반환
 */
export class AttackerDuelAI {

    /**
     * @param {Player} player
     * @param {Player} defender
     * @param {object} callbacks
     *   onBeaten()         수비수가 뒤로 밀렸을 때 (BEATEN 진입)
     *   onDuelA()          DUEL_A 슬로우 키핑 시작
     *   onDuelBurst(sign)  이탈 질주 — sign: -1=위, +1=아래
     * @param {object} options
     *   beatenGap    {number}  수비수가 이만큼 뒤에 있으면 제쳤다고 판단 (기본 25 SVG)
     *   threatDist   {number}  이 거리 이내 수비수를 위협으로 간주 (기본 200 SVG)
     *   threatLead   {number}  수비수가 공격수보다 이만큼 앞에 있어야 위협 (기본 15 SVG)
     *   burstTrigger {number}  DUEL_A: 이 거리 이내면 즉시 이탈 (기본 70 SVG)
     *   holdTime     {number}  DUEL_A 최대 키핑 시간(초, 기본 1.5)
     *   aiInterval   {number}  상태 평가 주기(초, 기본 0.2)
     */
    constructor(player, defender, callbacks = {}, options = {}) {
        this._player   = player;
        this._defender = defender;

        this._onBeaten    = callbacks.onBeaten    ?? (() => {});
        this._onDuelA     = callbacks.onDuelA     ?? (() => {});
        this._onDuelBurst = callbacks.onDuelBurst ?? (() => {});

        this._beatenGap    = options.beatenGap    ?? 25;
        this._threatDist   = options.threatDist   ?? 200;
        this._threatLead   = options.threatLead   ?? 15;
        this._burstTrigger = options.burstTrigger ?? 70;
        this._holdTime     = options.holdTime     ?? 1.5;
        this._aiInterval   = options.aiInterval   ?? 0.2;

        this._state     = 'IDLE';
        this._duelTimer = 0;
        this._aiTimer   = 0;
    }

    get state() { return this._state; }

    /** 정상 드리블 시작 시 호출 */
    start() {
        this._state     = 'NORMAL';
        this._aiTimer   = this._aiInterval;
        this._duelTimer = 0;
    }

    /** 외부에서 강제 중단 */
    stop() { this._state = 'IDLE'; }

    /**
     * 매 프레임 호출.
     * 상태 전환이 일어났으면 true 반환 — NORMAL 웨이포인트 체인에서
     * 이 값을 확인해 체인 중단 여부를 결정한다.
     */
    update(dt) {
        if (this._state === 'IDLE' || this._state === 'BEATEN') return false;
        this._aiTimer -= dt;
        if (this._aiTimer > 0) return false;
        this._aiTimer = this._aiInterval;
        return this._evaluate();
    }

    /* ── private ─────────────────────────────── */

    _evaluate() {
        const p = this._player, d = this._defender;
        const dist      = Math.hypot(d.x - p.x, d.y - p.y);
        const defBehind = d.x < p.x - this._beatenGap;
        const defThreat = !defBehind
                          && d.x > p.x + this._threatLead
                          && dist < this._threatDist;

        if (this._state === 'NORMAL') {
            if (defBehind) {
                this._state = 'BEATEN';
                this._onBeaten();
                return true;
            }
            if (defThreat) {
                if (Math.random() < 0.5) this._enterDuelA();
                else                     this._enterDuelB();
                return true;
            }
        } else if (this._state === 'DUEL_A') {
            this._duelTimer += this._aiInterval;
            if (dist < this._burstTrigger || this._duelTimer > this._holdTime) {
                this._state = 'BEATEN';
                this._onDuelBurst(this._burstSign());
                return true;
            }
        }
        return false;
    }

    // 수비수가 아래에 있으면 위로, 위에 있으면 아래로
    _burstSign() {
        return (this._defender.y - this._player.y) > 0 ? -1 : 1;
    }

    _enterDuelA() {
        this._state     = 'DUEL_A';
        this._duelTimer = 0;
        this._onDuelA();
    }

    _enterDuelB() {
        this._state = 'BEATEN'; // B는 즉시 이탈
        this._onDuelBurst(this._burstSign());
    }
}
