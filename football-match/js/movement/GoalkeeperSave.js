/**
 * GoalkeeperSave - 골키퍼 세이브 판정 모듈
 *
 * 슈팅 궤적을 분석하여 골키퍼가 세이브할 수 있는지 판단한다.
 * 단순히 공과 골키퍼의 거리만 사용하지 않고, 공이 골라인에 도달하는 시간과
 * 골키퍼가 예측 지점까지 도달하는 시간을 비교한다.
 *
 * 세이브 결과:
 * - catch: 공을 잡음 (골키퍼가 완전히 제어)
 * - parry: 공을 쳐냄 (골대 방향이나 필드로 튕김)
 * - deflection: 공의 방향을 약간 변경 (골대 맞거나 방향 바뀜)
 * - miss: 세이브 실패 (공이 골키퍼를 벗어남)
 * - goal: 골 허용
 */

import { Ball } from '../entities/Ball.js';

const FIELD_HEIGHT = 680;
const GOAL_X = 1050;
const GOAL_TOP_Y = 303.4;
const GOAL_BOTTOM_Y = 376.6;
const CROSSBAR_HEIGHT = 2.44;
const HEIGHT_SCALE = 3;

// 골키퍼 기본 능력치 — 다이빙 과대 방지 위해 축소
const DEFAULT_REACTION_TIME = 0.13; // 반응 지연 (초)
const DEFAULT_DIVE_SPEED = 380; // 다이브 속도 (SVG 단위/초)
const DEFAULT_REACH_RADIUS = 28; // 골키퍼 도달 반경 (SVG 단위)
const DEFAULT_CATCH_RADIUS = 14; // 잡을 수 있는 반경 (SVG 단위)

// 세이브 결과 상수
export const SAVE_RESULT = {
    CATCH: 'catch',
    PARRY: 'parry',
    DEFLECTION: 'deflection',
    MISS: 'miss',
    GOAL: 'goal',
};

export class GoalkeeperSave {
    /**
     * @param {object} options
     * @param {number} options.goalX 골라인 X 좌표 (기본값: 1050)
     * @param {number} options.goalTopY 골대 위쪽 Y 좌표 (기본값: 303.4)
     * @param {number} options.goalBottomY 골대 아래쪽 Y 좌표 (기본값: 376.6)
     * @param {number} options.reactionTime 반응 지연 시간 (초, 기본값: 0.15)
     * @param {number} options.diveSpeed 다이브 속도 (SVG 단위/초, 기본값: 400)
     * @param {number} options.reachRadius 도달 반경 (SVG 단위, 기본값: 25)
     * @param {number} options.catchRadius 잡을 수 있는 반경 (SVG 단위, 기본값: 15)
     * @param {number} options.skill 골키퍼 스킬 레벨 (0~1, 기본값: 0.7)
     */
    constructor(options = {}) {
        this.goalX = options.goalX ?? GOAL_X;
        this.goalTopY = options.goalTopY ?? GOAL_TOP_Y;
        this.goalBottomY = options.goalBottomY ?? GOAL_BOTTOM_Y;
        this.reactionTime = options.reactionTime ?? DEFAULT_REACTION_TIME;
        this.diveSpeed = options.diveSpeed ?? DEFAULT_DIVE_SPEED;
        this.reachRadius = options.reachRadius ?? DEFAULT_REACH_RADIUS;
        this.catchRadius = options.catchRadius ?? DEFAULT_CATCH_RADIUS;
        this.skill = options.skill ?? 0.7;
    }

    /**
     * 슈팅 궤적을 분석하여 골키퍼가 세이브할 수 있는지 판단한다.
     *
     * @param {object} shotTrajectory 슈팅 궤적 정보
     * @param {number} shotTrajectory.startX 공 시작 X
     * @param {number} shotTrajectory.startY 공 시작 Y
     * @param {number} shotTrajectory.targetX 공 목표 X (골라인)
     * @param {number} shotTrajectory.targetY 공 목표 Y
     * @param {number} shotTrajectory.speed 공 속도 (SVG 단위/초)
     * @param {number} shotTrajectory.startHeight 시작 높이 (m)
     * @param {number} shotTrajectory.targetHeight 목표 높이 (m)
     * @param {number} shotTrajectory.arcHeight 포물선 높이 (m)
     *
     * @param {object} goalkeeper 골키퍼 정보
     * @param {number} goalkeeper.x 골키퍼 X 좌표
     * @param {number} goalkeeper.y 골키퍼 Y 좌표
     *
     * @returns {object} 세이브 결과
     * @returns {string} result 세이브 결과 (catch, parry, deflection, miss, goal)
     * @returns {number} savePointX 세이브 지점 X
     * @returns {number} savePointY 세이브 지점 Y
     * @returns {number} timeToGoal 공이 골라인에 도달하는 시간 (초)
     * @returns {number} timeToSave 골키퍼가 세이브 지점에 도달하는 시간 (초)
     * @returns {boolean} canSave 세이브 가능 여부
     */
    evaluateSave(shotTrajectory, goalkeeper) {
        // 1. 공이 골라인에 도달하는 시간 T 계산
        const distanceX = Math.abs(shotTrajectory.targetX - shotTrajectory.startX);
        const timeToGoal = distanceX / shotTrajectory.speed;

        // 2. 골키퍼가 도달할 수 있는 세이브 지점 계산
        const savePoint = this._calculateSavePoint(shotTrajectory, goalkeeper, timeToGoal);

        // 3. 골키퍼가 세이브 지점까지 도달하는 데 필요한 시간 계산
        const distanceToSave = Math.hypot(
            savePoint.x - goalkeeper.x,
            savePoint.y - goalkeeper.y
        );
        const timeToSave = this.reactionTime + (distanceToSave / this.diveSpeed);

        // 4. 세이브 가능 여부 판단
        // 골키퍼가 공이 골라인에 도달하기 전에 세이브 지점에 도달할 수 있어야 함
        const reactionMargin = 0.05; // 추가 여유 시간
        const canSave = timeToSave <= timeToGoal + reactionMargin;

        // 5. 세이브 결과 결정
        const result = this._determineSaveResult(shotTrajectory, savePoint, canSave, goalkeeper);

        return {
            result,
            savePointX: savePoint.x,
            savePointY: savePoint.y,
            timeToGoal,
            timeToSave,
            canSave,
        };
    }

    /**
     * 골키퍼가 도달할 수 있는 세이브 지점을 계산한다.
     * 공의 궤적과 골키퍼의 위치를 고려하여 최적의 세이브 지점을 찾는다.
     */
    _calculateSavePoint(shotTrajectory, goalkeeper, timeToGoal) {
        // 골키퍼가 시간 내에 도달할 수 있는 최대 거리
        const maxReachDistance = (timeToGoal - this.reactionTime) * this.diveSpeed;

        // 공의 궤적에서 골키퍼가 가장 가까이 도달할 수 있는 지점 찾기
        // 공의 진행 방향을 따라 여러 샘플 포인트를 확인
        const samples = 20;
        let bestPoint = null;
        let bestScore = -Infinity;

        for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            const pointX = shotTrajectory.startX + (shotTrajectory.targetX - shotTrajectory.startX) * t;
            const pointY = shotTrajectory.startY + (shotTrajectory.targetY - shotTrajectory.startY) * t;

            // 골키퍼에서 이 지점까지의 거리
            const distance = Math.hypot(pointX - goalkeeper.x, pointY - goalkeeper.y);

            // 골키퍼가 이 지점에 도달할 수 있는지 확인
            if (distance <= maxReachDistance) {
                // 세이브 점수 계산: 골대에 가까울수록, 골키퍼에서 가까울수록 높음
                const goalProximity = 1 - Math.abs(pointX - this.goalX) / 200;
                const keeperProximity = 1 - distance / maxReachDistance;
                const score = goalProximity * 0.6 + keeperProximity * 0.4;

                if (score > bestScore) {
                    bestScore = score;
                    bestPoint = { x: pointX, y: pointY };
                }
            }
        }

        // 도달할 수 있는 지점이 없으면 골키퍼 위치 반환
        return bestPoint ?? { x: goalkeeper.x, y: goalkeeper.y };
    }

    /**
     * 세이브 결과를 결정한다.
     * 골키퍼의 도달 여부, 공의 높이, 골키퍼 스킬 등을 고려한다.
     */
    _determineSaveResult(shotTrajectory, savePoint, canSave, goalkeeper) {
        // 공이 골라인에 도달할 때의 높이 계산
        const progress = Math.abs(savePoint.x - shotTrajectory.startX) /
                        Math.abs(shotTrajectory.targetX - shotTrajectory.startX);
        const height = shotTrajectory.startHeight
            + (shotTrajectory.targetHeight - shotTrajectory.startHeight) * progress
            + 4 * shotTrajectory.arcHeight * progress * (1 - progress);

        // 골키퍼에서 세이브 지점까지의 거리
        const distance = Math.hypot(savePoint.x - goalkeeper.x, savePoint.y - goalkeeper.y);

        if (!canSave) {
            // 세이브 불가능: 골 허용
            return SAVE_RESULT.GOAL;
        }

        // 세이브 가능할 때: 결과 결정 — 도달했으면 대부분 선방, 실패율 축소
        // 1. 공을 잡을 수 있는지 (catchRadius 이내)
        if (distance <= this.catchRadius) {
            const catchChance = 0.58 + this.skill * 0.36; // 0.62→0.80, 0.76→0.85
            if (Math.random() < catchChance) {
                return SAVE_RESULT.CATCH;
            }
            // 잡기 실패해도 쳐내기로 폴백 (즉시 GOAL로 가지 않음)
        }

        // 2. 공을 쳐낼 수 있는지 (reachRadius 이내)
        if (distance <= this.reachRadius) {
            const heightPenalty = height > 1.6 ? 0.22 : height > 1.05 ? 0.10 : 0;
            const parryChance = 0.72 + this.skill * 0.22 - heightPenalty; // 기본 상향
            // 극근접(리치의 65% 이내)은 거의 확정 선방
            const nearGuarantee = distance <= this.reachRadius * 0.65;
            if (nearGuarantee || Math.random() < parryChance) {
                const distanceToPost = Math.min(
                    Math.abs(savePoint.y - this.goalTopY),
                    Math.abs(savePoint.y - this.goalBottomY)
                );
                if (distanceToPost < 18 && Math.random() < 0.38) {
                    return SAVE_RESULT.DEFLECTION;
                }
                return SAVE_RESULT.PARRY;
            }
        }

        // 3. 리치 바깥 근접(리치+4)에서도 낮은 확률로 기적 선방 — 얼음 방지
        if (distance <= this.reachRadius + 4 && Math.random() < 0.18 + this.skill * 0.12) {
            return SAVE_RESULT.PARRY;
        }

        // 4. 세이브 실패: 골 허용
        return SAVE_RESULT.GOAL;
    }

    /**
     * 세이브 결과를 기반으로 공의 새로운 궤적을 계산한다.
     * parry 또는 deflection 결과일 때 사용한다.
     *
     * @param {string} result 세이브 결과 (parry 또는 deflection)
     * @param {object} savePoint 세이브 지점
     * @param {object} shotTrajectory 원래 슈팅 궤적
     * @returns {object} 새로운 공의 속도 (vx, vy)
     */
    calculateDeflection(result, savePoint, shotTrajectory) {
        const speed = shotTrajectory.speed;

        if (result === SAVE_RESULT.DEFLECTION) {
            // 골대 쪽으로 튕김 → 위쪽·아래쪽 골대 포스트 방향으로 세게 보냄
            const distanceToTopPost = Math.abs(savePoint.y - this.goalTopY);
            const distanceToBottomPost = Math.abs(savePoint.y - this.goalBottomY);

            if (distanceToTopPost < distanceToBottomPost) {
                // 위쪽 골대 방향으로 튕김
                return {
                    vx: -speed * 0.4,
                    vy: -speed * 0.7,
                };
            } else {
                // 아래쪽 골대 방향으로 튕김
                return {
                    vx: -speed * 0.4,
                    vy: speed * 0.7,
                };
            }
        }

        if (result === SAVE_RESULT.PARRY) {
            // 바깥쪽(위·아래) 또는 위로 쳐냄 — 필드 안쪽으로 돌아오지 않도록
            const roll = Math.random();
            if (roll < 0.5) {
                // 위쪽으로 쳐냄 (크로스바 위 방향)
                const spread = (Math.random() - 0.5) * 0.4;
                return {
                    vx: -speed * 0.35,
                    vy: -speed * (0.5 + Math.random() * 0.3),
                };
            } else if (roll < 0.8) {
                // 바깥쪽(위쪽 포스트 방향)으로 쳐냄
                return {
                    vx: -speed * 0.5,
                    vy: -speed * (0.4 + Math.random() * 0.3),
                };
            } else {
                // 바깥쪽(아래쪽 포스트 방향)으로 쳐냄
                return {
                    vx: -speed * 0.5,
                    vy: speed * (0.4 + Math.random() * 0.3),
                };
            }
        }

        return { vx: 0, vy: 0 };
    }

    /**
     * 골키퍼가 세이브 지점에 도달했을 때 세이브 유형을 결정한다.
     * evaluateSave()와 달리 골키퍼의 현재 위치를 기반으로 판단한다.
     *
     * @param {object} shotTrajectory 슈팅 궤적 정보
     * @param {object} goalkeeperPos 골키퍼 현재 위치 { x, y }
     * @param {object} savePoint 세이브 지점 { x, y }
     * @returns {string} 세이브 유형 (catch, parry, deflection, goal)
     */
    determineSaveType(shotTrajectory, goalkeeperPos, savePoint) {
        const distance = Math.hypot(savePoint.x - goalkeeperPos.x, savePoint.y - goalkeeperPos.y);

        // 공이 세이브 지점에 도달할 때의 높이 계산
        const progress = Math.abs(savePoint.x - shotTrajectory.startX) /
                        Math.abs(shotTrajectory.targetX - shotTrajectory.startX);
        const height = shotTrajectory.startHeight
            + (shotTrajectory.targetHeight - shotTrajectory.startHeight) * progress
            + 4 * shotTrajectory.arcHeight * progress * (1 - progress);

        // 골키퍼가 잡을 수 있는 반경 이내
        if (distance <= this.catchRadius) {
            const catchChance = 0.5 + this.skill * 0.4;
            if (Math.random() < catchChance) {
                return SAVE_RESULT.CATCH;
            }
        }

        // 골키퍼가 쳐낼 수 있는 반경 이내
        if (distance <= this.reachRadius) {
            const heightPenalty = height > 1.5 ? 0.3 : height > 1.0 ? 0.15 : 0;
            const parryChance = 0.6 + this.skill * 0.3 - heightPenalty;

            if (Math.random() < parryChance) {
                const distToPost = Math.min(
                    Math.abs(savePoint.y - this.goalTopY),
                    Math.abs(savePoint.y - this.goalBottomY)
                );
                if (distToPost < 20 && Math.random() < 0.4) {
                    return SAVE_RESULT.DEFLECTION;
                }
                return SAVE_RESULT.PARRY;
            }
        }

        return SAVE_RESULT.GOAL;
    }
}
