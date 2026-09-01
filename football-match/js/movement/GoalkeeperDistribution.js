/**
 * GoalkeeperDistribution - 골키퍼 볼 배급 모듈
 *
 * 골키퍼가 볼을 잡은 뒤 "어디로, 어떻게, 언제" 내주는지를 모듈이 소유한다.
 *
 * 상태 흐름:
 *   SETTLE  볼을 품고 정지 — 시야 확보. 볼은 매 프레임 발 앞에 고정된다.
 *   TURN    수신자 방향으로 몸을 회전. 각속도가 제한되어 순간 회전이 없고,
 *           회전하는 동안에도 볼이 몸을 따라 움직여 "볼이 튀어나가는" 느낌이 없다.
 *   RELEASE 거리에 맞는 킥을 실행한다.
 *   DONE    배급 완료. lockout 동안 재클레임이 금지된다.
 *
 * 배급 종류 (거리에 따라 자동 선택 — 항상 짧은 패스만 하는 현상을 없앤다):
 *   ground  ~26m 이내  지면 숏패스
 *   driven  ~26~46m    빠른 지면 롱패스
 *   lofted  46m 이상   공중 롱킥 (압박이 심하면 거리와 무관하게 선택)
 *
 * locked:
 *   배급 직후 일정 시간 동안 true. 시나리오는 이 값이 true인 동안
 *   골키퍼의 볼 클레임을 건너뛰어야 한다.
 *   골키퍼가 자기가 내준 패스를 다시 달려가 잡는 현상을 막는 장치다.
 */
import { PassMovement } from './PassMovement.js';
import { angleTo, angleDiff } from './Direction.js';

export const GK_DISTRIB = Object.freeze({
    SETTLE: 'settle',
    TURN: 'turn',
    RELEASE: 'release',
    DONE: 'done',
});

const DEFAULTS = {
    centerY: 340,
    yMin: 45,
    yMax: 635,
    fieldMaxX: 1050,
    settleMin: 0.45,        // 캐치 후 정지 시간
    settleMax: 0.80,
    turnRate: 260,          // 회전 각속도 (도/초) — 순간 회전 금지
    alignDeg: 9,            // 이 각도 안으로 들어오면 킥
    turnTimeout: 1.1,       // 회전이 길어지면 그 방향에서 그대로 찬다
    lockoutTime: 1.35,      // 배급 후 재클레임 금지 시간
    groundRange: 300,       // 지면 숏패스 한계
    drivenRange: 520,       // 빠른 지면 패스 한계
    pressRadius: 80,        // 이보다 가깝게 붙으면 걷어내듯 롱킥
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

export class GoalkeeperDistribution {
    /**
     * @param {object} options
     *   ownGoalX {number} 자기 골라인 X
     *   dir      {number} 팀 공격 방향 (+1 = 오른쪽 골 공격)
     */
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this.ownGoalX = options.ownGoalX ?? 0;
        this.dir = options.dir ?? 1;

        this._state = GK_DISTRIB.DONE;
        this._timer = 0;
        this._turnTimer = 0;
        this._lockout = 0;
        this._gk = null;
        this._bm = null;
        this._plan = null;
    }

    get state() { return this._state; }
    get active() { return this._state !== GK_DISTRIB.DONE; }
    /** 배급 직후 재클레임 금지 구간인지 */
    get locked() { return this._lockout > 0; }
    /** 선택된 수신자 인덱스 (배급 전에도 조회 가능) */
    get targetIdx() { return this._plan ? this._plan.idx : null; }

    /**
     * 배급을 시작한다. 볼은 이미 GK가 소유한 상태여야 한다.
     * @param {object} gk         골키퍼 엔티티
     * @param {BallMovement} bm
     * @param {object} ctx        { teammates: Player[], opponents: Player[] }
     */
    begin(gk, bm, ctx = {}) {
        this._gk = gk;
        this._bm = bm;
        this._state = GK_DISTRIB.SETTLE;
        this._timer = rand(this.o.settleMin, this.o.settleMax);
        this._turnTimer = 0;
        this._lockout = 0;
        this._plan = this._choose(gk, ctx.teammates ?? [], ctx.opponents ?? []);
        // 캐치 순간에는 볼을 몸 앞에 확실히 붙여둔다
        if (bm.owner) bm.snapToFront();
    }

    /**
     * 매 프레임 호출.
     * @returns {null | { released: true, idx, aimX, aimY, kind }}
     */
    update(dt) {
        if (this._lockout > 0) this._lockout -= dt;
        if (this._state === GK_DISTRIB.DONE) return null;

        const gk = this._gk, bm = this._bm;
        if (!gk || !bm) { this._state = GK_DISTRIB.DONE; return null; }

        // 소유를 잃었으면(태클·인터셉트) 배급을 중단한다
        if (!bm.owner) { this._state = GK_DISTRIB.DONE; return null; }

        // 어느 상태에서든 볼은 GK 발 앞에 붙어 몸을 따라 움직인다
        bm.snapToFront();

        if (this._state === GK_DISTRIB.SETTLE) {
            this._timer -= dt;
            if (this._timer <= 0) {
                this._state = GK_DISTRIB.TURN;
                this._turnTimer = 0;
            }
            return null;
        }

        if (this._state === GK_DISTRIB.TURN) {
            this._turnTimer += dt;
            const plan = this._plan;
            if (!plan) { this._state = GK_DISTRIB.RELEASE; return this._release(); }

            const want = angleTo(gk.x, gk.y, plan.aimX, plan.aimY);
            const diff = angleDiff(want, gk.angle);
            const step = this.o.turnRate * dt;
            if (Math.abs(diff) <= step || Math.abs(diff) <= this.o.alignDeg) {
                gk.setAngle(want);
                this._state = GK_DISTRIB.RELEASE;
                return this._release();
            }
            gk.setAngle(gk.angle + Math.sign(diff) * step);
            // 회전이 지나치게 길어지면 현재 방향에서 그대로 처리
            if (this._turnTimer > this.o.turnTimeout) {
                this._state = GK_DISTRIB.RELEASE;
                return this._release();
            }
            return null;
        }

        return null;
    }

    /** 다른 선수가 볼을 건드리면 재클레임 금지를 즉시 해제한다. */
    noteBallTouched() { this._lockout = 0; }

    reset() {
        this._state = GK_DISTRIB.DONE;
        this._plan = null;
        this._lockout = 0;
        this._gk = null;
        this._bm = null;
    }

    /* ── private ─────────────────────────────────── */

    /** 수신자와 배급 종류를 고른다. */
    _choose(gk, teammates, opponents) {
        const o = this.o;
        let best = null, bestScore = -Infinity;

        for (let k = 0; k < teammates.length; k++) {
            const m = teammates[k];
            const dist = Math.hypot(m.x - gk.x, m.y - gk.y);
            let press = Infinity;
            for (const opp of opponents) {
                press = Math.min(press, Math.hypot(opp.x - m.x, opp.y - m.y));
            }
            // 전진성 — 골라인에서 멀어지는 방향이 가치가 높다
            const forwardness = (m.x - this.ownGoalX) * this.dir;
            // 압박에서 자유로운 선수가 최우선. 전진성은 보조 가치로만 반영해
            // 무조건 최전방으로 걷어내지 않고 짧게 풀어나가는 선택도 나오게 한다.
            const score = Math.min(press, 220) * 1.0
                        + Math.min(forwardness, 400) * 0.22
                        - Math.max(0, 110 - dist) * 0.6;  // 너무 붙어 있으면 감점
            if (score > bestScore) { bestScore = score; best = { player: m, idx: k, dist, press }; }
        }
        if (!best) return null;

        // ── 배급 종류: 거리 + 압박 ──
        let kind;
        if (best.press < o.pressRadius || best.dist > o.drivenRange) kind = 'lofted';
        else if (best.dist > o.groundRange) kind = 'driven';
        else kind = 'ground';

        // 수신자 앞쪽으로 살짝 리드해 달리면서 받게 한다
        const lead = kind === 'lofted' ? 55 : kind === 'driven' ? 40 : 24;
        const aimX = clamp(best.player.x + this.dir * lead, 25, o.fieldMaxX - 25);
        const aimY = clamp(best.player.y, o.yMin + 20, o.yMax - 20);

        return { idx: best.idx, player: best.player, aimX, aimY, kind, dist: best.dist };
    }

    /** 실제 킥 — 종류별로 다른 물리를 적용한다. */
    _release() {
        const plan = this._plan;
        const bm = this._bm;
        this._state = GK_DISTRIB.DONE;
        this._lockout = this.o.lockoutTime;
        if (!plan || !bm.owner) return null;

        // 킥 직전 한 번 더 발 앞 고정 — 볼이 몸에서 떨어진 채 차이는 현상 방지
        bm.snapToFront();
        const dist = Math.hypot(plan.aimX - bm.ball.x, plan.aimY - bm.ball.y);

        if (plan.kind === 'lofted') {
            PassMovement.longPass(bm, plan.aimX, plan.aimY, {
                flightDuration: Math.max(0.85, dist / 330),
                maxHeight: 0.72 + Math.random() * 0.20,
                deviationRad: rand(-0.035, 0.035),
                bounce: { duration: 0.38, maxHeight: 0.26, velocityScale: 0.5 },
            });
        } else if (plan.kind === 'driven') {
            PassMovement.shortPass(bm, plan.aimX, plan.aimY, {
                arriveSpeed: 150 + rand(-10, 10),
                deviationRad: rand(-0.014, 0.014),
            });
        } else {
            PassMovement.shortPass(bm, plan.aimX, plan.aimY, {
                arriveSpeed: 100 + rand(-8, 8),
                deviationRad: rand(-0.010, 0.010),
            });
        }

        return {
            released: true,
            idx: plan.idx,
            aimX: plan.aimX,
            aimY: plan.aimY,
            kind: plan.kind,
        };
    }
}
