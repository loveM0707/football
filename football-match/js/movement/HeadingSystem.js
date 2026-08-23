/**
 * HeadingSystem - 헤딩 시스템 모듈
 *
 * 공중에 떠 있는 볼에 대한 헤딩 판정, 경합, 실행, 세컨드볼 반응을 담당한다.
 * 이 모듈은 시나리오에 독립적이며, 어떤 헤딩 메뉴에서든 재사용할 수 있다.
 *
 * 핵심 개념:
 *   - 착지점 예측: 공중 공이 떨어질 위치를 시간 기반으로 계산
 *   - 헤딩 판정: 선수의 위치·속도·공과의 관계로 헤딩 시도 여부 결정
 *   - 공중볼 경합: 두 선수가 같은 공을 향해 점프할 때 승부 판정
 *   - 헤딩 실행: 공의 새로운 방향·속도·높이를 계산하여 적용
 *   - 세컨드볼: 헤딩 후 주변 선수가 공을 획득하기 위한 반응
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { angleTo, forwardVector } from './Direction.js';

// ── 상수 ──────────────────────────────────────────────
const FIELD_HEIGHT = 680;
const GOAL_X = 1050;
const GOAL_TOP_Y = 303.4;
const GOAL_BOTTOM_Y = 376.6;
const CENTER_Y = FIELD_HEIGHT / 2;
const HEIGHT_SCALE = 3;

// 헤딩 관련 거리·속도 상수
const HEADER_CONTACT_RADIUS = 18;     // 헤딩 접촉 반경 (SVG)
const HEADER_JUMP_RADIUS = 30;        // 점프 가능 반경 (SVG)
const HEADER_APPROACH_SPEED = 120;    // 공중볼 추적 기본 속도
const SECOND_BALL_RADIUS = 80;        // 세컨드볼 반응 반경 (SVG)
const SECOND_BALL_REACTION_DELAY = 0.15; // 세컨드볼 반응 지연 (초)

// 헤딩 결과 상수
export const HEADER_RESULT = {
    WIN: 'win',           // 경합 승리
    LOSE: 'lose',         // 경합 패배
    NO_DUEL: 'no_duel',   // 경합 없음 (혼자 헤딩)
    MISS: 'miss',         // 헤딩 실패 (공에 닿지 않음)
};

// 헤딩 방향 상수
export const HEADER_DIRECTION = {
    PASS: 'pass',         // 패스 방향
    SHOT: 'shot',         // 슛 방향
    CLEAR: 'clear',       // 클리어링
    DOWN: 'down',         // 아래로 (착지)
    LATERAL: 'lateral',   // 측면으로
};

export class HeadingSystem {
    constructor(options = {}) {
        this.goalX = options.goalX ?? GOAL_X;
        this.goalTopY = options.goalTopY ?? GOAL_TOP_Y;
        this.goalBottomY = options.goalBottomY ?? GOAL_BOTTOM_Y;
        this.centerGoalY = (this.goalTopY + this.goalBottomY) / 2;
    }

    // ── 1. 착지점 예측 ──────────────────────────────────

    /**
     * 공중에 떠 있는 공의 착지점을 예측한다.
     *
     * @param {object} ball 현재 공 위치 { x, y, height }
     * @param {object} ballMovement BallMovement 인스턴스
     * @returns {{ x: number, y: number, time: number } | null}
     *   착지점 좌표와 남은 시간. 공중에 없으면 null.
     */
    predictLandingPoint(ball, ballMovement) {
        // 공중 비행 중
        if (ballMovement.isAerial) {
            const remaining = ballMovement._aerialDuration - ballMovement._aerialTimer;
            if (remaining <= 0) return null;
            return {
                x: ball.x + ballMovement._aerialVx * remaining,
                y: ball.y + ballMovement._aerialVy * remaining,
                time: remaining,
            };
        }

        // 바운드 중
        if (ballMovement.isBouncing) {
            const bounce = ballMovement._bounce;
            if (!bounce) return null;
            const remaining = bounce.duration - bounce.timer;
            if (remaining <= 0) return null;
            return {
                x: ball.x + bounce.vx * remaining,
                y: ball.y + bounce.vy * remaining,
                time: remaining,
            };
        }

        return null;
    }

    /**
     * 공이 특정 높이에 도달하는 시간을 역산한다.
     * 공중 비행 중인 공의 높이 곡선은 포물선이다.
     *
     * @param {object} ballMovement BallMovement 인스턴스
     * @param {number} targetHeight 목표 높이 (0~1 스케일)
     * @returns {number} 남은 시간 (초). 불가능하면 -1.
     */
    timeToHeight(ballMovement, targetHeight) {
        if (!ballMovement.isAerial) return -1;

        const remaining = ballMovement._aerialDuration - ballMovement._aerialTimer;
        const progress = ballMovement._aerialTimer / ballMovement._aerialDuration;
        const maxH = ballMovement._aerialMaxH;

        // 포물선: h = maxH * 4 * p * (1-p)
        // 목표 높이에 도달하는 p를 역산
        // maxH * 4 * p * (1-p) = targetHeight
        // -4*maxH*p^2 + 4*maxH*p - targetHeight = 0
        const a = -4 * maxH;
        const b = 4 * maxH;
        const c = -targetHeight;
        const discriminant = b * b - 4 * a * c;

        if (discriminant < 0) return -1;

        const sqrtD = Math.sqrt(discriminant);
        const p1 = (-b + sqrtD) / (2 * a);
        const p2 = (-b - sqrtD) / (2 * a);

        // 현재 진행률보다 큰 p를 선택 (앞으로 올라가거나 내려오는 시점)
        const candidates = [p1, p2].filter(p => p > progress && p <= 1);
        if (candidates.length === 0) return -1;

        const targetProgress = Math.min(...candidates);
        return (targetProgress - progress) * ballMovement._aerialDuration;
    }

    // ── 2. 헤딩 판정 ──────────────────────────────────

    /**
     * 선수가 공중볼에 헤딩을 시도할지 판단한다.
     *
     * @param {object} player 선수 { x, y, angle, number, team }
     * @param {object} ball 공 { x, y, height }
     * @param {object} ballMovement BallMovement 인스턴스
     * @param {object} options
     * @param {string} options.team 'home' | 'away'
     * @param {number} options.reactionTime 반응 시간 (초, 기본값: 0.3)
     * @returns {{ shouldHeader: boolean, targetX: number, targetY: number, approachSpeed: number }}
     */
    evaluateHeader(player, ball, ballMovement, options = {}) {
        const reactionTime = options.reactionTime ?? 0.3;

        // 착지점 예측
        const landing = this.predictLandingPoint(ball, ballMovement);
        if (!landing) {
            return { shouldHeader: false, targetX: 0, targetY: 0, approachSpeed: 0 };
        }

        // 선수에서 착지점까지의 거리
        const dist = Math.hypot(landing.x - player.x, landing.y - player.y);

        // 착지점까지 도달할 수 있는지 확인
        const timeAvailable = landing.time - reactionTime;
        if (timeAvailable <= 0) {
            return { shouldHeader: false, targetX: 0, targetY: 0, approachSpeed: 0 };
        }

        const requiredSpeed = dist / timeAvailable;
        const canReach = requiredSpeed <= PlayerMovement_SPEEDS[4]; // 최고 속도 이하

        if (!canReach) {
            return { shouldHeader: false, targetX: 0, targetY: 0, approachSpeed: 0 };
        }

        // 충분히 가까운 거리에서만 헤딩 시도
        if (dist > HEADER_JUMP_RADIUS * 3) {
            return { shouldHeader: false, targetX: 0, targetY: 0, approachSpeed: 0 };
        }

        // 헤딩 방향 결정 (기본: 골 방향)
        const targetX = this._determineHeaderTarget(player, ball, options);
        const targetY = this._determineHeaderTargetY(player, ball, options);

        return {
            shouldHeader: true,
            targetX,
            targetY,
            approachSpeed: Math.min(HEADER_APPROACH_SPEED, requiredSpeed),
            landingPoint: landing,
        };
    }

    /**
     * 헤딩 목표 X 좌표를 결정한다.
     */
    _determineHeaderTarget(player, ball, options) {
        const headingType = options.headingType ?? 'clear';
        const attackDir = options.attackDir ?? 1;

        switch (headingType) {
            case 'shot':
                // 슛: 골 방향
                return GOAL_X;
            case 'pass':
                // 패스: 지정된 목표
                return options.targetX ?? player.x + attackDir * 200;
            case 'clear':
                // 클리어링: 수비 방향으로 멀리
                return player.x - attackDir * 300;
            case 'duel':
                // 경합: 공의 착지점
                return options.landingX ?? ball.x;
            default:
                return player.x + attackDir * 150;
        }
    }

    /**
     * 헤딩 목표 Y 좌표를 결정한다.
     */
    _determineHeaderTargetY(player, ball, options) {
        const headingType = options.headingType ?? 'clear';

        switch (headingType) {
            case 'shot':
                // 슛: 골문 중앙
                return this.centerGoalY;
            case 'pass':
                // 패스: 지정된 목표
                return options.targetY ?? player.y;
            case 'clear':
                // 클리어링: 측면으로
                return player.y + (Math.random() > 0.5 ? 100 : -100);
            case 'duel':
                // 경합: 공의 착지점
                return options.landingY ?? ball.y;
            default:
                return player.y;
        }
    }

    // ── 3. 공중볼 경합 ──────────────────────────────────

    /**
     * 두 선수 간 공중볼 경합을 판정한다.
     *
     * @param {object} player1 선수 1
     * @param {object} player2 선수 2
     * @param {object} ball 공
     * @param {object} ballMovement BallMovement 인스턴스
     * @param {object} options
     * @returns {{ winner: object, result: string, headerPower: number }}
     */
    resolveAerialDuel(player1, player2, ball, ballMovement, options = {}) {
        // 착지점까지의 거리
        const landing = this.predictLandingPoint(ball, ballMovement);
        const landingX = landing?.x ?? ball.x;
        const landingY = landing?.y ?? ball.y;

        const dist1 = Math.hypot(landingX - player1.x, landingY - player1.y);
        const dist2 = Math.hypot(landingX - player2.x, landingY - player2.y);

        // 위치 점수: 착지점에 가까울수록 높음
        const maxDist = HEADER_JUMP_RADIUS * 3;
        const posScore1 = Math.max(0, 1 - dist1 / maxDist);
        const posScore2 = Math.max(0, 1 - dist2 / maxDist);

        // 능력 점수 (기본값 사용, 나중에 속성 추가 가능)
        const ability1 = options.ability1 ?? 0.5;
        const ability2 = options.ability2 ?? 0.5;

        // 종합 점수 = 위치 60% + 능력 40%
        const score1 = posScore1 * 0.6 + ability1 * 0.4;
        const score2 = posScore2 * 0.6 + ability2 * 0.4;

        // 랜덤 요소 (±15%)
        const random1 = score1 * (0.85 + Math.random() * 0.3);
        const random2 = score2 * (0.85 + Math.random() * 0.3);

        // 승자 결정
        const winner = random1 >= random2 ? player1 : player2;
        const loser = winner === player1 ? player2 : player1;
        const result = winner === player1 ? HEADER_RESULT.WIN : HEADER_RESULT.LOSE;

        // 헤딩 파워: 거리와 능력에 따라 결정
        const winnerDist = winner === player1 ? dist1 : dist2;
        const winnerAbility = winner === player1 ? ability1 : ability2;
        const headerPower = 150 + (1 - winnerDist / maxDist) * 200 + winnerAbility * 100;

        return {
            winner,
            loser,
            result,
            headerPower,
            landingPoint: { x: landingX, y: landingY },
        };
    }

    // ── 4. 헤딩 실행 ──────────────────────────────────

    /**
     * 헤딩을 실행하여 공의 새로운 속도를 계산한다.
     *
     * @param {object} player 헤딩하는 선수 { x, y, angle }
     * @param {object} ball 공 { x, y, height }
     * @param {object} options
     * @param {number} options.targetX 목표 X
     * @param {number} options.targetY 목표 Y
     * @param {number} options.power 헤딩 파워 (기본값: 250)
     * @param {string} options.type 'pass' | 'shot' | 'clear' | 'loop'
     * @returns {{ vx: number, vy: number, vz: number, newHeight: number }}
     */
    executeHeader(player, ball, options = {}) {
        const targetX = options.targetX ?? (player.x + 200);
        const targetY = options.targetY ?? player.y;
        const power = options.power ?? 250;
        const type = options.type ?? 'clear';

        // 방향 계산
        const dx = targetX - ball.x;
        const dy = targetY - ball.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return { vx: 0, vy: 0, vz: 0, newHeight: 0 };

        const nx = dx / dist;
        const ny = dy / dist;

        // 높이 결정
        let newHeight;
        switch (type) {
            case 'shot':
                newHeight = 0.3 + Math.random() * 0.4; // 낮게 날리는 슛
                break;
            case 'pass':
                newHeight = 0.5 + Math.random() * 0.5; // 적당한 높이
                break;
            case 'clear':
                newHeight = 0.6 + Math.random() * 0.4; // 높이 띄워서 클리어
                break;
            case 'loop':
                newHeight = 1.0 + Math.random() * 0.5; // 높은 포물선
                break;
            default:
                newHeight = 0.5;
        }

        return {
            vx: nx * power,
            vy: ny * power,
            vz: 0,
            newHeight,
        };
    }

    /**
     * 헤딩 결과를 BallMovement에 적용한다.
     *
     * @param {object} ballMovement BallMovement 인스턴스
     * @param {object} headerResult executeHeader의 반환값
     * @param {number} flightTime 공이 착지점까지 날아가는 시간 (초)
     */
    applyHeader(ballMovement, headerResult, flightTime) {
        ballMovement.releaseAerial(
            headerResult.vx,
            headerResult.vy,
            flightTime,
            headerResult.newHeight,
            null, // 착지 시 콜백 (상위 시나리오에서 설정)
        );
    }

    // ── 5. 세컨드볼 ──────────────────────────────────

    /**
     * 세컨드볼 상황에서 주변 선수들의 반응을 계산한다.
     *
     * @param {object} ball 공 { x, y }
     * @param {object[]} players 주변 선수 배열
     * @param {object} options
     * @param {string} options.team 선수 팀 ('home' | 'away')
     * @param {number} options.reactionDelay 반응 지연 (초, 기본값: 0.15)
     * @returns {{ reactor: object, reactionTime: number, targetX: number, targetY: number } | null}
     */
    findSecondBallReactor(ball, players, options = {}) {
        const team = options.team;
        const reactionDelay = options.reactionDelay ?? SECOND_BALL_REACTION_DELAY;

        let bestReactor = null;
        let bestTime = Infinity;

        for (const player of players) {
            if (player.team !== team) continue;

            const dist = Math.hypot(ball.x - player.x, ball.y - player.y);
            if (dist > SECOND_BALL_RADIUS) continue;

            // 도달 시간 = 반응 지연 + 거리/속도
            const approachTime = dist / HEADER_APPROACH_SPEED;
            const totalTime = reactionDelay + approachTime;

            if (totalTime < bestTime) {
                bestTime = totalTime;
                bestReactor = player;
            }
        }

        if (!bestReactor) return null;

        return {
            reactor: bestReactor,
            reactionTime: bestTime,
            targetX: ball.x,
            targetY: ball.y,
        };
    }

    /**
     * 세컨드볼 상황에서 공의 움직임을 업데이트한다.
     * 헤딩 후 공이 착지할 때까지의 물리를 처리한다.
     *
     * @param {object} ballMovement BallMovement 인스턴스
     * @param {object} ballMovement._bounce 바운드 정보
     */
    updateSecondBall(ballMovement) {
        // BallMovement가 이미 공중 물리와 바운드를 처리한다.
        // 이 메서드는 추가적인 세컨드볼 로직이 필요할 때 사용한다.
    }

    // ── 보조 함수 ──────────────────────────────────────

    /**
     * 두 선수 사이의 거리를 계산한다.
     */
    distanceBetween(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    /**
     * 선수가 특정 위치에 도달할 수 있는 시간을 계산한다.
     */
    timeToReach(player, targetX, targetY, speed) {
        const dist = Math.hypot(targetX - player.x, targetY - player.y);
        return dist / Math.max(1, speed);
    }

    /**
     * 공의 현재 높이를 반환한다 (0~1 스케일).
     */
    getBallHeight(ball) {
        return ball.height ?? 0;
    }

    /**
     * 공이 높이 h에 있는지 확인한다.
     * h의 tolerance范围内이면 true.
     */
    isAtHeight(ball, targetHeight, tolerance = 0.1) {
        return Math.abs(ball.height - targetHeight) <= tolerance;
    }
}

// PlayerMovement.SPEEDS 참조
const PlayerMovement_SPEEDS = [50, 75, 100, 125, 150];
