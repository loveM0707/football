/**
 * HeadingExecution - 헤딩 방향·힘 결정 공통 모듈
 *
 * 5. 헤딩 패스 · 6. 헤딩 슛 · 7. 수비 헤딩 · 9. 크로스 헤딩의
 * "접촉 후 어디로·얼마나 세게"를 전담한다.
 * (Decision + Execution — 실제 킥은 BallMovement.releaseAerial로 수행)
 *
 * 재사용 규칙:
 * - 슛은 기존 HeadingShot 모듈에 위임한다 (중복 구현 금지)
 * - 패스·클리어·수비 헤딩은 incoming 속도·높이·스킬 기반 순수 계산이다
 * - 크로스 헤딩은 슛 실행과 동일하되, 크로스 특유의 높이 보정을 얹는다
 * - HeadingPass 시나리오의 인라인 파워 계산을 이 모듈로 통합한다
 */
import { HeadingShot } from './HeadingShot.js';

export const HEADING_TYPE = Object.freeze({
    PASS: 'pass',       // 5. 헤딩 패스 — 동료에게 연결
    SHOT: 'shot',       // 6. 헤딩 슛 — 골문으로
    CLEAR: 'clear',     // 7. 수비 헤딩 — 위험 지역에서 멀리
    CROSS_HEAD: 'cross-head', // 9. 크로스에 대한 헤딩 (슛 파생)
});

const DEFAULTS = {
    passPower: 170,         // 헤딩 패스 기본 파워
    passPowerVar: 40,
    passHeight: 0.45,       // 패스 높이 (0~1)
    passHeightVar: 0.25,
    passDeviationDeg: 6,    // 패스 편차 (±도)
    clearPowerMin: 260,     // 클리어 최소 파워
    clearPowerMax: 380,
    clearHeight: 0.7,
    clearHeightVar: 0.2,
    headerSkill: 0.5,
};

function rand(a, b) { return a + Math.random() * (b - a); }

export class HeadingExecution {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
        this._shot = new HeadingShot(options.shot ?? {});
    }

    /**
     * 헤딩을 실행한다 (볼에 속도를 부여하지 않고 계획만 만든다).
     * @param {object} header 헤딩 선수 { x, y }
     * @param {object} ball 공 { x, y, height }
     * @param {object} options
     *   type {string} HEADING_TYPE (기본 pass)
     *   targetX/Y {number} 패스·클리어 목표 (없으면 방향 기본값)
     *   goalX {number} 슛 골라인
     *   incomingSpeed/Height {number} 들어오는 볼 조건
     *   headerSkill {number} 0~1
     * @returns {{ vx, vy, flightDuration, maxHeight, kind, detail }}
     */
    plan(header, ball, options = {}) {
        const type = options.type ?? HEADING_TYPE.PASS;
        if (type === HEADING_TYPE.SHOT || type === HEADING_TYPE.CROSS_HEAD) {
            return this._planShot(header, ball, options);
        }
        if (type === HEADING_TYPE.CLEAR) {
            return this._planClear(header, ball, options);
        }
        return this._planPass(header, ball, options);
    }

    /**
     * 계획을 볼에 적용한다 (공통 적용점 — 순간이동 없이 releaseAerial만).
     * @param {BallMovement} bm
     * @param {object} plan plan() 반환값
     * @returns {{ flightDuration }}
     */
    apply(bm, plan) {
        return bm.releaseAerial(plan.vx, plan.vy, plan.flightDuration, plan.maxHeight, null, {
            duration: 0.38, maxHeight: 0.26, velocityScale: 0.5,
        });
    }

    /* ── private ─────────────────────────────────── */

    /** 5. 헤딩 패스 — 목표에게 부드럽게 연결한다 */
    _planPass(header, ball, options) {
        const o = this.o;
        const tx = options.targetX ?? header.x + 200;
        const ty = options.targetY ?? header.y;
        const skill = options.headerSkill ?? o.headerSkill;
        const incoming = options.incomingSpeed ?? 200;

        // 파워: 들어오는 볼이 빠르면 살짝 얹고, 느리면 밀어준다
        const base = o.passPower + rand(-o.passPowerVar, o.passPowerVar);
        const power = base * (0.9 + Math.min(0.25, incoming / 1200)) * (0.9 + skill * 0.2);

        // 편차: 스킬이 높을수록 정확
        const devDeg = o.passDeviationDeg * (1.3 - skill * 0.6);
        const devRad = (Math.random() - 0.5) * 2 * devDeg * Math.PI / 180;
        const dx = tx - ball.x, dy = ty - ball.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const ang = Math.atan2(dy, dx) + devRad;

        const vx = Math.cos(ang) * power;
        const vy = Math.sin(ang) * power;
        const flightDuration = dist / power;
        const maxHeight = Math.max(0.15,
            o.passHeight + rand(-o.passHeightVar, o.passHeightVar) * (1 - skill * 0.4));

        return { vx, vy, flightDuration, maxHeight, kind: HEADING_TYPE.PASS, detail: { power, devDeg } };
    }

    /** 6·9. 헤딩 슛 / 크로스 헤딩 — HeadingShot에 위임한다 */
    _planShot(header, ball, options) {
        const sr = this._shot.execute(header, ball, {
            goalX: options.goalX,
            targetY: options.targetY,
            incomingSpeed: options.incomingSpeed ?? 200,
            incomingHeight: options.incomingHeight ?? ball.height ?? 0.5,
            headerSkill: options.headerSkill ?? this.o.headerSkill,
        });
        // 크로스 헤딩은 높은 볼을 낮게 누르는 보정 (탑볼 방지)
        let maxHeight = sr.maxHeight;
        if (options.type === HEADING_TYPE.CROSS_HEAD) {
            maxHeight = Math.min(maxHeight, 0.45);
        }
        return {
            vx: sr.vx, vy: sr.vy,
            flightDuration: sr.flightDuration,
            maxHeight,
            kind: options.type,
            detail: sr,
        };
    }

    /** 7. 수비 헤딩 — 측면·원거리로 강하게 걷어낸다 */
    _planClear(header, ball, options) {
        const o = this.o;
        const dir = options.clearDir ?? 1; // +1 = 오른쪽으로 걷어냄
        const tx = options.targetX ?? header.x + dir * rand(220, 330);
        const ty = options.targetY ?? header.y + rand(-110, 110);
        const power = rand(o.clearPowerMin, o.clearPowerMax);

        const dx = tx - ball.x, dy = ty - ball.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const ang = Math.atan2(dy, dx);
        const vx = Math.cos(ang) * power;
        const vy = Math.sin(ang) * power;
        const flightDuration = rand(0.65, 0.9);
        const maxHeight = o.clearHeight + rand(0, o.clearHeightVar);

        return { vx, vy, flightDuration, maxHeight, kind: HEADING_TYPE.CLEAR, detail: { power } };
    }
}
