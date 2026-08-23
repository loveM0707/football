/**
 * ShootingWithGoalkeeper - 하프라인 오른쪽 10m 지점에서 드리블 후 슈팅 (골키퍼 포함)
 *
 * 기존 슈팅 메뉴와 동일하게 진행하되, 골대 앞에 골키퍼가 배치되어
 * GoalkeeperMovement 모듈에 따라 위치를 조정하고,
 * 슈팅이 날아가는 동안 GoalkeeperSave 모듈에 따라 세이브를 시도한다.
 *
 * 흐름:
 *   1. 공격수가 슈팅
 *   2. 골키퍼가 세이브 지점을 계산하고 다이브 시작
 *   3. 공과 골키퍼가 세이브 지점에서 만나면 세이브 판정
 *   4. 만나지 못하면 골라인까지 공이 진행 → 골/빗나감 판정
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { BallMovement } from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { ShotMovement } from '../movement/ShotMovement.js';
import { GoalkeeperMovement } from '../movement/GoalkeeperMovement.js';
import { GoalkeeperSave, SAVE_RESULT } from '../movement/GoalkeeperSave.js';
import { angleTo, forwardVector } from '../movement/Direction.js';
import { generateGoalDribbleWaypoints } from '../movement/DribbleRoute.js';

const FIELD_HEIGHT = 680;
const CENTER_Y = FIELD_HEIGHT / 2;
const GOAL_X = 1050;
const HALF_LINE_X = 525;
const START_X = HALF_LINE_X + 10 * 10;
const SHOOT_MIN_X = GOAL_X - 30 * 10;
const SHOOT_MAX_X = GOAL_X - 16.5 * 10;
const GOAL_TOP_Y = 303.4;
const GOAL_BOTTOM_Y = 376.6;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;

// 골키퍼 설정
const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;
const GK_POSITION_SPEED = 350; // 드리블 중 위치 조정 속도
const GK_DIVE_SPEED = 500; // 세이브 다이브 속도
const GK_REACTION_TIME = 0.1; // 공이 슈팅된 후 반응 지연 (초)

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function createDribblePlan() {
    const earliestShootX = SHOOT_MIN_X + 90;
    const latestShootX = SHOOT_MAX_X - 10;
    const shootX = earliestShootX + Math.random() * (latestShootX - earliestShootX);
    const finalY = clamp(CENTER_Y + (Math.random() * 2 - 1) * 20, 260, 420);

    return generateGoalDribbleWaypoints(START_X, CENTER_Y, {
        endX: shootX,
        finalX: shootX,
        finalY,
        yMin: 45,
        yMax: 635,
    });
}

function randomAimY() {
    const aim = Math.random();
    if (aim < 0.04) return GOAL_TOP_Y - 1 + Math.random() * 3;
    if (aim < 0.08) return GOAL_BOTTOM_Y - 1 + Math.random() * 3;
    if (aim < 0.18) return GOAL_TOP_Y - 11 + Math.random() * 3;
    if (aim < 0.28) return GOAL_BOTTOM_Y + 8 + Math.random() * 3;

    const safeTop = GOAL_TOP_Y + 9;
    const safeBottom = GOAL_BOTTOM_Y - 9;
    return safeTop + Math.random() * (safeBottom - safeTop);
}

function randomShotHeight() {
    const roll = Math.random();
    if (roll < 0.32) return { targetHeight: 0.06, arcHeight: 0.08 };
    if (roll < 0.78) {
        return {
            targetHeight: 0.35 + Math.random() * 1.35,
            arcHeight: 0.15 + Math.random() * 0.2,
        };
    }
    if (roll < 0.82) {
        return { targetHeight: 2.32 + Math.random() * 0.1, arcHeight: 0.06 };
    }
    return { targetHeight: 2.65 + Math.random() * 0.35, arcHeight: 0.08, overBar: true };
}

export function run(layer, loop, onComplete = null) {
    // ── 공격수 ────────────────────────────────────────
    const player = new Player({
        x: START_X,
        y: CENTER_Y,
        team: 'home',
        number: 9,
        angle: -90,
    }).render(layer);
    const ball = new Ball(player.x, player.y).render(layer);
    const pm = new PlayerMovement(player, { driftScale: 0 });
    const bm = new BallMovement(ball);
    const dc = new DribbleController(pm, bm);
    const shot = new ShotMovement({ goalX: GOAL_X });
    const dribblePlan = createDribblePlan();

    // ── 골키퍼 ────────────────────────────────────────
    const goalkeeper = new Player({
        x: GK_START_X,
        y: GK_START_Y,
        team: 'away',
        number: 1,
        angle: 90,
    }).render(layer);
    const gkMovement = new GoalkeeperMovement({
        goalX: GOAL_X,
        goalTopY: GOAL_TOP_Y,
        goalBottomY: GOAL_BOTTOM_Y,
    });
    const gkSave = new GoalkeeperSave({
        goalX: GOAL_X,
        goalTopY: GOAL_TOP_Y,
        goalBottomY: GOAL_BOTTOM_Y,
        skill: 0.7,
        diveSpeed: GK_DIVE_SPEED,
    });

    // ── 드리블 상태 ───────────────────────────────────
    let planIndex = 0;
    let shootReady = false;
    let shooting = false;
    let complete = false;
    let recovering = false;
    let currentWaypoint = null;

    // ── 골키퍼 다이브 상태 ────────────────────────────
    let gkDiving = false; // 다이브 중인지
    let gkReactionTimer = 0; // 반응 지연 타이머
    let gkDiveTargetX = 0; // 다이브 목표 X
    let gkDiveTargetY = 0; // 다이브 목표 Y
    let saveInfo = null; // 세이브 판정 정보
    let saveTimer = 0; // 세이브 후 잔여 시간 (parry/deflection 시 잠시 공 이동)
    let gkTarget = { x: GK_START_X, y: GK_START_Y, facingAngle: 90 };

    bm.possess(player, POSSESS_OFFSET);
    bm.snapToFront();
    dc.start();

    // ── 드리블 흐름 ───────────────────────────────────
    function nextDribble() {
        if (planIndex >= dribblePlan.length) {
            shootReady = true;
            pm.stop();
            return;
        }

        const waypoint = dribblePlan[planIndex++];
        currentWaypoint = waypoint;
        dc.setSpeed(waypoint.speed);
        pm.clearFacingTarget();
        pm.moveTo(waypoint.x, waypoint.y, nextDribble);
    }

    function recoverBall() {
        if (!bm.owner || dc.ballAttached) return;

        const fwd = forwardVector(player.angle);
        recovering = true;
        pm.resetTurn(player.angle);
        pm.setFacingTarget(player.angle);
        pm.moveTo(
            ball.x - fwd.x * POSSESS_OFFSET,
            ball.y - fwd.y * POSSESS_OFFSET,
        );
    }

    function finish(result = null) {
        if (complete) return;
        complete = true;
        dc.stop();
        pm.stop();
        if (onComplete) onComplete(result);
    }

    // ── 슈팅 처리 ─────────────────────────────────────
    function fireShot() {
        if (!shootReady || !dc.ballAttached) return false;

        const targetY = randomAimY();
        const height = randomShotHeight();
        const isSideAim = targetY < GOAL_TOP_Y || targetY > GOAL_BOTTOM_Y;
        const shotTargetY = height.overBar && !isSideAim
            ? GOAL_TOP_Y + 20
            : targetY;
        const targetAngle = angleTo(player.x, player.y, GOAL_X, shotTargetY);
        const shotSpeed = 520 + Math.random() * 80;

        pm.stop();
        pm.resetTurn(targetAngle);
        pm.setFacingTarget(targetAngle);
        recovering = false;
        dc.stop();

        // 슈팅 발사
        const fired = shot.shoot(bm, {
            targetY: shotTargetY,
            targetHeight: height.targetHeight,
            arcHeight: height.arcHeight,
            speed: shotSpeed,
        });

        if (!fired) return false;

        // 골키퍼 세이브 지점 사전 계산
        const isOnTarget = shotTargetY >= GOAL_TOP_Y && shotTargetY <= GOAL_BOTTOM_Y;

        if (isOnTarget) {
            const shotTrajectory = {
                startX: ball.x,
                startY: ball.y,
                targetX: GOAL_X,
                targetY: shotTargetY,
                speed: shotSpeed,
                startHeight: height.targetHeight * 0.1,
                targetHeight: height.targetHeight,
                arcHeight: height.arcHeight,
            };

            const evaluation = gkSave.evaluateSave(shotTrajectory, goalkeeper);

            // 세이브 지점을 골라인보다 앞쪽으로 제한
            // 골라인과 동시에 체크되면 세이브 판정이 늦어지는 문제 방지
            const cappedSavePointX = Math.min(evaluation.savePointX, GOAL_X - 15);

            saveInfo = {
                shotTrajectory,
                savePointX: cappedSavePointX,
                savePointY: evaluation.savePointY,
                canSave: evaluation.canSave,
                decidedResult: evaluation.result,
            };

            // 골키퍼 다이브 시작 (반응 지연 후)
            gkReactionTimer = GK_REACTION_TIME;
            gkDiving = true;
            gkDiveTargetX = cappedSavePointX;
            gkDiveTargetY = evaluation.savePointY;
        } else {
            // 빗나가는 슛: 골키퍼는 반응만
            saveInfo = null;
            gkDiving = false;
        }

        return true;
    }

    nextDribble();

    // ── 메인 루프 ─────────────────────────────────────
    function tick(dt) {
        if (complete) return;

        // ── 세이브 후 잔여 모션 (parry/deflection) ──────
        if (saveTimer > 0) {
            saveTimer -= dt;
            bm.update(dt);
            if (saveTimer <= 0) finish('save');
            return;
        }

        // ── 슈팅 비행 중 ──────────────────────────────
        if (shooting) {
            // 골키퍼 반응 지연 카운트다운
            if (gkReactionTimer > 0) {
                gkReactionTimer -= dt;
            }

            // 골키퍼 다이브 이동
            if (gkDiving && gkReactionTimer <= 0) {
                const dx = gkDiveTargetX - goalkeeper.x;
                const dy = gkDiveTargetY - goalkeeper.y;
                const dist = Math.hypot(dx, dy);

                if (dist > 1) {
                    const step = Math.min(GK_DIVE_SPEED * dt, dist);
                    goalkeeper.setPosition(
                        goalkeeper.x + (dx / dist) * step,
                        goalkeeper.y + (dy / dist) * step,
                    );
                }

                // 골키퍼가 공이 오는 방향(필드 쪽)을 바라보도록
                // 공이 오른쪽에서 왼쪽으로 날아오므로, 골키퍼는 왼쪽을 바라봄
                goalkeeper.setAngle(90);
            }

            // 공이 세이브 지점에 도달했는지 확인
            if (saveInfo && !saveInfo.intercepted) {
                // 공이 세이브 지점 X에 도달
                if (ball.x >= saveInfo.savePointX - 5) {
                    saveInfo.intercepted = true;

                    // 골키퍼가 세이브 지점에 충분히 가까운지 확인
                    const gkDist = Math.hypot(
                        goalkeeper.x - saveInfo.savePointX,
                        goalkeeper.y - saveInfo.savePointY,
                    );

                    if (gkDist < gkSave.reachRadius) {
                        // 세이브 성공: 세이브 유형 결정
                        const saveType = gkSave.determineSaveType(
                            saveInfo.shotTrajectory,
                            goalkeeper,
                            { x: saveInfo.savePointX, y: saveInfo.savePointY },
                        );

                        if (saveType === SAVE_RESULT.CATCH) {
                            // 잡기: 공이 골키퍼 앞쪽(필드 방향)에서 1초간 정지
                            ball.setPosition(saveInfo.savePointX - 12, saveInfo.savePointY);
                            ball.setHeight(0);
                            saveTimer = 1.0;
                            return;
                        }

                        if (saveType === SAVE_RESULT.PARRY || saveType === SAVE_RESULT.DEFLECTION) {
                            // 튕겨냄: 공이 골키퍼 앞쪽에서 1초간 이동 후 종료
                            const deflection = gkSave.calculateDeflection(
                                saveType,
                                { x: saveInfo.savePointX, y: saveInfo.savePointY },
                                saveInfo.shotTrajectory,
                            );
                            ball.setPosition(saveInfo.savePointX - 8, saveInfo.savePointY);
                            bm.release(deflection.vx, deflection.vy);
                            saveTimer = 1.0;
                            return;
                        }

                        // 세이브 실패 (골키퍼가 가까이 있지만 쳐내지 못함)
                    }

                    // 골키퍼가 세이브 지점에 도달하지 못함 → 공이 계속 골라인으로 향함
                    saveInfo = null;
                }
            }

            // ShotMovement 업데이트 (공 이동, 골/빗나감 판정)
            shot.update(dt);
            if (shot.result !== null) {
                finish(shot.result);
            }
            return;
        }

        // ── 드리블 중: 골키퍼 위치 조정 ──────────────
        gkTarget = gkMovement.update(
            { x: ball.x, y: ball.y, vx: bm.vx, vy: bm.vy },
            goalkeeper,
        );

        const gkDx = gkTarget.x - goalkeeper.x;
        const gkDy = gkTarget.y - goalkeeper.y;
        const gkDist = Math.hypot(gkDx, gkDy);

        if (gkDist > 1) {
            const gkStep = Math.min(GK_POSITION_SPEED * dt, gkDist);
            goalkeeper.setPosition(
                goalkeeper.x + (gkDx / gkDist) * gkStep,
                goalkeeper.y + (gkDy / gkDist) * gkStep,
            );
        }
        goalkeeper.setAngle(gkTarget.facingAngle);

        // ── 공격수 드리블 ──────────────────────────────
        if (!dc.ballAttached && bm.owner === player) recoverBall();
        pm.update(dt);
        dc.update(dt);
        bm.update(dt);

        if (recovering && dc.ballAttached) {
            recovering = false;
            if (!shootReady && currentWaypoint) {
                if (player.x >= currentWaypoint.x - PlayerMovement.ARRIVAL_RADIUS) {
                    nextDribble();
                } else {
                    pm.clearFacingTarget();
                    pm.moveTo(currentWaypoint.x, currentWaypoint.y, nextDribble);
                }
            }
        }

        if (shootReady && dc.ballAttached) {
            shooting = fireShot();
            if (shooting) shot.update(dt);
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        dc.stop();
        pm.stop();
    };
}
