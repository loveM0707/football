/**
 * AngleInertia - 방향전환 관성/원심력 공통 모듈
 *
 * 모든 선수(메뉴/실경기)의 부드러운 회전을 단일 physics로 통일.
 * 스프링-댐퍼 모델: torque = diff*STIFFNESS, damp = vel*DAMPING, accel = (torque-damp)/INERTIA
 * 원심력: |각속도|*속도 비례 측면 드리프트 — 급회전 시 바깥쪽으로 호를 그림.
 *
 * 사용법 (시나리오 다중 선수):
 *   import { InertiaController } from '../movement/AngleInertia.js';
 *   const turn = new InertiaController(PLAYERS_COUNT); // or new InertiaController(1) for single
 *   turn.setTarget(idx, angle);
 *   turn.update(dt, players); // players[i].angle/position 갱신, vel 내부 보관
 *
 * 사용법 (단일 선수 - PlayerMovement 내부):
 *   import { stepAngle } from '../movement/AngleInertia.js';
 *   const { vel, rot } = stepAngle(current, target, vel, dt, opts);
 */

export const STIFFNESS = 14;
export const DAMPING   = 8;
export const MAX_VEL   = 420;
export const DRIFT_COEFF = 0.00035; // 시나리오 idle/패수 회전용
export const DRIFT_SCALE = 18;      // 드리프트 증폭

// PlayerMovement 전용 상수 — 드리블에선 더 단단하게(빠른 수렴)해 볼 뒤처짐 방지
export const PM_STIFFNESS = 32;
export const PM_DAMPING   = 14;
export const PM_MAX_VEL   = 560;
export const PM_DRIFT_SCALE = 0.00002; // 드리블 중 측면 쏠림 최소화 (기존 0.00045 → 1/22, 고속 150·200deg/s 시 0.6px/frame)

function angleDiff(target, current) {
    let d = target - current;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
}

/**
 * 단일 각도 스텝 — 관성 적용 후 회전량과 갱신된 속도를 반환
 * @returns {{ vel: number, rot: number, clamped: number }}
 */
export function stepAngle(current, target, vel, dt, opts = {}) {
    const stiffness = opts.stiffness ?? STIFFNESS;
    const damping   = opts.damping   ?? DAMPING;
    const maxVel    = opts.maxVel    ?? MAX_VEL;
    const diff = angleDiff(target, current);
    const torque = diff * stiffness;
    const damp = vel * damping;
    let nVel = vel + (torque - damp) * dt;
    if (nVel > maxVel) nVel = maxVel;
    if (nVel < -maxVel) nVel = -maxVel;
    if (Math.sign(diff) !== Math.sign(nVel) && Math.abs(diff) < 10) nVel *= 0.55;
    let rot = nVel * dt;
    if (Math.abs(rot) > Math.abs(diff)) { rot = diff; nVel *= 0.3; }
    return { vel: nVel, rot, diff };
}

/**
 * 다중 선수 관성 컨트롤러 — FourPlayerPass* 등에서 공통 사용
 */
export class InertiaController {
    constructor(count, opts = {}) {
        this.n = count;
        this.targets = new Array(count).fill(0);
        this.vels = new Array(count).fill(0);
        this.stiffness = opts.stiffness ?? STIFFNESS;
        this.damping   = opts.damping   ?? DAMPING;
        this.maxVel    = opts.maxVel    ?? MAX_VEL;
        this.driftCoeff = opts.driftCoeff ?? DRIFT_COEFF;
        this.driftScale = opts.driftScale ?? DRIFT_SCALE;
    }

    setTarget(idx, angle) { this.targets[idx] = angle; }
    setTargetsFrom(players) { for (let i=0;i<this.n;i++) this.targets[i]=players[i].angle; }

    /** 매 프레임 호출 — players[i] angle/position을 관성 있게 갱신 */
    update(dt, players) {
        for (let i=0;i<this.n;i++) {
            const cur = players[i].angle;
            const tgt = this.targets[i];
            const res = stepAngle(cur, tgt, this.vels[i], dt, {
                stiffness: this.stiffness,
                damping: this.damping,
                maxVel: this.maxVel,
            });
            this.vels[i] = res.vel;
            if (Math.abs(res.rot) > 0.01) players[i].setAngle(cur + res.rot);
            // 원심력 드리프트
            const drift = Math.abs(this.vels[i]) * this.driftCoeff;
            if (drift > 0.08 && Math.abs(this.vels[i]) > 25) {
                const rad = players[i].angle * Math.PI / 180;
                const rightX = Math.cos(rad), rightY = Math.sin(rad);
                const side = this.vels[i] > 0 ? -1 : 1;
                const d = drift * dt * this.driftScale;
                players[i].setPosition(players[i].x + rightX*side*d, players[i].y + rightY*side*d);
            }
        }
    }

    reset(idx, angle, vel=0) {
        if (idx !== undefined) { this.targets[idx]=angle; this.vels[idx]=vel; }
        else { this.targets.fill(angle); this.vels.fill(vel); }
    }
}
