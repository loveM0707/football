/**
 * DribbleBehaviors - 재사용 가능한 드리블 행동 프리미티브
 *
 * 모든 메서드는 정적이며 pm(PlayerMovement), dc(DribbleController)를
 * 직접 받아 즉시 실행한다. 상태 관리 없음 — 호출 순서는 상위 레이어가 결정.
 *
 * 사용처:
 *   시나리오, AttackerDuelAI, 또는 미래 풀 매치 엔진의 온볼 AI
 */
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

export class DribbleBehaviors {

    /**
     * 목표 지점으로 최고 속도(SPEEDS[4]) 직선 질주.
     * 모듈 공통: 드리블 시 방향 정확화를 위해 facingTarget 해제 후 이동.
     */
    static sprint(pm, dc, targetX, targetY, onArrive) {
        pm.clearFacingTarget();
        dc.setSpeed(SPEEDS[4]);
        pm.moveTo(targetX, targetY, onArrive);
    }

    /**
     * 목표 지점으로 최고 속도 질주.
     * Y 편차가 yThreshold를 넘으면 중간 경유지를 삽입해 부드럽게 수렴.
     * @param {object} player   위치 참조 ({x, y})
     */
    static sprintHomed(pm, dc, player, targetX, targetY, onArrive,
                       { yThreshold = 40, homingFactor = 0.4, yPull = 0.6 } = {}) {
        pm.clearFacingTarget();
        dc.setSpeed(SPEEDS[4]);
        if (Math.abs(player.y - targetY) > yThreshold) {
            const midX = player.x + (targetX - player.x) * homingFactor;
            const midY = player.y + (targetY - player.y) * yPull;
            pm.moveTo(midX, midY, () => {
                pm.clearFacingTarget();
                pm.moveTo(targetX, targetY, onArrive);
            });
        } else {
            pm.moveTo(targetX, targetY, onArrive);
        }
    }

    /**
     * 측면 돌파: sign 방향으로 lateralDist, 전방으로 forwardDist 만큼 치고 달리기.
     * @param {object} player   위치 참조 ({x, y})
     * @param {number} sign     -1 = 위(낮은 y), +1 = 아래(높은 y)
     * @param {object} options  { forwardDist, lateralDist, maxX, yMin, yMax }
     */
    static lateralBurst(pm, dc, player, sign, onArrive,
                        { forwardDist = 180, lateralDist = 100,
                          maxX = Infinity, yMin = 45, yMax = 635 } = {}) {
        pm.clearFacingTarget();
        dc.setSpeed(SPEEDS[4]);
        const bx = Math.min(player.x + forwardDist, maxX);
        const by = Math.max(yMin, Math.min(yMax, player.y + sign * lateralDist));
        pm.moveTo(bx, by, onArrive);
    }

    /**
     * 슬로우 볼키핑 한 스텝: SPEEDS[0]으로 stepDist 만큼 전진.
     * 반복 호출 패턴 — onStep 콜백에서 다시 호출하면 계속 키핑.
     * @param {object} player   위치 참조 ({x, y})
     * @param {number} maxX     이 X를 넘지 않도록 클램프
     * @param {object} [opts]   { stepDist, speed }
     */
    static slowKeepStep(pm, dc, player, maxX, onStep, { stepDist = 12, speed } = {}) {
        pm.clearFacingTarget();
        dc.setSpeed(speed ?? SPEEDS[0]);
        pm.moveTo(Math.min(player.x + stepDist, maxX), player.y, onStep);
    }
}
