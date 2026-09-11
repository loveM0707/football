/**
 * AngleInertia - 방향전환 관성/원심력 공통 모듈
 *
 * 모든 선수의 부드러운 회전을 단일 physics로 통일.
 * 스프링-댐퍼 모델: torque = diff*STIFFNESS, damp = vel*DAMPING, accel = (torque-damp)/INERTIA
 * 원심력: |각속도|*속도 비례 측면 드리프트 — 급회전 시 바깥쪽으로 호를 그림.
 *
 * 사용법:
 *   PlayerMovement가 stepAngle()을 호출해 선수의 실제 회전을 계산한다.
 *   시나리오는 PlayerMovement.setFacingTarget()으로 원하는 방향만 요청한다.
 */
import { angleDiff } from './Direction.js';

export const STIFFNESS = 14;
export const DAMPING   = 8;
export const MAX_VEL   = 420;
export const DRIFT_COEFF = 0.00035; // 시나리오 idle/패수 회전용
export const DRIFT_SCALE = 18;      // 드리프트 증폭

// PlayerMovement 전용 상수 — 관성감 있는 자연스러운 방향전환
export const PM_STIFFNESS = 170;
export const PM_DAMPING   = 26;
export const PM_MAX_VEL   = 850;
export const PM_DRIFT_SCALE = 0.00002; // 드리블 중 측면 쏠림 최소화

/**
 * 단일 각도 스텝 — 관성 적용 후 회전량과 갱신된 속도를 반환
 * @returns {{ vel: number, rot: number, diff: number }}
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
