/**
 * HeadingJump - 점프 판단·타이밍·접촉·착지 공통 모듈
 *
 * 3. 점프 판단 · 4. 점프 타이밍 · 접촉 · 착지를 전담한다.
 * 선수를 공 위치로 순간이동시키지 않고, 상태 머신으로 점프를 관리한다.
 *
 * 상태 흐름:
 *   APPROACH  낙하지점으로 이동 중 (접촉 불가)
 *   READY     낙하지점 근처 + 높이 창구 대기 (점프 준비)
 *   JUMPING   점프 상승 중 (체공, 이동 둔화)
 *   CONTACT   접촉 가능 창구 (헤딩 실행은 컨트롤러가 수행)
 *   LANDED    착지 후 (다음 판단까지 쿨다운)
 *
 * 점프 모델:
 *   - 지상 헤딩 창구: 볼 높이 0.05~0.30 (발돋움 없이 닿음)
 *   - 점프 헤딩 창구: 볼 높이 0.30~0.70 (점프해야 닿음)
 *   - 점프 지속 0.45초, 정점 0.22초 — 정점 근처에서 접촉률이 가장 높다
 *   - 점프 중 수평 속도는 45%로 둔화 (현실적인 체공 관성)
 */
export const JUMP_PHASE = Object.freeze({
    APPROACH: 'approach',
    READY: 'ready',
    JUMPING: 'jumping',
    CONTACT: 'contact',
    LANDED: 'landed',
});

const DEFAULTS = {
    contactRadius: 20,      // 수평 접촉 반경 (SVG)
    groundLow: 0.05,        // 지상 헤딩 하한
    groundHigh: 0.30,       // 지상 헤딩 상한 (= 점프 필요 기준)
    jumpHigh: 0.70,         // 점프 헤딩 상한
    jumpDuration: 0.45,     // 점프 전체 시간 (초)
    jumpPeak: 0.22,         // 정점 시점 (초)
    landCooldown: 0.35,     // 착지 후 쿨다운 (초)
    jumpLead: 0.10,         // 정점이 접촉 시점보다 이만큼 앞서게 뜬다
};

export class HeadingJump {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this.phase = JUMP_PHASE.APPROACH;
        this._jumpT = 0;
        this._coolT = 0;
        this._jumped = false; // 이번 공중볼에서 점프를 썼는지 (한 번만 뜬다)
    }

    get jumping() { return this.phase === JUMP_PHASE.JUMPING || this.phase === JUMP_PHASE.CONTACT; }
    /** 이번 비행에서 이미 점프했는지 (중복 점프 방지용) */
    get jumped() { return this._jumped; }

    /** 새로운 공중볼이 오면 리셋한다 (킥 발사 시 호출) */
    resetFlight() {
        this.phase = JUMP_PHASE.APPROACH;
        this._jumpT = 0;
        this._coolT = 0;
        this._jumped = false;
    }

    /** 완전히 리셋한다 (시나리오 리셋용) */
    reset() {
        this.resetFlight();
    }

    /**
     * 매 프레임 호출 — 점프 상태를 갱신한다.
     * @param {number} dt
     * @param {object} ctx
     *   playerDist {number}  선수-볼 수평 거리
     *   ballHeight {number}  현재 볼 높이 (0~1)
     *   timeToWindow {number} 높이 창구까지 남은 시간 (-1이면 창구 밖)
     *   approachReady {boolean} 접근 모듈이 낙하지점에 도달했는지
     * @returns {{ phase: string, shouldJump: boolean, contact: boolean, jumpBoost: number }}
     *   jumpBoost — 점프 상승 보정 (0=지상, 0~1=체공). 접촉 판정·연출에 사용.
     */
    update(dt, ctx = {}) {
        const o = this.o;
        const dist = ctx.playerDist ?? Infinity;
        const h = ctx.ballHeight ?? 0;
        const near = dist <= o.contactRadius;
        const inGround = h >= o.groundLow && h <= o.groundHigh;
        const inJump = h > o.groundHigh && h <= o.jumpHigh;

        // 착지 쿨다운
        if (this.phase === JUMP_PHASE.LANDED) {
            this._coolT -= dt;
            if (this._coolT <= 0) this.phase = JUMP_PHASE.APPROACH;
            return this._out(false, false);
        }

        // 점프 중 — 타이머 진행, 창구에서 CONTACT로 전환
        if (this.phase === JUMP_PHASE.JUMPING || this.phase === JUMP_PHASE.CONTACT) {
            this._jumpT += dt;
            const contact = near && (inGround || inJump);
            if (this._jumpT >= o.jumpDuration) {
                this.phase = JUMP_PHASE.LANDED;
                this._coolT = o.landCooldown;
            } else if (contact) {
                this.phase = JUMP_PHASE.CONTACT;
            }
            return this._out(false, contact);
        }

        // 지상 접촉 — 점프 없이 바로 CONTACT (발돋움 헤딩)
        if (near && inGround) {
            this.phase = JUMP_PHASE.CONTACT;
            return this._out(false, true);
        }

        // 점프 판단 — 낙하지점 근처에서 볼이 점프 창구에 있고, 아직 안 뛰었으면
        // 타이밍: 창구까지 남은 시간이 점프 정점 리드와 맞물릴 때 뛴다
        const tWin = ctx.timeToWindow ?? -1;
        const readySpot = near || (ctx.approachReady === true);
        if (!this._jumped && readySpot && inJump) {
            this._startJump();
            return this._out(false, true);
        }
        if (!this._jumped && readySpot && tWin >= 0 && tWin <= o.jumpPeak + o.jumpLead) {
            this._startJump();
            return this._out(false, near && (inGround || inJump));
        }

        this.phase = readySpot ? JUMP_PHASE.READY : JUMP_PHASE.APPROACH;
        return this._out(false, false);
    }

    _startJump() {
        this.phase = JUMP_PHASE.JUMPING;
        this._jumpT = 0;
        this._jumped = true;
    }

    _out(shouldJump, contact) {
        // 체공 보정 — 정점(0.22초)에서 1, 이륙·착지에서 0
        let boost = 0;
        if (this.phase === JUMP_PHASE.JUMPING || this.phase === JUMP_PHASE.CONTACT) {
            const t = this._jumpT / this.o.jumpDuration;
            boost = Math.max(0, 1 - Math.abs(t - 0.5) * 2);
        }
        return { phase: this.phase, shouldJump, contact, jumpBoost: boost };
    }
}
