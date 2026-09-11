/**
 * HeadingShot - 헤딩슛 물리·정확도 모듈
 *
 * 볼의 세기·높이에 따라 헤딩 슛의 강도와 정확도를 계산한다.
 * 다른 시나리오나 실제 경기에서 재사용할 수 있도록 모듈화되어 있다.
 *
 * 핵심 개념:
 *   -incoming ball condition: 볼의 속도와 높이가 헤딩 파워·정확도에 영향
 *   - Power: incomingSpeed에 비례하되, 너무 빠르면 제어 불가 → 파워 감소
 *   - Accuracy: incomingHeight와 incomingSpeed에 반비례
 *     - 높은 공: 머리 맞추기 어려움 → 정확도↓
 *   - 빠른 공: 반응 시간 부족 → 정확도↓
 *   - deviation: ±8~20도 범위에서 랜덤 편차 적용
 *
 * 사용법:
 *   const hs = new HeadingShot();
 *   const result = hs.execute(header, ball, {
 *       goalX: 1050,
 *       goalTopY: 303.4,
 *       goalBottomY: 376.6,
 *       incomingSpeed: 200,
 *       incomingHeight: 0.8,
 *   });
 *   // result: { vx, vy, power, deviationDeg, targetY, flightDuration, maxHeight }
 */

import {
    GOAL_X, GOAL_TOP_Y, GOAL_BOTTOM_Y, GOAL_CENTER_Y, HEIGHT_SCALE,
} from './FieldGeometry.js';

// 상수
const CENTER_Y = GOAL_CENTER_Y;

// 헤딩 슛 기본 파워 범위 — 실제 헤딩은 강한 임팩트
const BASE_POWER_MIN = 280;
const BASE_POWER_MAX = 420;

// 정확도 편차 범위 (도)
const DEVIATION_MIN = 8;   // 최소 편차 (가장 정확할 때)
const DEVIATION_MAX = 20;  // 최대 편차 (가장 부정확할 때)

export class HeadingShot {
    /**
     * @param {object} options
     * @param {number} options.goalX 골라인 X 좌표 (기본값: 1050)
     * @param {number} options.goalTopY 골대 위쪽 Y 좌표 (기본값: 303.4)
     * @param {number} options.goalBottomY 골대 아래쪽 Y 좌표 (기본값: 376.6)
     * @param {number} options.basePowerMin 기본 파워 최소값 (기본값: 140)
     * @param {number} options.basePowerMax 기본 파워 최대값 (기본값: 200)
     * @param {number} options.deviationMin 정확도 편차 최소값 (도, 기본값: 8)
     * @param {number} options.deviationMax 정확도 편차 최대값 (도, 기본값: 20)
     */
    constructor(options = {}) {
        this._goalX = options.goalX ?? GOAL_X;
        this._goalTopY = options.goalTopY ?? GOAL_TOP_Y;
        this._goalBottomY = options.goalBottomY ?? GOAL_BOTTOM_Y;
        this._centerY = (this._goalTopY + this._goalBottomY) / 2;
        this._basePowerMin = options.basePowerMin ?? BASE_POWER_MIN;
        this._basePowerMax = options.basePowerMax ?? BASE_POWER_MAX;
        this._deviationMin = options.deviationMin ?? DEVIATION_MIN;
        this._deviationMax = options.deviationMax ?? DEVIATION_MAX;
    }

    /**
     * 헤딩 슛을 실행하여 공의 속도를 계산한다.
     *
     * ShotExecution.plan()과 같은 Intent→Execution 구조다 (헤딩 물리라 별도 모듈):
     *   의도      baseTargetY (골문 안 또는 지정 지점)
     *   실행 오차  deviationDeg (높이·속도·거리·숙련도 기반) → finalTargetY
     *   힘        power (incoming 속도·숙련도 기반)
     *
     * 반환 규격 매핑 (ShotExecution.plan 대응):
     *   targetY=의도 ↔ targetY, finalTargetY=최종 ↔ targetY,
     *   power ↔ speed, maxHeight ↔ targetHeight/arcHeight 재료
     *
     * @param {object} header 헤딩하는 선수 { x, y }
     * @param {object} ball 공 { x, y, height }
     * @param {object} options
     * @param {number} options.goalX 목표 골라인 X (기본값: 1050)
     * @param {number} options.targetY 목표 Y 좌표 (골문 내, 랜덤 if 미지정)
     * @param {number} options.incomingSpeed 공이 오는 속도 (SVG/s)
     * @param {number} options.incomingHeight 공이 오는 높이 (0~1 스케일)
     * @param {number} options.headerSkill 헤딩 스킬 (0~1, 기본값: 0.5)
     * @returns {{ vx, vy, power, deviationDeg, targetY, flightDuration, maxHeight }}
     */
    execute(header, ball, options = {}) {
        const incomingSpeed = options.incomingSpeed ?? 200;
        const incomingHeight = options.incomingHeight ?? 0.5;
        const headerSkill = options.headerSkill ?? 0.5;
        const goalX = options.goalX ?? this._goalX;

        // 거리 계산: 골에서 멀수록 파워↓ 정확도↓
        const distToGoal = Math.hypot(goalX - header.x, this._centerY - header.y);
        const distanceFactor = Math.max(0.5, 1 - distToGoal / 250);

        // ── 실행: 힘 ──
        // 1. 파워 계산: incomingSpeed + 거리 보정 — 거리는 정확도에만 영향, 파워는 유지
        const power = this._calculatePower(incomingSpeed, headerSkill);

        // ── 실행: 오차 ──
        // 2. 정확도(편차) 계산: 거리가 멀수록 편차 증가
        const deviationDeg = this._calculateDeviation(
            incomingSpeed, incomingHeight, headerSkill,
        ) + (1 - distanceFactor) * 8;

        // ── 의도 ──
        // 3. 목표 Y 좌표 결정: 골문 내에서 랜덤 + 편차 적용
        const baseTargetY = options.targetY ?? this._randomGoalTarget();
        const targetY = this._applyDeviationToTarget(
            baseTargetY, header.y, deviationDeg, header.x,
        );

        // 4. 방향 계산
        const dx = goalX - header.x;
        const dy = targetY - header.y;
        const dist = Math.hypot(dx, dy);
        const nx = dx / dist;
        const ny = dy / dist;

        // 5. 속도 벡터
        const vx = nx * power;
        const vy = ny * power;

        // 6. 비행 시간 계산
        const flightDuration = dist / power;

        // 7. 높이 계산
        const maxHeight = this._calculateMaxHeight(incomingHeight);

        return {
            vx,
            vy,
            power,
            deviationDeg,
            targetY: baseTargetY,
            finalTargetY: targetY,
            flightDuration,
            maxHeight,
            distToGoal,
        };
    }

    /**
     * 헤딩 파워를 계산한다.
     * - 기본 파워: BASE_POWER_MIN ~ BASE_POWER_MAX
     * - incomingSpeed가 높으면 파워 증가 (최대 120%)
     * - incomingSpeed가 너무 높으면(>300) 파워 감소 (제어 불가)
     * - headerSkill이 높으면 파워 증가
     */
    _calculatePower(incomingSpeed, headerSkill) {
        // 기본 파워 (스킬에 따라 증가)
        const basePower = this._basePowerMin
            + (this._basePowerMax - this._basePowerMin) * headerSkill;

        // 속도 보정
        let speedMultiplier = 1.0;
        if (incomingSpeed < 100) {
            // 느린 공: 파워 약간 감소
            speedMultiplier = 0.85 + (incomingSpeed / 100) * 0.15;
        } else if (incomingSpeed < 250) {
            // 적당한 속도: 파워 증가
            speedMultiplier = 1.0 + ((incomingSpeed - 100) / 150) * 0.2;
        } else {
            // 빠른 공: 제어 어려움 → 파워 감소
            speedMultiplier = 1.2 - ((incomingSpeed - 250) / 250) * 0.3;
        }

        return Math.max(
            this._basePowerMin * 0.7,
            Math.min(this._basePowerMax * 1.3, basePower * speedMultiplier),
        );
    }

    /**
     * 정확도 편차를 계산한다 (도).
     * - 높은 공: 정확도↓ (편차↑)
     * - 빠른 공: 정확도↓ (편차↑)
     * - 높은 스킬: 정확도↑ (편차↓)
     */
    _calculateDeviation(incomingSpeed, incomingHeight, headerSkill) {
        // 높이에 따른 편차 증가 (0→1 범위에서 0~8도 추가)
        const heightPenalty = incomingHeight * 8;

        // 속도에 따른 편차 증가 (0~400 범위에서 0~6도 추가)
        const speedPenalty = Math.min(6, (incomingSpeed / 400) * 6);

        // 스킬에 따른 편차 감소 (0~1 범위에서 0~5도 감소)
        const skillBonus = headerSkill * 5;

        const baseDeviation = this._deviationMin
            + (this._deviationMax - this._deviationMin) * 0.5;

        const deviation = baseDeviation + heightPenalty + speedPenalty - skillBonus;

        return Math.max(this._deviationMin, Math.min(this._deviationMax, deviation));
    }

    /**
     * 골문 내에서 랜덤 목표 Y를 결정한다.
     * - 70% 확률로 골문 중앙 영역
     * - 20% 확률로 골문 양 끝 근처
     * - 10% 확률로 포스트 근처 (빗나가는 슛)
     */
    _randomGoalTarget() {
        const roll = Math.random();

        if (roll < 0.10) {
            // 포스트 근처 (빗나가는 슛)
            if (Math.random() < 0.5) {
                return this._goalTopY - 5 + Math.random() * 5;
            }
            return this._goalBottomY + Math.random() * 5;
        }

        if (roll < 0.30) {
            // 골문 양 끝 근처
            if (Math.random() < 0.5) {
                return this._goalTopY + 3 + Math.random() * 10;
            }
            return this._goalBottomY - 13 + Math.random() * 10;
        }

        // 골문 중앙 영역 (70%)
        const safeTop = this._goalTopY + 15;
        const safeBottom = this._goalBottomY - 15;
        return safeTop + Math.random() * (safeBottom - safeTop);
    }

    /**
     * 편차를 목표 Y에 적용한다.
     * 원래 목표를 기준으로 ±deviationDeg 범위에서 오프셋을 추가한다.
     */
    _applyDeviationToTarget(baseTargetY, headerY, deviationDeg, headerX = null) {
        // 헤더 위치에서 골까지의 실제 수평 거리 사용 — 고정값(750) 대신 실제 header.x 기준
        const distToGoal = headerX !== null ? Math.abs(this._goalX - headerX) : Math.abs(this._goalX - 300);

        // 편차를 라디안으로 변환
        const deviationRad = (Math.random() - 0.5) * 2 * deviationDeg * Math.PI / 180;

        // 거리에 따른 Y 오프셋 계산
        const yOffset = Math.tan(deviationRad) * distToGoal;

        return baseTargetY + yOffset;
    }

    /**
     * 최대 높이를 계산한다.
     * incomingHeight가 높으면 더 높은 포물선, 낮으면 낮게.
     */
    _calculateMaxHeight(incomingHeight) {
        // 헤딩 슛은 일반적으로 낮게 (0.2~0.6)
        const base = 0.2 + incomingHeight * 0.3;
        return base + (Math.random() - 0.5) * 0.1;
    }

    /**
     * 골키퍼 세이브 판정에 사용할 슈팅 궤적 정보를 생성한다.
     *
     * @param {object} header 헤딩하는 선수 { x, y }
     * @param {object} shotResult execute()의 반환값
     * @returns {object} ShotTrajectory 정보
     */
    getShotTrajectory(header, shotResult) {
        return {
            startX: header.x,
            startY: header.y,
            targetX: this._goalX,
            targetY: shotResult.finalTargetY,
            speed: shotResult.power,
            startHeight: 0.3, // 헤딩 시작 높이
            targetHeight: shotResult.maxHeight * HEIGHT_SCALE,
            arcHeight: shotResult.maxHeight * 0.5,
        };
    }
}
