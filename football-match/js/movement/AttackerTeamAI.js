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
const SPACING = {
    MIN_DIST: 50,
    MAX_DIST: 130,
    IDEAL_MIN: 65,
    IDEAL_MAX: 115,
    X_GAP_MIN: 10,
    X_GAP_MAX: 110,
    Y_GAP_MIN: 40,
    Y_GAP_MAX: 105,
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
        this.shootMinX   = options.shootMinX ?? 750;
        this.shootMaxX   = options.shootMaxX ?? 885;
        this.speeds      = options.speeds ?? SPEEDS_DEFAULT;
        this.possessOffset = options.possessOffset ?? 19;
        this.yMin = options.yMin ?? 45;
        this.yMax = options.yMax ?? 635;

        this.defenders = options.defenders ?? [];

        this._threatDist = 180;
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
            new BallReception(this.players[0], this.movements[0], this.bm),
            new BallReception(this.players[1], this.movements[1], this.bm),
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
        this._passTimer = 0.4;
        this._shootCooldown = 0;
        this._duelTimer = 0;
        this._supportRunX = 0;
        this._supportRunY = 0;
        this._supportTimer = 0;
        this._holderTimer = 0;
        this._swayPhase = Math.random() * Math.PI * 2;
    }

    stop() {
        this._active = false;
        this._state = ATTACK_STATE.DRIBBLE;
        this._receptions.forEach(r => r.stop());
        this._supportTimer = 0;
        this._holderTimer = 0;
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

        // ── PASSING: BallReception + 패서 침투 런 ──
        if (this._state === ATTACK_STATE.PASSING) {
            this._receptions[si].update(dt);
            // 패스 후 홀더도 멈추지 않고 지속 침투 (자연스러움)
            this._updateHolderPenetration(holder, holderPM, dt);
            // 서포트 수령 중에도 간격 유지 관점에서 추가 보정 없음 — 리셉션이 주도

            if (this._receptions[si].received) {
                this.dribbles[si].stop();
                this._setHolder(si);
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

        // 서포트는 항상 간격 유지 + 미세 이동 (서지 않음)
        this._updateSupportRun(support, supportPM, dt);
        // 홀더도 항상 전진 커브 (정지 방지)
        this._keepHolderMoving(holder, holderPM, holderDC, dt);

        // 패스 타이밍: 간격이 이상적이고 패스 레인이 비교적 열렸을 때 — 폭이 있으면 레벨 패스도 허용
        const distHS = Math.hypot(support.x - holder.x, support.y - holder.y);
        const xGap = support.x - holder.x;
        const yGapAbs = Math.abs(support.y - holder.y);
        const supportInIdeal = distHS >= SPACING.IDEAL_MIN && distHS <= SPACING.IDEAL_MAX
            && xGap >= SPACING.X_GAP_MIN - 15 && xGap <= SPACING.X_GAP_MAX
            && yGapAbs >= 28;
        const laneBlocked = this._isLaneBlocked(holder, support);

        if (supportInIdeal && this._passTimer <= 0 && holderDC.ballAttached) {
            // 레인 개방 + 폭 확보 시 패스 확률 상향
            const baseP = laneBlocked ? 0.035 : 0.09;
            const widthBonus = yGapAbs > 55 ? 0.04 : 0;
            if (Math.random() < baseP + widthBonus) return this._firePass(holder, support, holderPM, supportPM, holderDC);
        }

        // 추가: 서포트가 전방에 있고 간격이 넓으면 압박 없어도 자연스러운 패스
        const supportWellAhead = xGap > 20 && xGap < 115 && yGapAbs > 35 && distHS < 135;
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

            if (dist < this._threatDist && this._passTimer <= 0) {
                const supportAhead = xGap > 25;
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

    _updateSupportRun(support, supportPM, dt = 0.016) {
        const holder = this.holder;
        const dist = Math.hypot(support.x - holder.x, support.y - holder.y);
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
            // 간격이 정상이면 미세 sway로 서 있지 않게 유지
            if (Math.hypot(supportPM._tx - support.x, supportPM._ty - support.y) < 25 && Math.random() < 0.02) {
                const swayY = (Math.random() - 0.5) * 22;
                const swayX = (Math.random() - 0.5) * 12;
                const nx = clamp(support.x + swayX, this.yMin, this.goalX);
                const ny = clamp(support.y + swayY, this.yMin + 15, this.yMax - 15);
                // 실제 이동 목표는 기존 목표 근처에서 미세 조정
                supportPM.moveTo(
                    clamp(this._supportRunX + swayX, holder.x + 25, this.goalX - 40),
                    clamp(this._supportRunY + swayY, this.yMin + 15, this.yMax - 15)
                );
            }
            return;
        }

        // 새 목표 산출 — 홀더 기준 전방+측면 오프셋
        const side = this._chooseLateralSide(holder, support);
        const idealXGap = 45 + Math.random() * 35; // 45~80
        const idealYGap = side * (62 + Math.random() * 28); // 62~90

        let targetX = holder.x + idealXGap;
        let targetY = holder.y + idealYGap;

        // 홀더가 중앙보다 앞선 경우 서포트는 약간 뒤처지며 폭을 유지 (삼각형)
        if (holder.x > this.goalX - 280 && Math.random() < 0.35) {
            targetX = holder.x + 28 + Math.random() * 22; // 깊게 침투 대신 측면 벌리기
        }

        // 수비수와의 최소 거리 확보 (패스 레인)
        for (const def of this.defenders) {
            if (Math.hypot(targetX - def.x, targetY - def.y) < 32) {
                targetY += side * 22;
                targetX -= 8;
            }
        }

        targetX = clamp(targetX, holder.x + 25, this.goalX - 40);
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
        if (holderPM.moving) {
            // 이미 움직이는 중이면 자연스럽게 유지, 기회가 되면 약간 방향 보정
            if (Math.random() < 0.015) {
                const targetX = Math.min(this.goalX - 40, holder.x + 70 + Math.random() * 50);
                const targetY = clamp(holder.y + (Math.random() - 0.5) * 60, this.yMin + 15, this.yMax - 15);
                holderPM.speed = this.speeds[3];
                holderPM.moveTo(targetX, targetY);
            }
            return;
        }
        const targetX = Math.min(this.goalX - 40, holder.x + 75 + Math.random() * 55);
        const targetY = clamp(holder.y + (Math.random() - 0.5) * 70, this.yMin + 15, this.yMax - 15);
        holderPM.speed = this.speeds[3];
        holderPM.moveTo(targetX, targetY);
    }

    _enterDuel(holderPM, holderDC, holder, defender) {
        this._state = ATTACK_STATE.DUEL;
        this._duelTimer = 0;
        // 즉시 측면으로 한 발 빼며 드리블 유지 — 정지 없음
        const sign = defender ? ((defender.y - holder.y) > 0 ? -1 : 1) : (Math.random() < 0.5 ? -1 : 1);
        holderDC.start();
        holderPM.speed = this.speeds[2];
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
        const dir = forwardVector(support.angle);
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
    }
}
