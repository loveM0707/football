/**
 * AttackerTeamAI - 공격팀 2인 협력 AI 모듈 (리팩토링)
 *
 * 재사용 모듈:
 *   - DribbleBehaviors: 드리블 프리미티브
 *   - ThroughPass: 공간패스 계산
 *   - BallReception: 패스 수령
 *   - PassMovement: 패스 실행
 *
 * 개선점 (모듈 공통 적용):
 *   - 일정 간격 유지: 홀더-서포트 간 X 35~95, 전체 거리 70~105 유지
 *   - 서지 않고 지속 이동: 서포트는 항상 미세 sway, 홀더는 커브 드리블
 *   - 볼 안정화와 연동: 킥 유예 중에도 이동 유지, 패스 타이밍은 간격 기반
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

// 간격 상수 — 다른 메뉴에서도 재사용 가능 (패스는 레벨~전방 모두 허용)
// 모듈 개선: 홀더-서포트 최소 거리 상향 — 서포트가 홀더에게 파고들어 붙는 현상 방지
const SPACING = {
    MIN_DIST: 75,
    MAX_DIST: 160,
    IDEAL_MIN: 95,
    IDEAL_MAX: 150,
    X_GAP_MIN: 25,
    X_GAP_MAX: 125,
    Y_GAP_MIN: 55,
    Y_GAP_MAX: 130,
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class AttackerTeamAI {
    constructor(options = {}) {
        this.players     = options.players;
        this.movements   = options.movements;
        this.dribbles    = options.dribbles;
        this.bm          = options.ballMovement;
        this.goalX       = options.goalX ?? 1050;
        this.centerY     = options.centerY ?? 340;
        this.shootMinX   = options.shootMinX ?? 860; // 골 전방 19m — 너무 먼 슈팅 방지
        this.shootMaxX   = options.shootMaxX ?? 990;
        this.speeds      = options.speeds ?? SPEEDS_DEFAULT;
        this.possessOffset = options.possessOffset ?? 19;
        this.yMin = options.yMin ?? 45;
        this.yMax = options.yMax ?? 635;

        this.defenders = options.defenders ?? [];

        this._threatDist = 260;
        this._threatLead = 15;
        this._beatenGap  = 25;

        this._throughPass = new ThroughPass({
            leadDistance: 70,
            arriveSpeed: 65,
            maxDeviationDeg: 2,
        });
        this._toFeetPass  = new ThroughPass({
            leadDistance: 12,
            arriveSpeed: 65,
            maxDeviationDeg: 2,
        });
        this._receptions = [
            new BallReception(this.players[0], this.movements[0], this.bm, { maxBallSpeed: 210 }),
            new BallReception(this.players[1], this.movements[1], this.bm, { maxBallSpeed: 210 }),
        ];

        this._active = false;
        this._state = ATTACK_STATE.DRIBBLE;
        this._holderIdx = 0;
        this._passTimer = 0;
        this._shootCooldown = 0;
        this._duelTimer = 0;
        this._duelHoldTime = 0.35;

        this._supportRunX = 0;
        this._supportRunY = 0;
        this._supportTimer = 0;
        this._holderTimer = 0;
        this._swayPhase = Math.random() * Math.PI * 2;
        this._passingElapsed = 0;
        this._recoveryIdx = -1;
        this._passCycles = 0;
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

    /**
     * 현재 BallReception이 활성화된 선수 인덱스 (패스 수신자 또는 복구 수령자).
     * PassInterceptor 같은 타 모듈이 지정 수신자를 제외할 때 사용.
     */
    get receivingIdx() {
        if (!this._active || this._state !== ATTACK_STATE.PASSING) return -1;
        return this._recoveryIdx >= 0 ? this._recoveryIdx : (1 - this._holderIdx);
    }

    /**
     * 외부 모듈(패스 인터셉트 등)이 홈 선수의 소유를 확정했을 때 호출.
     * 기존 수령·드리블 상태를 정리하고 해당 선수를 홀더로 전환한다.
     */
    notifyExternalControl(idx) {
        if (idx === this._holderIdx && this._state === ATTACK_STATE.DRIBBLE) return;
        this._recoveryIdx = -1;
        this._passingElapsed = 0;
        this._passCycles = 0;
        this.dribbles.forEach(d => d.stop());
        this._receptions.forEach(r => r.stop());
        this._setHolder(idx);
    }

    start() {
        this._active = true;
        this._state = ATTACK_STATE.DRIBBLE;
        this._holderIdx = 0;
        this._passTimer = 0.4;
        this._shootCooldown = 0;
        this._duelTimer = 0;
        this._supportRunX = 0;
        this._supportRunY = 0;
        this._supportTimer = 0;
        this._holderTimer = 0;
        this._swayPhase = Math.random() * Math.PI * 2;
        this._passingElapsed = 0;
        this._recoveryIdx = -1;
        this._passCycles = 0;
    }

    stop() {
        this._active = false;
        this._state = ATTACK_STATE.DRIBBLE;
        this._receptions.forEach(r => r.stop());
        this._supportTimer = 0;
        this._holderTimer = 0;
        this._passingElapsed = 0;
        this._recoveryIdx = -1;
        this._passCycles = 0;
    }

    update(dt) {
        if (!this._active) return null;

        this._shootCooldown -= dt;
        this._passTimer -= dt;
        this._swayPhase += dt * 1.1;

        const hi = this._holderIdx;
        const si = 1 - hi;
        const holder  = this.players[hi];
        const support = this.players[si];
        const holderPM  = this.movements[hi];
        const supportPM = this.movements[si];
        const holderDC  = this.dribbles[hi];

        // ── 전 상태 공통: 무인 지상 볼 강제 회수 워치독 ──
        // 패스 수신 실패·몸블록 파툰 등 어떤 경로로든 소유 없는 지상 볼이 생기면,
        // 가장 가까운 공격수가 회수 범위(24)에 들어오는 즉시 소유를 확정한다.
        // 기존에는 DRIBBLE 상태 분기에서만 검사해 PASSING 중 회수 실패 시
        // "볼을 두고 전진"하는 결함이 있었다.
        if (!this.bm.owner && !this.bm.isAerial && !this.bm.isBouncing) {
            const gBall = this.bm.ball;
            const gBS = Math.hypot(this.bm.vx, this.bm.vy);
            const gdH = Math.hypot(holder.x - gBall.x, holder.y - gBall.y);
            const gdS = Math.hypot(support.x - gBall.x, support.y - gBall.y);
            if (gBS <= 185 && Math.min(gdH, gdS) <= 24) {
                const catcher = gdH <= gdS ? hi : si;
                this.bm.possess(this.players[catcher], this.possessOffset);
                this.bm.snapToFront();
                this.dribbles[hi].stop();
                this.dribbles[si].stop();
                this.movements[catcher].clearFacingTarget();
                this._setHolder(catcher);
                return null;
            }
        }

        // ── PASSING: BallReception + 패서 침투 런 (+ 수령 실패 시 복구 수령) ──
        if (this._state === ATTACK_STATE.PASSING) {
            // 모듈 개선: 복구 수령 중에는 해당 선수의 리셉션이 주도한다
            const rIdx = this._recoveryIdx >= 0 ? this._recoveryIdx : si;
            const rec = this._receptions[rIdx];
            rec.update(dt);
            if (this._recoveryIdx < 0) {
                // 패스 후 홀더도 멈추지 않고 지속 침투 (자연스러움)
                this._updateHolderPenetration(holder, holderPM, dt);
            }
            this._passingElapsed += dt;

            const ball = this.bm.ball;
            const ballHasOwner = Boolean(this.bm.owner);

            if (rec.received) {
                this.dribbles[hi].stop();
                this.dribbles[si].stop();
                const winnerIdx = rIdx;
                this._recoveryIdx = -1;
                this._passingElapsed = 0;
                this._setHolder(winnerIdx);
                return null;
            }

            // 모듈 개선: 수신자가 못 받는 패스(뒤/멀리) → 1.1초 후 가까운 선수에게
            // BallReception을 재할당해 '트랩까지' 모듈이 처리한다. (이전엔 추격만 하여
            // 누구도 소유하지 못해 전원이 볼에 뭉쳐 멈췄다.)
            if (!ballHasOwner && this._recoveryIdx < 0 && this._passingElapsed > 1.1) {
                const dH = Math.hypot(holder.x - ball.x, holder.y - ball.y);
                const dS = Math.hypot(support.x - ball.x, support.y - ball.y);
                this._recoveryIdx = dH <= dS ? hi : si;
                this._receptions[this._recoveryIdx].stop();
                this._receptions[this._recoveryIdx].start({});
                this._passingElapsed = 0;
                return null;
            }

            // 복구 수령조차 지연되면 재시작 사이클 — 데드락 방지
            if (this._recoveryIdx >= 0 && this._passingElapsed > 2.2) {
                this._receptions[this._recoveryIdx].stop();
                this._recoveryIdx = -1;
                this._passingElapsed = 0;
                this._passCycles += 1;
            }

            // 모듈 개선: PASSING 완전 데드락 폴백 — 재시작 3회 반복 후에도 회수 불능이면
            // 상태를 DRIBBLE로 되돌려 루즈볼 직접 추격 로직이 개입하게 한다.
            // (기존엔 영원히 PASSING에 갇혀 아무도 볼을 찾지 않았다.)
            if (this._passCycles >= 3 && this._passingElapsed > 1.0) {
                this._receptions.forEach(r => r.stop());
                this._recoveryIdx = -1;
                this._passingElapsed = 0;
                this._passCycles = 0;
                this.dribbles[hi].stop();
                this.dribbles[si].stop();
                this._state = ATTACK_STATE.DRIBBLE;
                return null;
            }
            return null;
        }

        // ── DUEL: 짧은 홀드 후 측면 돌파, 그동안 서포트도 지속 이동 ──
        if (this._state === ATTACK_STATE.DUEL) {
            this._duelTimer += dt;
            // 듀엘 중에도 서포트는 간격 유지하며 움직임 (서 있지 않음)
            this._updateSupportRun(support, supportPM, dt);

            if (this._duelTimer > this._duelHoldTime) {
                const nearDef = this._findNearestThreat(holder);
                const sign = nearDef
                    ? ((nearDef.y - holder.y) > 0 ? -1 : 1)
                    : ((support.y - holder.y) > 0 ? -1 : 1);
                DribbleBehaviors.lateralBurst(holderPM, holderDC, holder, sign, () => {
                    holderDC.start();
                    // 돌파 후에도 커브 드리블로 자연스럽게 골 방향
                    const bx = Math.min(this.goalX - 60, holder.x + 140);
                    const by = clamp(holder.y + sign * 18, this.yMin + 15, this.yMax - 15);
                    holderPM.speed = this.speeds[4];
                    holderPM.moveTo(bx, by);
                }, { forwardDist: 110, lateralDist: 75, maxX: this.goalX - 60, yMin: this.yMin, yMax: this.yMax });
                this._state = ATTACK_STATE.DRIBBLE;
                this._holderTimer = 0;
            }
            return null;
        }

        // ── DRIBBLE ──
        if (this._state !== ATTACK_STATE.DRIBBLE) return null;

        // ── 모듈 개선: 루즈볼 즉시 회수 — 볼을 두고 전진하는 현상 근본 차단 ──
        // 소유 없는 지상 볼은 속도·거리 무관하게 항상 추격한다.
        // 접촉 반경 회수는 update() 상단 워치독이 전 상태에서 공통 처리한다.
        if (!this.bm.owner && !this.bm.isAerial && !this.bm.isBouncing) {
            const ball = this.bm.ball;
            const dH = Math.hypot(holder.x - ball.x, holder.y - ball.y);
            const dS = Math.hypot(support.x - ball.x, support.y - ball.y);
            const ballSpeed = Math.hypot(this.bm.vx, this.bm.vy);

            // 가까운 선수는 인터셉트 지점(마찰 감속 예측)으로 스프린트
            const dNear = Math.min(dH, dS);
            const tLead = Math.min(dNear / 150, ballSpeed > 1 ? ballSpeed / 380 : 0, 0.6);
            const chaserPM = dH <= dS ? holderPM : supportPM;
            chaserPM.clearFacingTarget();
            chaserPM.speed = this.speeds[4];
            chaserPM.moveTo(
                clamp(ball.x + this.bm.vx * tLead * 0.7, 10, this.goalX - 30),
                clamp(ball.y + this.bm.vy * tLead * 0.7, this.yMin + 12, this.yMax - 12)
            );

            // 다른 선수는 자책골 방향 커버 — 볼 뒤 65 + 측면 여유 확보
            const cover = dH <= dS ? support : holder;
            const coverPM = dH <= dS ? supportPM : holderPM;
            const coverDist = Math.hypot(cover.x - ball.x, cover.y - ball.y);
            const side = (cover.y >= ball.y) ? 1 : -1;
            const cyT = Math.abs(cover.y - ball.y) < 65 ? ball.y + side * 85 : cover.y;
            coverPM.clearFacingTarget();
            coverPM.speed = coverDist > 140 ? this.speeds[4] : coverDist > 60 ? this.speeds[3] : this.speeds[2];
            coverPM.moveTo(
                clamp(ball.x - 65, 15, this.goalX - 80),
                clamp(cyT, this.yMin + 18, this.yMax - 18)
            );

            return null;
        }

        // 서포트는 항상 간격 유지 + 미세 이동 (서지 않음)
        this._updateSupportRun(support, supportPM, dt);
        // 홀더도 항상 전진 커브 (정지 방지)
        this._keepHolderMoving(holder, holderPM, holderDC, dt);

        // 패스 타이밍: 간격이 이상적이고 패스 레인이 비교적 열렸을 때 — 폭이 있으면 레벨 패스도 허용
        const distHS = Math.hypot(support.x - holder.x, support.y - holder.y);
        const xGap = support.x - holder.x;
        const yGapAbs = Math.abs(support.y - holder.y);
        const supportInIdeal = distHS >= SPACING.IDEAL_MIN && distHS <= SPACING.IDEAL_MAX
            && xGap >= SPACING.X_GAP_MIN - 10 && xGap <= SPACING.X_GAP_MAX
            && yGapAbs >= 50;
        const laneBlocked = this._isLaneBlocked(holder, support);

        if (supportInIdeal && this._passTimer <= 0 && holderDC.ballAttached) {
            // 레인 개방 + 폭 확보 시 패스 확률 상향
            const baseP = laneBlocked ? 0.035 : 0.09;
            const widthBonus = yGapAbs > 55 ? 0.04 : 0;
            if (Math.random() < baseP + widthBonus) return this._firePass(holder, support, holderPM, supportPM, holderDC);
        }

        // 추가: 서포트가 전방에 있고 간격이 넓으면 압박 없어도 자연스러운 패스
        const supportWellAhead = xGap > 30 && xGap < 140 && yGapAbs > 60 && distHS < 175;
        if (supportWellAhead && this._passTimer <= 0 && holderDC.ballAttached && holder.x < this.goalX - 220) {
            const p2 = laneBlocked ? 0.022 : 0.045;
            if (Math.random() < p2) return this._firePass(holder, support, holderPM, supportPM, holderDC);
        }

        // 수비 위협 감시
        const nearestThreat = this._findNearestThreat(holder);
        if (nearestThreat && holderDC.ballAttached) {
            const dist = Math.hypot(nearestThreat.x - holder.x, nearestThreat.y - holder.y);
            const defBehind = nearestThreat.x < holder.x - this._beatenGap;

            if (defBehind) {
                holderDC.start();
                this._keepHolderMoving(holder, holderPM, holderDC, dt, true);
                return null;
            }

            if (dist < this._threatDist * 1.5 && this._passTimer <= 0) {
                const supportAhead = xGap > 30;
                // 간격이 좋으면 패스 우선, 아니면 돌파
                if (supportInIdeal && supportAhead && Math.random() < 0.68) {
                    return this._firePass(holder, support, holderPM, supportPM, holderDC);
                } else if (dist < 110) {
                    return this._enterDuel(holderPM, holderDC, holder, nearestThreat);
                } else if (supportAhead && Math.random() < 0.45) {
                    return this._firePass(holder, support, holderPM, supportPM, holderDC);
                } else {
                    return this._enterDuel(holderPM, holderDC, holder, nearestThreat);
                }
            }
        }

        // 모듈 개선: 볼 소유 중 양쪽 모두 정지하면 드리블 재가동 (루즈볼은 위 블록이 무조건 회수)
        if (Boolean(this.bm.owner) && !holderPM.moving && !supportPM.moving) {
            this._keepHolderMoving(holder, holderPM, holderDC, dt, true);
            if (!supportPM.moving) {
                supportPM.clearFacingTarget();
                supportPM.speed = this.speeds[3];
                const side = this._chooseLateralSide(holder, support);
                supportPM.moveTo(
                    clamp(holder.x + 70 + Math.random() * 40, 0, this.goalX - 40),
                    clamp(holder.y + side * (SPACING.Y_GAP_MIN + Math.random() * 25), this.yMin + 15, this.yMax - 15)
                );
            }
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
        this._passTimer = 0.45;
        this._shootCooldown = 0;
        this._duelTimer = 0;
        this._supportTimer = 0;
        this._holderTimer = 0;
        this._passingElapsed = 0;
        this._recoveryIdx = -1;
        // 모듈 개선: 보유 전환 시 facing 해제 — 드리블 방향 정확화
        for (const m of this.movements) m.clearFacingTarget();
    }

    /* ── private ─────────────────────────────────── */

    _findNearestThreat(holder) {
        let best = null;
        let bestScore = Infinity;
        for (const def of this.defenders) {
            const dx = def.x - holder.x;
            const dy = def.y - holder.y;
            const dist = Math.hypot(dx, dy);
            if (dx > this._threatLead && dist < this._threatDist * 1.6) {
                const score = dist - dx * 0.35;
                if (score < bestScore) { bestScore = score; best = def; }
            }
        }
        return best;
    }

    _isLaneBlocked(holder, support) {
        for (const def of this.defenders) {
            const d = this._distPointToSegment(def.x, def.y, holder.x, holder.y, support.x, support.y);
            if (d < 28) return true;
        }
        return false;
    }

    _distPointToSegment(px, py, x1, y1, x2, y2) {
        const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
        if (l2 === 0) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
        t = clamp(t, 0, 1);
        return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
    }

    _chooseLateralSide(holder, support) {
        // 수비수로부터 더 먼 쪽, 필드 중앙 여백, 기존 서포트 위치를 종합
        let scoreUp = 0, scoreDown = 0;
        for (const def of this.defenders) {
            const dUp = Math.hypot(def.x - holder.x, (holder.y - 75) - def.y);
            const dDown = Math.hypot(def.x - holder.x, (holder.y + 75) - def.y);
            if (dUp > dDown) scoreUp += 1; else scoreDown += 1;
        }
        // 필드 가장자리 페널티
        if (holder.y < 180) scoreUp -= 1.5;
        if (holder.y > 500) scoreDown -= 1.5;
        // 기존 서포트 위치 유지 경향 (갑작스러운 사이드 변경 방지)
        if (support.y < holder.y) scoreUp += 0.6; else scoreDown += 0.6;

        if (scoreUp === scoreDown) return Math.random() < 0.5 ? -1 : 1;
        return scoreUp > scoreDown ? -1 : 1;
    }

    /**
     * 모듈 개선: 홀더-서포트 최소 간격 강제.
     * dist < MIN_DIST면 반경방향으로 IDEAL_MIN+15 지점까지 스프린트 이탈시키고 true 반환.
     * 홀더가 서포트 쪽으로 전진해 간격이 무너지는 순간 즉시 대응한다.
     */
    _enforceSupportSeparation(support, supportPM) {
        const holder = this.holder;
        const dx = support.x - holder.x;
        const dy = support.y - holder.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= SPACING.MIN_DIST) return false;

        const nx = dist > 1 ? dx / dist : 1;
        const ny = dist > 1 ? dy / dist : 0;
        const push = SPACING.IDEAL_MIN + 15;
        let tx = holder.x + nx * push;
        let ty = holder.y + ny * push;
        // 측면 성분 보장 — 홀더 바로 앞/옆으로 붙어나가는 탈출 방지
        const minYGap = SPACING.Y_GAP_MIN + 10;
        if (Math.abs(ty - holder.y) < minYGap) {
            const side = ny !== 0 ? Math.sign(ny) : (Math.random() < 0.5 ? -1 : 1);
            ty = holder.y + side * minYGap;
            tx = holder.x + Math.max(nx * push, 30);
        }
        tx = clamp(tx, 10, this.goalX - 40);
        ty = clamp(ty, this.yMin + 20, this.yMax - 20);

        this._supportRunX = tx;
        this._supportRunY = ty;
        supportPM.clearFacingTarget();
        supportPM.speed = this.speeds[4];
        supportPM.moveTo(tx, ty);
        this._supportTimer = 0.35;
        return true;
    }

    _updateSupportRun(support, supportPM, dt = 0.016) {
        const holder = this.holder;
        const dist = Math.hypot(support.x - holder.x, support.y - holder.y);

        // 모듈 개선: 최소 간격 붕괴 시 즉시 반경방향 이탈 — 홀더에게 파고들어 붙는 현상 차단
        // (재타겟 타이머와 무관하게 매 프레임 판정)
        if (this._enforceSupportSeparation(support, supportPM)) return;

        const xGap = support.x - holder.x;
        const reached = this._supportRunX !== 0
            && Math.hypot(support.x - this._supportRunX, support.y - this._supportRunY) < 18;

        this._supportTimer -= dt;

        const needRetarget =
            !supportPM.moving ||
            reached ||
            this._supportRunX === 0 ||
            this._supportTimer <= 0 ||
            dist < SPACING.MIN_DIST ||
            dist > SPACING.MAX_DIST ||
            xGap < SPACING.X_GAP_MIN - 8 ||
            xGap > SPACING.X_GAP_MAX + 12;

        if (!needRetarget) {
            // 간격이 정상이면 미세 sway로 서 있지 않게 유지 — 모듈 개선: clearFacing으로 방향 정확화, sway 빈도 상향
            if (Math.hypot((supportPM._tx ?? support.x) - support.x, (supportPM._ty ?? support.y) - support.y) < 25 && Math.random() < 0.06) {
                const swayY = (Math.random() - 0.5) * 22;
                const swayX = (Math.random() - 0.5) * 12;
                supportPM.clearFacingTarget();
                supportPM.moveTo(
                    clamp(this._supportRunX + swayX, holder.x + 40, this.goalX - 40),
                    clamp(this._supportRunY + swayY, this.yMin + 15, this.yMax - 15)
                );
            }
            // 정지 방지: moving이 true라도 실제로 정체(속도 0)면 미세 재가동
            if (!supportPM.moving) {
                supportPM.clearFacingTarget();
                supportPM.speed = this.speeds[2];
                supportPM.moveTo(
                    clamp(support.x + (Math.random() - 0.5) * 20, this.yMin, this.goalX),
                    clamp(support.y + (Math.random() - 0.5) * 20, this.yMin + 15, this.yMax - 15)
                );
            }
            return;
        }

        // 새 목표 산출 — 홀더 기준 전방+측면 오프셋 (간격 상향: 넓은 삼각형 유지)
        const side = this._chooseLateralSide(holder, support);
        const idealXGap = 55 + Math.random() * 45; // 55~100
        const idealYGap = side * (78 + Math.random() * 34); // 78~112

        let targetX = holder.x + idealXGap;
        let targetY = holder.y + idealYGap;

        // 홀더가 중앙보다 앞선 경우 서포트는 약간 뒤처지며 폭을 유지 (삼각형)
        if (holder.x > this.goalX - 280 && Math.random() < 0.35) {
            targetX = holder.x + 40 + Math.random() * 25; // 깊게 침투 대신 측면 벌리기
        }

        // 수비수와의 최소 거리 확보 (패스 레인)
        for (const def of this.defenders) {
            if (Math.hypot(targetX - def.x, targetY - def.y) < 32) {
                targetY += side * 26;
                targetX -= 8;
            }
        }

        targetX = clamp(targetX, holder.x + 35, this.goalX - 40);
        targetY = clamp(targetY, this.yMin + 15, this.yMax - 15);

        // 미세 자연스러움: sway 추가
        targetY += Math.sin(this._swayPhase) * 6;
        targetX += Math.cos(this._swayPhase * 0.7) * 4;
        targetY = clamp(targetY, this.yMin + 15, this.yMax - 15);
        targetX = clamp(targetX, 0, this.goalX - 40);

        this._supportRunX = targetX;
        this._supportRunY = targetY;

        // 거리에 따라 속도 조절 — 멀면 스프린트, 가까우면 조깅으로 자연스럽게
        // 모듈 개선: 뒤처진 경우(xGap <0)에는 거리와 무관하게 스프린트로 간격 회복
        let speed;
        if (dist > SPACING.MAX_DIST) speed = this.speeds[4];
        else if (dist > SPACING.IDEAL_MAX) speed = this.speeds[3];
        else if (dist < SPACING.MIN_DIST) speed = this.speeds[2];
        else speed = this.speeds[3];
        if (xGap < 0) speed = this.speeds[4];
        else if (xGap < 15) speed = Math.max(speed, this.speeds[3]);

        supportPM.speed = speed;
        supportPM.clearFacingTarget();
        supportPM.moveTo(targetX, targetY);

        this._supportTimer = 0.55 + Math.random() * 0.45;
    }

    _keepHolderMoving(holder, holderPM, holderDC, dt, forced = false) {
        this._holderTimer -= dt;
        const moving = holderPM.moving;
        const needNew = !moving || this._holderTimer <= 0;

        if (!needNew && !forced) return;

        const nearest = this._findNearestThreat(holder);
        let lateral = (Math.random() - 0.5) * 55;
        if (nearest) {
            // 수비수 반대 방향으로 커브
            const sign = (nearest.y - holder.y) > 0 ? -1 : 1;
            lateral = sign * (28 + Math.random() * 38) + (Math.random() - 0.5) * 18;
        } else {
            // 수비 없으면 약한 지그재그
            lateral = Math.sin(this._swayPhase * 0.9) * 22 + (Math.random() - 0.5) * 18;
        }

        // 전진 거리: 항상 골 방향으로 진행, 간격이 벌어지면 속도 조절로 서포트 대기
        const support = this.support;
        const distHS = Math.hypot(support.x - holder.x, support.y - holder.y);
        const xGap = support.x - holder.x;
        const forward = 65 + Math.random() * 45;
        let targetX = Math.min(this.goalX - 60, holder.x + forward);
        let targetY = clamp(holder.y + lateral, this.yMin + 15, this.yMax - 15);

        if (targetX > this.goalX - 200) {
            const pull = (this.centerY - targetY) * 0.18;
            targetY = clamp(targetY + pull, this.yMin + 15, this.yMax - 15);
        }

        // 모듈 개선: 홀더 진로가 서포트에게 파고들지 않게 — 목표가 서포트에 근접하면 반대 측면으로 휘어짐
        if (Math.hypot(targetX - support.x, targetY - support.y) < 85) {
            const away = (support.y >= holder.y) ? -1 : 1;
            targetY = clamp(holder.y + away * 60, this.yMin + 15, this.yMax - 15);
        }

        // 간격이 너무 벌어지면 홀더가 템포를 늦춰 서포트와 동행 (자연스러운 호흡)
        let hSpeed = this.speeds[3];
        if (distHS > SPACING.MAX_DIST || xGap < -25) hSpeed = this.speeds[2];
        else if (distHS > SPACING.IDEAL_MAX) hSpeed = this.speeds[2];
        holderDC.start();
        // DribbleBehaviors.sprint는 고정 150으로 덮어쓰므로, 간격 기반 속도(hSpeed)로 재설정
        DribbleBehaviors.sprint(holderPM, holderDC, targetX, targetY);
        holderPM.speed = hSpeed;
        if (holderDC._pendingSpeed !== null) holderDC._pendingSpeed = hSpeed;

        this._holderTimer = 0.65 + Math.random() * 0.5;
    }

    _updateHolderPenetration(holder, holderPM, dt = 0.016) {
        // 패스 후 홀더가 즉시 멈추지 않도록 지속 침투 — 멈춘 경우에만 새 목표 부여
        // 모듈 개선: 수신자(새 홀더 예정)에게 파고들지 않게 반대 측면으로 침투
        const receiver = this.support;
        const awaySide = (receiver.y >= holder.y) ? -1 : 1;

        // 모듈 개선: 패스 비행 초반(볼 고속, 수령 전)에는 서행 동행 —
        // 패스한 선수가 "볼을 놓고 혼자 전력 질주"하는 인상과 실제 지원 실패를 함께 차단.
        const ballSpeedNow = Math.hypot(this.bm.vx, this.bm.vy);
        if (!this.bm.owner && this._passingElapsed < 0.45 && ballSpeedNow > 230) {
            holderPM.clearFacingTarget();
            holderPM.speed = this.speeds[1];
            holderPM.moveTo(
                clamp(holder.x + 12, 15, this.goalX - 40),
                clamp(holder.y + awaySide * 12, this.yMin + 15, this.yMax - 15)
            );
            return;
        }

        if (holderPM.moving) {
            // 이미 움직이는 중이면 자연스럽게 유지, 기회가 되면 약간 방향 보정
            if (Math.random() < 0.015) {
                let targetX = Math.min(this.goalX - 40, holder.x + 70 + Math.random() * 50);
                let targetY = clamp(holder.y + awaySide * (40 + Math.random() * 35), this.yMin + 15, this.yMax - 15);
                if (Math.hypot(targetX - receiver.x, targetY - receiver.y) < 90) {
                    targetX -= 45; // 수신자와 겹치면 전진을 늦춰 간격 확보
                }
                holderPM.speed = this.speeds[3];
                holderPM.clearFacingTarget();
                holderPM.moveTo(targetX, targetY);
            }
            return;
        }
        let targetX = Math.min(this.goalX - 40, holder.x + 75 + Math.random() * 55);
        let targetY = clamp(holder.y + awaySide * (45 + Math.random() * 40), this.yMin + 15, this.yMax - 15);
        if (Math.hypot(targetX - receiver.x, targetY - receiver.y) < 90) {
            targetX -= 45;
        }
        holderPM.speed = this.speeds[3];
        holderPM.clearFacingTarget();
        holderPM.moveTo(targetX, targetY);
    }

    _enterDuel(holderPM, holderDC, holder, defender) {
        this._state = ATTACK_STATE.DUEL;
        this._duelTimer = 0;
        // 즉시 측면으로 한 발 빼며 드리블 유지 — 정지 없음, 방향 정확화
        const sign = defender ? ((defender.y - holder.y) > 0 ? -1 : 1) : (Math.random() < 0.5 ? -1 : 1);
        holderDC.start();
        holderPM.speed = this.speeds[2];
        holderPM.clearFacingTarget();
        const stepX = Math.min(holder.x + 32, this.goalX - 80);
        const stepY = clamp(holder.y + sign * 28, this.yMin + 15, this.yMax - 15);
        holderPM.moveTo(stepX, stepY);
        return null;
    }

    _firePass(holder, support, holderPM, supportPM, holderDC) {
        const nearDef = this._findNearestThreat(holder);
        const defDist = nearDef
            ? Math.hypot(nearDef.x - holder.x, nearDef.y - holder.y)
            : Infinity;
        const useToFeet = Math.random() < (defDist < 130 ? 0.58 : 0.32);

        const passCalc = useToFeet ? this._toFeetPass : this._throughPass;
        let dir = forwardVector(support.angle);
        // 모듈 개선: 러너 정면이 패스 레인과 크게 어긋나면(뒤쪽 수령 유발) 레인 방향으로 교정 —
        // '수신자가 향하는 방향의 뒤쪽'으로 패스가 가는 원인 차단
        const laneX = support.x - holder.x;
        const laneY = support.y - holder.y;
        const laneLen = Math.hypot(laneX, laneY) || 1;
        if (dir.x * laneX + dir.y * laneY < laneLen * 0.2) {
            dir = { x: laneX / laneLen, y: laneY / laneLen };
        }
        const target = passCalc.targetSpace({
            runner: support,
            direction: dir,
            runnerSpeed: this.speeds[3],
        });

        // 패스 레인에 수비수가 있으면 반대편으로 약간 보정
        let finalX = target.x, finalY = target.y;
        for (const def of this.defenders) {
            if (Math.hypot(finalX - def.x, finalY - def.y) < 26) {
                finalY += (support.y < def.y ? -16 : 16);
            }
        }
        finalX = clamp(finalX, 0, this.goalX - 40);
        finalY = clamp(finalY, this.yMin + 10, this.yMax - 10);

        PassMovement.shortPass(this.bm, finalX, finalY, {
            arriveSpeed: useToFeet ? 42 + Math.random() * 10 : 58 + Math.random() * 18,
            deviationRad: (Math.random() - 0.5) * 0.05,
        });

        holderDC.stop();
        holderPM.stop();
        this.dribbles[1 - this._holderIdx].stop();

        this._receptions[1 - this._holderIdx].start({
            runTargetX: finalX,
            runTargetY: finalY,
        });

        this._state = ATTACK_STATE.PASSING;
        this._passTimer = 0.75;
        this._passingElapsed = 0;
        this._passCycles = 0;

        return { action: 'pass', data: { from: this._holderIdx, to: 1 - this._holderIdx } };
    }

    _setHolder(idx) {
        this._receptions[idx].stop();
        this._holderIdx = idx;
        this.dribbles[idx].start();
        this._state = ATTACK_STATE.DRIBBLE;
        this._passTimer = 0.35;
        this._shootCooldown = 0;
        this._duelTimer = 0;
        this._supportRunX = 0;
        this._supportRunY = 0;
        this._supportTimer = 0;
        this._holderTimer = 0;
        this._passingElapsed = 0;
        this._recoveryIdx = -1;
        this._passCycles = 0;
        // 모듈 개선: 전환 직후 facing 해제 및 즉시 드리블 방향 부여
        for (const m of this.movements) m.clearFacingTarget();
        // 새 홀더는 즉시 드리블 모듈로 전진 (정지 방지)
        const newHolder = this.players[idx];
        const newPM = this.movements[idx];
        const newDC = this.dribbles[idx];
        newPM.clearFacingTarget();
        newDC.start();
        const nx = Math.min(this.goalX - 60, newHolder.x + 40 + Math.random() * 30);
        const ny = clamp(newHolder.y + (Math.random() - 0.5) * 40, this.yMin + 15, this.yMax - 15);
        newPM.speed = this.speeds[3];
        newPM.moveTo(nx, ny);
        // 모듈 개선: 수령 직후 이전 홀더(새 서포트)가 새 홀더에게 파고들지 않게 즉시 이탈
        const newSupport = this.players[1 - idx];
        const newSupportPM = this.movements[1 - idx];
        if (!this._enforceSupportSeparation(newSupport, newSupportPM)) {
            // 아직 간격이 넉넩해도 최소 측면 폭을 확보한 방향으로 재배치
            const side = this._chooseLateralSide(newHolder, newSupport);
            newSupportPM.clearFacingTarget();
            newSupportPM.speed = this.speeds[3];
            newSupportPM.moveTo(
                clamp(newHolder.x + 55 + Math.random() * 35, 10, this.goalX - 40),
                clamp(newHolder.y + side * (SPACING.Y_GAP_MIN + Math.random() * 30), this.yMin + 15, this.yMax - 15)
            );
        }
    }
}
