/**
 * DribbleDecision - 온볼(볼 소유) 드리블 판단 공통 모듈
 *
 * 볼을 가진 선수가 매 순간 무엇을 할지 결정한다. 모든 자유 플레이 시나리오
 * (1:1, 2:2, 3:3, 앞으로 만들 4:4·11:11)가 이 모듈 하나를 공유하면
 * 드리블의 느낌이 어디서나 같아진다.
 *
 * 행동:
 *   DRIVE   골문을 향해 곧장 몰고 간다. 슛 사거리 안이면 지체 없이 전진.
 *   BEAT    앞을 막은 수비수를 벗겨낸다. 수비수가 열어둔 쪽으로 각을 틀어
 *           치고 나간 뒤 다시 골문 쪽으로 붙는다 (2단 터치).
 *   CARRY   빈 공간으로 전진한다.
 *   WIDE    폭을 벌린다. 골문에서 멀 때만 선택된다.
 *   SHIELD  탈출로가 없을 때 몸으로 볼을 지키며 지연.
 *
 * 설계 원칙:
 *   - 골문 앞에서는 절대 측면으로 벌리지 않는다. (WIDE 는 먼 거리 전용)
 *   - 수비수가 정면을 막으면 무작정 직진하지 않고 반드시 BEAT 로 벗겨낸다.
 *   - 목표점은 항상 현재 몸 방향에서 turnLimit 이내 — 급격한 뒤돌기를 만들지 않는다.
 */
import { PlayerMovement } from './PlayerMovement.js';
import { angleTo, angleDiff } from './Direction.js';
import { Shielding } from './Shielding.js';
import { FeintFoundation } from './FeintFoundation.js';
import { CENTER_Y, Y_MIN, Y_MAX, FIELD_MIN_X, FIELD_MAX_X } from './FieldGeometry.js';

const SPEEDS = PlayerMovement.SPEEDS;

export const DRIBBLE_ACTION = Object.freeze({
    DRIVE: 'drive',
    BEAT: 'beat',
    CARRY: 'carry',
    WIDE: 'wide',
    SHIELD: 'shield',
    FEINT: 'feint',
});

const DEFAULTS = {
    centerY: CENTER_Y,
    yMin: Y_MIN,
    yMax: Y_MAX,
    fieldMinX: FIELD_MIN_X,
    fieldMaxX: FIELD_MAX_X,
    shootRange: 185,      // 이 안이면 골문 직진이 최우선
    wideMinDistance: 300, // 이보다 골문에서 멀 때만 폭을 벌린다
    engageRadius: 82,     // 이 안의 수비수는 벗겨야 할 대상
    blockCone: 42,        // 진행 방향 기준 이 각도 안이면 "앞을 막았다"
    beatLateral: 95,      // 벗길 때 옆으로 벌리는 거리
    beatForward: 130,     // 벗길 때 앞으로 치고 나가는 거리
    beatCooldown: 1.9,    // 연속 시도 방지 — 매 순간 돌파를 시도하지 않는다
    beatChance: 0.55,     // 막혔다고 항상 걸지는 않는다. 아니면 공간으로 돌아 나간다
    turnLimit: 85,        // 목표점 허용 회전각 — 뒤돌기 방지
    retargetMin: 0.45,
    retargetMax: 0.75,
    edgeMargin: 55,
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

export class DribbleDecision {
    /**
     * @param {object} options
     *   dir {number} +1 = 오른쪽 골 공격, -1 = 왼쪽
     */
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this.dir = options.dir ?? 1;
        this._retarget = 0;
        this._beatCooldown = 0;
        this._beatPhase = null;  // { sign, stage, timer }
        this._feintPhase = null; // { stage, timer, fakeAngle, goAngle, goSpeed, goDuration }
        this._feintCooldown = 0;
        this._action = DRIBBLE_ACTION.CARRY;
        // 쉴딩 모듈 — DribbleDecision.SHIELD가 위임
        this._shielding = new Shielding({
            shieldSpeed: SPEEDS[0],
            pressThreshold: 50,
        });
    }

    get action() { return this._action; }

    reset() {
        this._retarget = 0;
        this._beatCooldown = 0;
        this._beatPhase = null;
        this._feintPhase = null;
        this._feintCooldown = 0;
        this._shielding.stop();
    }

    /** 팀의 공격 방향을 바꾼다 (좌우 골 전환 시) */
    setDirection(dir) { this.dir = dir; }

    /**
     * 매 프레임 호출. 캐리어의 이동 목표를 갱신한다.
     *
     * @param {number} dt
     * @param {object} ctx
     *   carrier      {x,y,angle}
     *   movement     PlayerMovement
     *   attackGoalX  {number}
     *   defenders    {Array}  상대 선수
     *   ballAttached {boolean} 볼이 발에 붙어 있는지 (false면 급회전 금지)
     *   forceDrive   {boolean} 결정적 찬스 — 무조건 골문으로
     * @returns {string} 선택된 DRIBBLE_ACTION
     */
    update(dt, ctx) {
        const o = this.o;
        const p = ctx.carrier;
        const pm = ctx.movement;
        const gx = ctx.attackGoalX;
        const dir = this.dir;
        const defenders = ctx.defenders ?? [];
        const attached = ctx.ballAttached !== false;

        this._retarget -= dt;
        if (this._beatCooldown > 0) this._beatCooldown -= dt;
        if (this._feintCooldown > 0) this._feintCooldown -= dt;

        const goalDist = Math.abs(gx - p.x);

        // ── 페인트 진행 중이면 그 동작을 끝까지 수행한다 ──
        if (this._feintPhase) {
            this._feintPhase.timer -= dt;
            if (this._feintPhase.timer > 0 && pm.moving) {
                this._action = DRIBBLE_ACTION.FEINT;
                return this._action;
            }
            if (this._feintPhase.stage === 0) {
                // 2단계: 가짜 방향 끝 → 실제 방향으로 폭발 가속
                this._feintPhase.stage = 1;
                this._feintPhase.timer = this._feintPhase.goDuration;
                const rad = this._feintPhase.goAngle * Math.PI / 180;
                const goDist = 60 + Math.random() * 40;
                const tx = clamp(p.x + (-Math.sin(rad)) * goDist, o.fieldMinX, o.fieldMaxX);
                const ty = clamp(p.y + Math.cos(rad) * goDist, o.yMin + 20, o.yMax - 20);
                pm.clearFacingTarget();
                pm.speed = this._feintPhase.goSpeed;
                pm.moveTo(tx, ty);
                this._action = DRIBBLE_ACTION.FEINT;
                return this._action;
            }
            this._feintPhase = null;
            this._feintCooldown = o.beatCooldown * 1.2;
        }

        // ── 벗기기 진행 중이면 그 동작을 끝까지 수행한다 ──
        if (this._beatPhase) {
            this._beatPhase.timer -= dt;
            if (this._beatPhase.timer > 0 && pm.moving) {
                this._action = DRIBBLE_ACTION.BEAT;
                return this._action;
            }
            if (this._beatPhase.stage === 0) {
                // 2단계: 옆으로 벌렸으니 이제 골문 쪽으로 다시 파고든다
                this._beatPhase.stage = 1;
                this._beatPhase.timer = 0.7;
                const tx = clamp(p.x + dir * o.beatForward, o.fieldMinX, o.fieldMaxX);
                const ty = clamp(p.y + (o.centerY - p.y) * 0.35,
                    o.yMin + 20, o.yMax - 20);
                pm.clearFacingTarget();
                pm.speed = SPEEDS[4];
                pm.moveTo(tx, ty);
                this._action = DRIBBLE_ACTION.BEAT;
                return this._action;
            }
            this._beatPhase = null;
            this._beatCooldown = o.beatCooldown;
        }

        // ── 앞을 막은 수비수 탐색 ──
        const blocker = this._findBlocker(p, defenders, gx, dir);

        // 볼이 붙어 있고 수비수가 정면을 막았다면 벗겨낸다.
        // 매번 걸지는 않는다 — 확률적으로만 시도하고, 아니면 공간으로 돌아 나간다.
        if (blocker && attached && this._beatCooldown <= 0) {
            if (Math.random() < o.beatChance) {
                this._startBeat(p, pm, blocker, gx);
                this._action = DRIBBLE_ACTION.BEAT;
                return this._action;
            }
            // 돌파를 걸지 않기로 했으면 잠시 뒤 다시 판단한다
            this._beatCooldown = o.beatCooldown * 0.5;
        }

        // ── 목표 재설정이 필요할 때만 갱신 ──
        if (pm.moving && this._retarget > 0) return this._action;
        this._retarget = rand(o.retargetMin, o.retargetMax);

        // ── 행동 선택 ──
        // 골문 근처(슛 사거리 + 여유)에서는 무조건 골문으로 몰고 간다.
        // 여기서 측면으로 벌리는 것이 "골대 앞인데 측면 드리블" 현상의 원인이었다.
        const nearGoal = goalDist <= o.shootRange * 1.35;
        if (ctx.forceDrive || nearGoal) {
            this._driveAtGoal(p, pm, gx, attached);
            this._action = DRIBBLE_ACTION.DRIVE;
            return this._action;
        }

        // 압박이 심하고 탈출로가 없으면 쉴딩 (Shielding 모듈 위임)
        const presser = this._nearest(p, defenders);
        if (presser && presser.dist < 42 && !attached) {
            const bounds = { xMin: o.fieldMinX, xMax: o.fieldMaxX,
                             yMin: o.yMin + 20, yMax: o.yMax - 20 };
            const shield = this._shielding.calcShield(p, defenders, bounds);
            if (shield) {
                pm.setFacingTarget(shield.bodyAngle);
                pm.speed = shield.speed;
                pm.moveTo(shield.moveX, shield.moveY);
            } else {
                pm.speed = SPEEDS[1];
                pm.moveTo(clamp(p.x + dir * 25, o.fieldMinX, o.fieldMaxX), p.y);
            }
            this._action = DRIBBLE_ACTION.SHIELD;
            return this._action;
        }

        // 페인트 찬스: 수비수가 가까이 있고 볼이 발에 붙어 있으면 확률적으로 시도
        if (presser && presser.dist < 65 && attached
            && this._feintCooldown <= 0 && this._beatCooldown <= 0
            && Math.random() < 0.18) {
            this._startFeint(p, pm, presser.player);
            this._action = DRIBBLE_ACTION.FEINT;
            return this._action;
        }

        // 골문에서 멀면 폭을 벌리거나 전진 — 여기서만 측면 이동이 허용된다
        if (goalDist > o.wideMinDistance && Math.random() < 0.3) {
            const side = p.y < o.centerY ? -1 : 1;
            const tx = clamp(p.x + dir * rand(60, 110), o.fieldMinX, o.fieldMaxX);
            const ty = clamp(p.y + side * rand(50, 95), o.yMin + 25, o.yMax - 25);
            this._moveLimited(p, pm, tx, ty, SPEEDS[3], attached);
            this._action = DRIBBLE_ACTION.WIDE;
            return this._action;
        }

        // 기본: 빈 공간으로 전진하며 골문 쪽으로 수렴
        const fwd = rand(90, 150);
        const tx = clamp(p.x + dir * fwd, o.fieldMinX, o.fieldMaxX);
        const pull = goalDist < 420 ? 0.28 : 0.12; // 골문에 가까울수록 중앙으로 수렴
        const ty = clamp(p.y + (o.centerY - p.y) * pull + rand(-30, 30),
            o.yMin + 25, o.yMax - 25);
        this._moveLimited(p, pm, tx, ty, SPEEDS[4], attached);
        this._action = DRIBBLE_ACTION.CARRY;
        return this._action;
    }

    /* ── private ─────────────────────────────────── */

    /** 골문으로 곧장 — 각도가 남아 있는 쪽 포스트를 노리며 파고든다 */
    _driveAtGoal(p, pm, gx, attached) {
        const o = this.o;
        const dir = this.dir;
        const tx = clamp(gx - dir * 45, o.fieldMinX, o.fieldMaxX);
        // 중앙으로 수렴하되 살짝 흔들어 직선적이지 않게
        const ty = clamp(o.centerY + (p.y - o.centerY) * 0.3 + rand(-18, 18),
            o.goalTopSafe ?? o.yMin + 25, o.yMax - 25);
        this._moveLimited(p, pm, tx, ty, SPEEDS[4], attached);
    }

    /** 수비수를 벗기는 1단계 — 수비수가 열어둔 쪽으로 각을 틀어 치고 나간다 */
    _startBeat(p, pm, blocker, gx) {
        const o = this.o;
        const dir = this.dir;
        // 수비수 반대쪽으로 벌린다. 필드 밖으로 몰리면 반대로 튼다.
        let sign = (blocker.y - p.y) > 0 ? -1 : 1;
        const wouldExit = p.y + sign * o.beatLateral;
        if (wouldExit < o.yMin + 40 || wouldExit > o.yMax - 40) sign = -sign;

        const tx = clamp(p.x + dir * rand(45, 80), o.fieldMinX, o.fieldMaxX);
        const ty = clamp(p.y + sign * o.beatLateral, o.yMin + 25, o.yMax - 25);

        pm.clearFacingTarget();
        pm.speed = SPEEDS[4];
        pm.moveTo(tx, ty);
        this._beatPhase = { sign, stage: 0, timer: 0.55 };
    }

    /**
     * 회전각을 제한해 이동한다.
     * 볼이 발에서 떨어져 있으면(킥 사이클 중) 급격한 방향 전환을 막는다.
     */
    _moveLimited(p, pm, tx, ty, speed, attached) {
        const o = this.o;
        let gx2 = tx, gy2 = ty;
        const want = angleTo(p.x, p.y, tx, ty);
        const diff = angleDiff(want, p.angle);
        const limit = attached ? o.turnLimit : 45;
        if (Math.abs(diff) > limit) {
            // 허용 각도 안으로 목표를 당겨온다 — 몸이 따라올 수 있는 곡선을 그린다
            const capped = p.angle + Math.sign(diff) * limit;
            const rad = capped * Math.PI / 180;
            const dist = Math.hypot(tx - p.x, ty - p.y);
            gx2 = clamp(p.x - Math.sin(rad) * dist, o.fieldMinX, o.fieldMaxX);
            gy2 = clamp(p.y + Math.cos(rad) * dist, o.yMin + 20, o.yMax - 20);
        }
        pm.clearFacingTarget();
        pm.speed = speed;
        pm.moveTo(gx2, gy2);
    }

    /** 진행 방향 정면을 막고 있는 가장 가까운 수비수 */
    _findBlocker(p, defenders, gx, dir) {
        const o = this.o;
        const toGoal = angleTo(p.x, p.y, gx, o.centerY);
        let best = null, bestD = Infinity;
        for (const d of defenders) {
            const dist = Math.hypot(d.x - p.x, d.y - p.y);
            if (dist > o.engageRadius || dist < 12) continue;
            // 골문 방향 기준 콘 안에 있어야 "앞을 막은" 것이다
            const toDef = angleTo(p.x, p.y, d.x, d.y);
            if (Math.abs(angleDiff(toDef, toGoal)) > o.blockCone) continue;
            // 뒤에 있는 수비수는 대상이 아니다
            if ((d.x - p.x) * dir < -8) continue;
            if (dist < bestD) { bestD = dist; best = d; }
        }
        return best;
    }

    _nearest(p, defenders) {
        let best = null, bestD = Infinity;
        for (const d of defenders) {
            const dist = Math.hypot(d.x - p.x, d.y - p.y);
            if (dist < bestD) { bestD = dist; best = d; }
        }
        return best ? { player: best, dist: bestD } : null;
    }

    /** 페인트 시작 — FeintFoundation이 매개변수를 생성한다 */
    _startFeint(p, pm, defender) {
        const o = this.o;
        const params = FeintFoundation.auto(p, defender, { centerY: o.centerY });

        // 가짜 방향으로 짧은 이동
        const fakeRad = params.fakeAngle * Math.PI / 180;
        const fakeDist = 12 + Math.random() * 8;
        const tx = clamp(p.x + (-Math.sin(fakeRad)) * fakeDist, o.fieldMinX, o.fieldMaxX);
        const ty = clamp(p.y + Math.cos(fakeRad) * fakeDist, o.yMin + 20, o.yMax - 20);

        pm.clearFacingTarget();
        pm.speed = params.fakeSpeed;
        pm.moveTo(tx, ty);

        this._feintPhase = {
            stage: 0,
            timer: params.fakeDuration,
            goAngle: params.goAngle,
            goSpeed: params.goSpeed,
            goDuration: params.goDuration,
        };
    }
}
