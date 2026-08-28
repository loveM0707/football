/**
 * GoalkeeperMovement - 골키퍼 위치 제어 모듈
 *
 * 골키퍼는 일반 필드 플레이어와 다르게 행동해야 한다.
 * 단순히 공을 쫓지 않고, 골대 기하학과 공의 움직임을 기반으로
 * 슈팅 각도를 줄이는 위치를 유지한다.
 *
 * 매 프레임 다음 요소를 기반으로 목표 위치를 계산한다:
 *   - ballPosition: 공의 현재 위치
 *   - goalGeometry: 골대 위치 (goalX, goalTopY, goalBottomY)
 *   - ballVelocity: 공의 속도 (vx, vy)
 *   - dangerLevel: 위험도 (공이 골대를 향하는지, 속도 등)
 *
 * 골키퍼는 기본적으로 유효 영역 내에서만 움직이며,
 * sweeper-keeper 행동 시에만 영역을 벗어날 수 있다.
 */

const FIELD_HEIGHT = 680;
const DEFAULT_GOAL_X = 1050;
const DEFAULT_GOAL_TOP_Y = 303.4;
const DEFAULT_GOAL_BOTTOM_Y = 376.6;
const DEFAULT_GOAL_CENTER_Y = 340;

// 골키퍼가 골라인에서 얼마나 앞에 설 수 있는지 (최대 깊이) — 과대 다이빙 방지 위해 축소
const MAX_DEPTH_FROM_GOAL_LINE = 48;

// 골키퍼 좌우 이동 범위 (골대 포스트에서 여유)
const LATERAL_MARGIN = 12;

// 공이 골대를 향할 때 전진하는 최소 거리
const ADVANCE_DISTANCE = 22;

// 위험도 임계값 (이 이상이면 적극적으로 대응)
const DANGER_THRESHOLD = 0.6;

export class GoalkeeperMovement {
    /**
     * @param {object} options
     * @param {number} options.goalX 골라인 X 좌표 (기본값: 1050)
     * @param {number} options.goalTopY 골대 위쪽 Y 좌표 (기본값: 303.4)
     * @param {number} options.goalBottomY 골대 아래쪽 Y 좌표 (기본값: 376.6)
     * @param {number} options.goalCenterY 골대 중심 Y 좌표 (기본값: 340)
     * @param {number} options.maxDepth 골라인에서 최대 전진 거리 (기본값: 80)
     * @param {number} options.lateralMargin 골대 포스트에서 좌우 여유 (기본값: 15)
     * @param {boolean} options.allowSweeper sweeper-keeper 행동 허용 (기본값: false)
     */
    constructor(options = {}) {
        this.goalX = options.goalX ?? DEFAULT_GOAL_X;
        this.goalTopY = options.goalTopY ?? DEFAULT_GOAL_TOP_Y;
        this.goalBottomY = options.goalBottomY ?? DEFAULT_GOAL_BOTTOM_Y;
        this.goalCenterY = options.goalCenterY ?? DEFAULT_GOAL_CENTER_Y;
        this.maxDepth = options.maxDepth ?? MAX_DEPTH_FROM_GOAL_LINE;
        this.lateralMargin = options.lateralMargin ?? LATERAL_MARGIN;
        this.allowSweeper = options.allowSweeper ?? false;

        // 현재 목표 위치 (매 프레임 업데이트)
        this.targetX = this.goalX;
        this.targetY = this.goalCenterY;

        // 골키퍼 방향 (공을 바라봄)
        this.facingAngle = 90; // 기본값: 왼쪽을 바라봄 (오른쪽 골 기준)
    }

    /**
     * 매 프레임 호출되어 골키퍼의 목표 위치를 계산한다.
     *
     * @param {object} ball 공 엔티티 (x, y, vx, vy)
     * @param {object} goalkeeper 골키퍼 엔티티 (x, y)
     * @returns {{ x: number, y: number, facingAngle: number }}
     */
    update(ball, goalkeeper) {
        // 1. 공-골대 각도 계산
        const ballToGoalAngle = this._calculateBallToGoalAngle(ball);

        // 2. 위험도 계산
        const dangerLevel = this._calculateDangerLevel(ball);

        // 3. 골키퍼 깊이 (골라인에서 얼마나 앞에 설지)
        const depth = this._calculateDepth(ball, dangerLevel);

        // 4. 골키퍼 좌우 위치 (공의 각도에 따라 조정)
        const lateralPosition = this._calculateLateralPosition(ball, ballToGoalAngle, dangerLevel);

        // 5. 목표 위치 계산
        this.targetX = this.goalX - depth;
        this.targetY = lateralPosition;

        // 6. 골키퍼 영역 제한 (sweeper-keeper가 아닌 경우)
        if (!this.allowSweeper || !this._isSweeperSituation(ball)) {
            this.targetX = this._clampToGoalkeeperZone(this.targetX);
            this.targetY = this._clampToLateralZone(this.targetY);
        }

        // 7. 골키퍼 방향 (공을 바라봄)
        this.facingAngle = this._calculateFacingAngle(goalkeeper, ball);

        return {
            x: this.targetX,
            y: this.targetY,
            facingAngle: this.facingAngle,
        };
    }

    /**
     * 공이 골대 중심과 이루는 각도를 계산한다.
     * 각도는 -90 ~ +90 범위 (골대 기준 좌우).
     */
    _calculateBallToGoalAngle(ball) {
        const dx = ball.x - this.goalX;
        const dy = ball.y - this.goalCenterY;
        const angle = Math.atan2(dy, dx);
        return angle;
    }

    /**
     * 위험도를 0~1 범위로 계산한다.
     * 공이 골대를 향하고, 속도가 빠르고, 가까울수록 위험도가 높다.
     */
    _calculateDangerLevel(ball) {
        // 공이 골대를 향하는지 확인 (오른쪽 골 기준: vx < 0)
        const isApproaching = ball.vx < -10;

        // 공의 속도 (vx와 전체 속도 함께 고려 — 느리게 굴러오는 볼도 위험)
        const speed = Math.hypot(ball.vx, ball.vy);
        const vxSpeed = Math.abs(ball.vx);
        const speedFactor = Math.max(Math.min(1, vxSpeed / 500), Math.min(0.55, speed / 280));

        // 공과 골대 사이의 거리 — 400 이내면 이미 위험 상향
        const distanceToGoal = this.goalX - ball.x;
        const distanceFactor = Math.max(0, 1 - distanceToGoal / 600);
        const closeBoost = distanceToGoal < 220 ? 0.25 : 0;

        // 공이 골문 안에 있는지
        const isInGoalRange = ball.y >= this.goalTopY && ball.y <= this.goalBottomY;
        const goalRangeFactor = isInGoalRange ? 1 : 0.6;

        // 위험도 = 공이 골대를 향하는지 * 속도 * 거리 * 골문 범위 + 근접 보정
        const danger = (isApproaching ? 1 : 0.35) * speedFactor * distanceFactor * goalRangeFactor + closeBoost;

        return Math.max(0, Math.min(1, danger));
    }

    /**
     * 골키퍼의 깊이를 계산한다.
     * 공이 가까우면 앞으로, 멀면 뒤로.
     */
    _calculateDepth(ball, dangerLevel) {
        // 기본 깊이: 골라인에서 약간 앞 — 과대 전진 억제
        const baseDepth = 10;

        // 공이 가까우면 더 앞으로 — 320 이내에서 완만히 전진
        const distanceToGoal = this.goalX - ball.x;
        const proximityFactor = Math.max(0, 1 - distanceToGoal / 420);

        // 위험도가 높으면 더 적극적으로 전진 (완화)
        const dangerAdvance = dangerLevel > DANGER_THRESHOLD ? ADVANCE_DISTANCE * dangerLevel * 0.55 : 0;
        // 극근접(박스 안)은 무조건 깊게 — 컷백 대비 (완화)
        const boxPress = distanceToGoal < 165 ? 7 : 0;

        const depth = baseDepth + proximityFactor * this.maxDepth * 0.52 + dangerAdvance + boxPress;

        return Math.max(0, Math.min(this.maxDepth, depth));
    }

    /**
     * 골키퍼의 좌우 위치를 계산한다.
     * 공의 각도에 따라 골대 중심에서 좌우로 이동한다.
     */
    _calculateLateralPosition(ball, ballToGoalAngle, dangerLevel) {
        // 공의 각도에 따른 좌우 오프셋 — 다이빙 과대 방지 위해 스케일 축소
        const distToGoal = this.goalX - ball.x;
        const proximity = Math.max(0, 1 - distToGoal / 420);
        const lateralScale = 72 + proximity * 28; // 72~100 (기존 95~150 대비 축소)
        const lateralOffset = Math.sin(ballToGoalAngle) * lateralScale;

        // 기본 위치: 골대 중심
        const basePosition = this.goalCenterY;

        // 위험도가 높으면 공 각도에 더 민감하게 반응 (완화)
        const sensitivity = 0.48 + dangerLevel * 0.42 + proximity * 0.14;

        const lateralPosition = basePosition + lateralOffset * sensitivity;

        return lateralPosition;
    }

    /**
     * 골키퍼의 방향을 계산한다.
     * 공을 바라보도록 각도를 설정한다.
     * angleTo 함수와 동일한 공식 사용: angle=90이면 왼쪽(필드 쪽)을 바라봄
     */
    _calculateFacingAngle(goalkeeper, ball) {
        const dx = goalkeeper.x - ball.x;
        const dy = ball.y - goalkeeper.y;
        return Math.atan2(dx, dy) * 180 / Math.PI;
    }

    /**
     * 골키퍼가 골라인을 벗어나지 않도록 X 좌표를 제한한다.
     */
    _clampToGoalkeeperZone(x) {
        const minX = this.goalX - this.maxDepth;
        const maxX = this.goalX;
        return Math.max(minX, Math.min(maxX, x));
    }

    /**
     * 골키퍼가 골대 좌우를 벗어나지 않도록 Y 좌표를 제한한다.
     */
    _clampToLateralZone(y) {
        const minY = this.goalTopY - this.lateralMargin;
        const maxY = this.goalBottomY + this.lateralMargin;
        return Math.max(minY, Math.min(maxY, y));
    }

    /**
     * sweeper-keeper 상황인지 확인한다.
     * 공이 골키퍼 뒤로 넘어갔거나, 골키퍼가 공을 잡으러 나가야 하는 상황.
     */
    _isSweeperSituation(ball) {
        // 공이 골라인을 넘었거나, 골키퍼 뒤로 넘어간 경우
        const isBehindGoal = ball.x > this.goalX;
        const isDeepInDefense = ball.x > this.goalX - 100 && ball.y < this.goalTopY - 50;

        return isBehindGoal || isDeepInDefense;
    }

    /**
     * 골키퍼의 현재 목표 위치를 반환한다.
     */
    getTarget() {
        return {
            x: this.targetX,
            y: this.targetY,
            facingAngle: this.facingAngle,
        };
    }
}
