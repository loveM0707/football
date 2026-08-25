/**
 * AttackerTeamAI - 공격팀 2인 협력 AI 모듈
 *
 * 기존 모듈을 재사용한다:
 *   - DribbleBehaviors: 드리블 행동 프리미티브 (slowKeepStep, lateralBurst, sprint)
 *   - ThroughPass: 공간패스 계산 (targetSpace)
 *   - BallReception: 패스 수령 (침투 런 + 트래핑)
 *   - PassMovement: 패스 실행 (shortPass)
 *
 * 역할:
 *   - 매 프레임 의사결정만 수행 (위협 감지, 패스/돌파 선택)
 *   - 이동·회전·물리는 시나리오 tick에서 담당 (중복 호출 금지)
 *   - BallReception은 AI 내부에서 update() — 시나리오 tick에서 호출하지 않음
 *
 * 상태:
 *   DRIBBLE  – 홀더가 드리블로 전진, 수비수 위협 감시
 *   DUEL     – 수비수와 1대1: 슬로우 키퍼 후 측면 돌파
 *   PASSING  – 패스 실행 중 (support가 BallReception으로 수령 대기)
 */
import { PassMovement }     from './PassMovement.js';
import { ThroughPass }      from './ThroughPass.js';
import { DribbleBehaviors } from './DribbleBehaviors.js';
import { BallReception }    from './BallReception.js';
import { forwardVector }    from './Direction.js';

const SPEEDS_DEFAULT = [50, 75, 100, 125, 150];

export const ATTACK_STATE = Object.freeze({
    DRIBBLE:  'dribble',
    DUEL:     'duel',
    PASSING:  'passing',
});

export class AttackerTeamAI {
    constructor(options = {}) {
        this.players     = options.players;
        this.movements   = options.movements;
        this.dribbles    = options.dribbles;
        this.bm          = options.ballMovement;
        this.goalX       = options.goalX ?? 1050;
        this.centerY     = options.centerY ?? 340;
        this.shootMinX   = options.shootMinX ?? 750;
        this.shootMaxX   = options.shootMaxX ?? 885;
        this.speeds      = options.speeds ?? SPEEDS_DEFAULT;
        this.possessOffset = options.possessOffset ?? 19;
        this.yMin = options.yMin ?? 45;
        this.yMax = options.yMax ?? 635;

        this.defenders = options.defenders ?? [];

        this._threatDist = 260;
        this._threatLead = 15;
        this._beatenGap  = 25;

        this._throughPass = new ThroughPass({
            leadDistance: 180,
            arriveSpeed: 110,
            maxDeviationDeg: 2,
        });
        this._receptions = [
            new BallReception(this.players[0], this.movements[0], this.bm),
            new BallReception(this.players[1], this.movements[1], this.bm),
        ];

        this._active = false;
        this._state = ATTACK_STATE.DRIBBLE;
        this._holderIdx = 0;
        this._passTimer = 0;
        this._shootCooldown = 0;
        this._duelTimer = 0;
        this._duelHoldTime = 0.6;
        this._duelBurstTrigger = 70;

        this._supportRunX = 0;
        this._supportRunY = 0;
    }

    get state() { return this._state; }
    get holderIdx() { return this._holderIdx; }
    get holder() { return this.players[this._holderIdx]; }
    get support() { return this.players[1 - this._holderIdx]; }
    get active() { return this._active; }

    get canShoot() {
        const h = this.holder;
        return h.x >= this.shootMinX && h.x <= this.shootMaxX;
    }

    get ballAttached() {
        return this.dribbles[this._holderIdx].ballAttached;
    }

    start() {
        this._active = true;
        this._state = ATTACK_STATE.DRIBBLE;
        this._holderIdx = 0;
        this._passTimer = 0;
        this._shootCooldown = 0;
        this._duelTimer = 0;
        this._supportRunX = 0;
        this._supportRunY = 0;
    }

    stop() {
        this._active = false;
        this._state = ATTACK_STATE.DRIBBLE;
        this._receptions.forEach(r => r.stop());
    }

    /**
     * 매 프레임 호출.
     * 의사결정만 수행 — pm/dc/bm update는 시나리오 tick이 담당.
     * BallReception만 AI가 직접 update (시나리오와 중복 방지).
     */
    update(dt) {
        if (!this._active) return null;

        this._shootCooldown -= dt;
        this._passTimer -= dt;

        const hi = this._holderIdx;
        const si = 1 - hi;
        const holder  = this.players[hi];
        const support = this.players[si];
        const holderPM  = this.movements[hi];
        const supportPM = this.movements[si];
        const holderDC  = this.dribbles[hi];

        // ── PASSING: BallReception만 AI가 직접 update ──
        if (this._state === ATTACK_STATE.PASSING) {
            this._receptions[si].update(dt);

            if (this._receptions[si].received) {
                this.dribbles[si].stop();
                this._setHolder(si);
            }
            return null;
        }

        // ── DUEL: 타이머 기반 이탈 판정만 (이동은 시나리오 tick이 처리) ──
        if (this._state === ATTACK_STATE.DUEL) {
            this._duelTimer += dt;

            if (this._duelTimer > this._duelHoldTime) {
                const nearDef = this._findNearestThreat(holder);
                const sign = nearDef
                    ? ((nearDef.y - holder.y) > 0 ? -1 : 1)
                    : ((support.y - holder.y) > 0 ? -1 : 1);
                DribbleBehaviors.lateralBurst(holderPM, holderDC, holder, sign, () => {
                    holderDC.start();
                    DribbleBehaviors.sprint(holderPM, holderDC, holder, this.goalX - 100, holder.y);
                }, { forwardDist: 160, lateralDist: 90, maxX: this.goalX - 80, yMin: this.yMin, yMax: this.yMax });
                this._state = ATTACK_STATE.DRIBBLE;
            }
            return null;
        }

        // ── DRIBBLE ──
        if (this._state !== ATTACK_STATE.DRIBBLE) return null;

        // 지원선수 침투 run
        this._updateSupportRun(support, supportPM);

        // 수비 위협 감시
        const nearestThreat = this._findNearestThreat(holder);
        if (nearestThreat && holderDC.ballAttached) {
            const dist = Math.hypot(nearestThreat.x - holder.x, nearestThreat.y - holder.y);
            const defBehind = nearestThreat.x < holder.x - this._beatenGap;

            if (defBehind) {
                holderDC.start();
                DribbleBehaviors.sprint(holderPM, holderDC, holder, this.goalX - 100, holder.y);
                return null;
            }

            // 위협 감지 범위 내에서 행동 결정 (포착 범위의 70%)
            if (dist < this._threatDist * 1.5 && this._passTimer <= 0) {
                if (Math.random() < 0.35) {
                    return this._enterDuel(holderPM, holderDC, holder, nearestThreat);
                } else {
                    return this._firePass(holder, support, holderPM, supportPM, holderDC);
                }
            }
        }

        // 기본 드리블
        if (!holderPM.moving) {
            holderDC.start();
            DribbleBehaviors.sprint(holderPM, holderDC, holder, this.goalX - 180, holder.y);
        }

        return null;
    }

    tryShoot() {
        if (!this._active || this._state !== ATTACK_STATE.DRIBBLE) return null;
        if (!this.ballAttached || this._shootCooldown > 0) return null;
        if (!this.canShoot) return null;
        this._shootCooldown = 1.0;
        return { fired: true, player: this.holder, idx: this._holderIdx };
    }

    setHolder(idx) {
        this._holderIdx = idx;
        this._state = ATTACK_STATE.DRIBBLE;
        this._passTimer = 0;
        this._shootCooldown = 0;
        this._duelTimer = 0;
    }

    /* ── private ─────────────────────────────────── */

    _findNearestThreat(holder) {
        let best = null;
        let bestScore = Infinity;
        for (const def of this.defenders) {
            const dx = def.x - holder.x;
            const dy = def.y - holder.y;
            const dist = Math.hypot(dx, dy);
            if (dx > this._threatLead && dist < this._threatDist * 2) {
                const score = dist - dx * 0.3;
                if (score < bestScore) { bestScore = score; best = def; }
            }
        }
        return best;
    }

    _updateSupportRun(support, supportPM) {
        const reached = this._supportRunX > 0
            && Math.hypot(support.x - this._supportRunX, support.y - this._supportRunY) < 30;

        if (!supportPM.moving || reached || this._supportRunX === 0) {
            this._supportRunX = Math.min(this.goalX - 60, this.holder.x + 200 + Math.random() * 100);
            this._supportRunY = Math.max(this.yMin + 20, Math.min(this.yMax - 20,
                this.centerY + (Math.random() - 0.5) * 180));
            supportPM.speed = this.speeds[3];
            supportPM.moveTo(this._supportRunX, this._supportRunY);
        }
    }

    _enterDuel(holderPM, holderDC, holder, defender) {
        this._state = ATTACK_STATE.DUEL;
        this._duelTimer = 0;
        this._duelSign = defender
            ? ((defender.y - holder.y) > 0 ? -1 : 1)
            : 1;
        DribbleBehaviors.slowKeepStep(holderPM, holderDC, holder, holder.x + 80, () => {
            if (this._state === ATTACK_STATE.DUEL) {
                DribbleBehaviors.slowKeepStep(holderPM, holderDC, holder, holder.x + 80, null, { speed: this.speeds[1] });
            }
        }, { speed: this.speeds[1] });
        return null;
    }

    _firePass(holder, support, holderPM, supportPM, holderDC) {
        const dir = forwardVector(support.angle);
        const target = this._throughPass.targetSpace({
            runner: support,
            direction: dir,
            runnerSpeed: this.speeds[3],
        });

        PassMovement.shortPass(this.bm, target.x, target.y, {
            arriveSpeed: 120 + Math.random() * 20,
            deviationRad: (Math.random() - 0.5) * 0.06,
        });

        holderDC.stop();
        holderPM.stop();
        this.dribbles[1 - this._holderIdx].stop();

        this._receptions[1 - this._holderIdx].start({
            runTargetX: target.x,
            runTargetY: target.y,
        });

        this._state = ATTACK_STATE.PASSING;
        this._passTimer = 0.6;

        return { action: 'pass', data: { from: this._holderIdx, to: 1 - this._holderIdx } };
    }

    _setHolder(idx) {
        this._receptions[idx].stop();
        this._holderIdx = idx;
        this._state = ATTACK_STATE.DRIBBLE;
        this._passTimer = 0;
        this._shootCooldown = 0;
        this._duelTimer = 0;
        this._supportRunX = 0;
        this._supportRunY = 0;
    }
}
