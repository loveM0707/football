/**
 * HeadingShot - 헤딩슛 시나리오
 *
 * 측면 윙어(오른쪽)가 크로스 → 스트라이커(페널티 에어리어 안)가 헤딩슛
 * 크로스는 정확하지 않아서 스트라이커가 이동해야 하며,
 * 이동 거리와 위치에 따라 헤딩 슛의 강도·방향이 달라진다.
 *
 * 흐름:
 *   1. 윙어가 크로스(롱패스, 랜덤 편차)
 *   2. 스트라이커가 공이 떨어지는 위치로 이동
 *   3. 스트라이커가 헤딩슛 실행
 *   4. 골키퍼 세이브 판정
 *   5. 골/빗나감/세이브 결과
 *   6. 반복
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { BallMovement } from '../movement/BallMovement.js';
import { PassMovement } from '../movement/PassMovement.js';
import { ShotMovement } from '../movement/ShotMovement.js';
import { GoalkeeperSave, SAVE_RESULT } from '../movement/GoalkeeperSave.js';
import { GoalkeeperMovement } from '../movement/GoalkeeperMovement.js';
import { HeadingSystem } from '../movement/HeadingSystem.js';
import { HeadingShot } from '../movement/HeadingShot.js';
import { angleTo } from '../movement/Direction.js';

const FIELD_HEIGHT = 680;
const CENTER_Y = FIELD_HEIGHT / 2;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const GOAL_X = 1050;
const GOAL_TOP_Y = 303.4;
const GOAL_BOTTOM_Y = 376.6;

// 윙어 위치 (오른쪽 측면)
const WINGER_X = 750;
const WINGER_Y_MIN = 100;
const WINGER_Y_MAX = 250;

// 스트라이커 시작 위치 (페널티 에어리어 안)
const STRIKER_HOME_X = 920;
const STRIKER_HOME_Y = CENTER_Y;

// 골키퍼 설정
const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;
const GK_DIVE_SPEED = 450;
const GK_REACTION_TIME = 0.12;

// 크로스 정확도 (편차 범위, 도)
const CROSS_DEVIATION_MIN = 10;
const CROSS_DEVIATION_MAX = 25;

const SPEEDS = PlayerMovement.SPEEDS;

export function run(layer, loop, onComplete = null) {
    // ── 윙어 (크로스하는 선수) ────────────────────────
    const winger = new Player({
        x: WINGER_X,
        y: CENTER_Y,
        team: 'home',
        number: 7,
        angle: -90,
    }).render(layer);

    // ── 스트라이커 (헤딩슛하는 선수) ──────────────────
    const striker = new Player({
        x: STRIKER_HOME_X,
        y: STRIKER_HOME_Y,
        team: 'home',
        number: 9,
        angle: -90,
    }).render(layer);

    // ── 골키퍼 ────────────────────────────────────────
    const goalkeeper = new Player({
        x: GK_START_X,
        y: GK_START_Y,
        team: 'away',
        number: 1,
        angle: 90,
    }).render(layer);

    const ball = new Ball(WINGER_X, CENTER_Y).render(layer);
    const wingerPm = new PlayerMovement(winger, { driftScale: 0 });
    const strikerPm = new PlayerMovement(striker, { driftScale: 0 });
    const bm = new BallMovement(ball);
    const headingSystem = new HeadingSystem();
    const headingShot = new HeadingShot();
    const shot = new ShotMovement({ goalX: GOAL_X });

    // 골키퍼 시스템
    const gkMovement = new GoalkeeperMovement({
        goalX: GOAL_X,
        goalTopY: GOAL_TOP_Y,
        goalBottomY: GOAL_BOTTOM_Y,
    });
    const gkSave = new GoalkeeperSave({
        goalX: GOAL_X,
        goalTopY: GOAL_TOP_Y,
        goalBottomY: GOAL_BOTTOM_Y,
        skill: 0.65,
        diveSpeed: GK_DIVE_SPEED,
    });

    // ── 상태 머신 ──────────────────────────────────────
    const STATE = {
        INIT: 'init',
        CROSS: 'cross',
        BALL_FLIGHT: 'ball_flight',
        HEADER_EXECUTE: 'header_execute',
        SHOT_FLIGHT: 'shot_flight',
    };

    let state = STATE.INIT;
    let complete = false;
    let flightTimer = 0;
    let flightDuration = 0;
    let repeatCount = 0;
    let shotResult = null;
    const MAX_REPEATS = 10;

    // 골키퍼 다이브 상태
    let gkDiving = false;
    let gkReactionTimer = 0;
    let gkDiveTargetX = 0;
    let gkDiveTargetY = 0;
    let saveInfo = null;
    let saveTimer = 0;

    // 크로스 결과 위치
    let crossLandX = STRIKER_HOME_X;
    let crossLandY = CENTER_Y;

    // 크로스 시점의 볼 수평 속도 저장 (heading power 계산에 사용)
    let crossSpeed = 200;

    // 윙어 소유 시작
    bm.possess(winger, POSSESS_OFFSET);
    bm.snapToFront();

    // ── 종료 ───────────────────────────────────────────
    function finish(result = null) {
        if (complete) return;
        complete = true;
        wingerPm.stop();
        strikerPm.stop();
        if (onComplete) onComplete(result);
    }

    // ── 시나리오 리셋 ─────────────────────────────────
    function resetScenario() {
        while (layer.firstChild) layer.removeChild(layer.firstChild);

        winger.render(layer);
        striker.render(layer);
        goalkeeper.render(layer);
        ball.render(layer);

        const wingerY = WINGER_Y_MIN + Math.random() * (WINGER_Y_MAX - WINGER_Y_MIN);
        winger.x = WINGER_X;
        winger.y = wingerY;
        winger.setAngle(-90);

        striker.x = STRIKER_HOME_X + (Math.random() - 0.5) * 40;
        striker.y = STRIKER_HOME_Y + (Math.random() - 0.5) * 60;
        striker.setAngle(-90);

        goalkeeper.x = GK_START_X;
        goalkeeper.y = GK_START_Y;
        goalkeeper.setAngle(90);

        bm.possess(winger, POSSESS_OFFSET);
        bm.snapToFront();

        shotResult = null;
        gkDiving = false;
        gkReactionTimer = 0;
        saveInfo = null;
        saveTimer = 0;
        flightTimer = 0;
        shot._phase = 'idle';
        shot._result = null;

        state = STATE.CROSS;
    }

    // ── 메인 루프 ─────────────────────────────────────
    function tick(dt) {
        if (complete) return;

        // 매 프레임 모든 선수가 볼을 바라보게
        wingerPm.setFacingTarget(angleTo(winger.x, winger.y, ball.x, ball.y));
        strikerPm.setFacingTarget(angleTo(striker.x, striker.y, ball.x, ball.y));

        // 골키퍼 위치 조정
        const gkTarget = gkMovement.update(
            { x: ball.x, y: ball.y, vx: bm.vx, vy: bm.vy },
            goalkeeper,
        );
        const gkDx = gkTarget.x - goalkeeper.x;
        const gkDy = gkTarget.y - goalkeeper.y;
        const gkDist = Math.hypot(gkDx, gkDy);
        if (gkDist > 1) {
            const gkStep = Math.min(350 * dt, gkDist);
            goalkeeper.setPosition(
                goalkeeper.x + (gkDx / gkDist) * gkStep,
                goalkeeper.y + (gkDy / gkDist) * gkStep,
            );
        }
        goalkeeper.setAngle(gkTarget.facingAngle);

        // 세이브 후 대기
        if (saveTimer > 0) {
            saveTimer -= dt;
            bm.update(dt);
            if (saveTimer <= 0) {
                repeatCount++;
                if (repeatCount >= MAX_REPEATS) {
                    finish(shotResult || 'complete');
                    return;
                }
                resetScenario();
            }
            return;
        }

        // 슈팅 비행 중
        if (state === STATE.SHOT_FLIGHT) {
            if (gkReactionTimer > 0) {
                gkReactionTimer -= dt;
            }

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
                goalkeeper.setAngle(90);
            }

            // 세이브 판정
            if (saveInfo && !saveInfo.intercepted) {
                if (ball.x >= saveInfo.savePointX - 5) {
                    saveInfo.intercepted = true;
                    const gkDistToSave = Math.hypot(
                        goalkeeper.x - saveInfo.savePointX,
                        goalkeeper.y - saveInfo.savePointY,
                    );

                    if (gkDistToSave < gkSave.reachRadius) {
                        const saveType = gkSave.determineSaveType(
                            saveInfo.shotTrajectory,
                            goalkeeper,
                            { x: saveInfo.savePointX, y: saveInfo.savePointY },
                        );

                        if (saveType === SAVE_RESULT.CATCH) {
                            ball.setPosition(saveInfo.savePointX - 12, saveInfo.savePointY);
                            ball.setHeight(0);
                            shotResult = 'save';
                            saveTimer = 1.0;
                            return;
                        }

                        if (saveType === SAVE_RESULT.PARRY || saveType === SAVE_RESULT.DEFLECTION) {
                            const deflection = gkSave.calculateDeflection(
                                saveType,
                                { x: saveInfo.savePointX, y: saveInfo.savePointY },
                                saveInfo.shotTrajectory,
                            );
                            ball.setPosition(saveInfo.savePointX - 8, saveInfo.savePointY);
                            bm.release(deflection.vx, deflection.vy);
                            shotResult = 'save';
                            saveTimer = 1.0;
                            return;
                        }
                    }

                    saveInfo = null;
                }
            }

            shot.update(dt);
            if (shot.result !== null) {
                shotResult = shot.result;
                repeatCount++;
                if (repeatCount >= MAX_REPEATS) {
                    finish(shot.result);
                    return;
                }
                saveTimer = 1.5;
            }
            return;
        }

        // ── 상태 처리 ──────────────────────────────────
        switch (state) {
            case STATE.CROSS: {
                // 스트라이커 위치 설정
                striker.x = STRIKER_HOME_X + (Math.random() - 0.5) * 40;
                striker.y = STRIKER_HOME_Y + (Math.random() - 0.5) * 60;

                // 크로스 목표: 스트라이커 근처 + 랜덤 편차
                const crossDeviationDeg = CROSS_DEVIATION_MIN
                    + Math.random() * (CROSS_DEVIATION_MAX - CROSS_DEVIATION_MIN);
                const crossDeviationRad = (Math.random() - 0.5) * 2
                    * crossDeviationDeg * Math.PI / 180;

                crossLandX = striker.x + (Math.random() - 0.5) * 60;
                crossLandY = striker.y + crossDeviationRad * 40;

                // 페널티 에어리어 범위 제한
                crossLandX = Math.max(890, Math.min(1020, crossLandX));
                crossLandY = Math.max(150, Math.min(530, crossLandY));

                // 윙어가 크로스 방향 바라보기
                wingerPm.setFacingTarget(
                    angleTo(winger.x, winger.y, crossLandX, crossLandY),
                );

                // 크로스 발사 — releaseAerial 전에 미리 속도 계산
                const dx = crossLandX - winger.x;
                const dy = crossLandY - winger.y;
                const dist = Math.hypot(dx, dy);
                const hFlightDur = 1.0 + Math.random() * 0.3;
                crossSpeed = dist / hFlightDur;

                PassMovement.longPass(bm, crossLandX, crossLandY, {
                    flightDuration: hFlightDur,
                    maxHeight: 1.0 + Math.random() * 0.4,
                });
                flightDuration = hFlightDur;
                flightTimer = 0;
                state = STATE.BALL_FLIGHT;
                break;
            }

            case STATE.BALL_FLIGHT:
                flightTimer += dt;
                bm.update(dt);

                // 스트라이커가 착지점으로 이동
                const landing = headingSystem.predictLandingPoint(ball, bm);
                if (landing) {
                    const dist = Math.hypot(landing.x - striker.x, landing.y - striker.y);
                    if (dist > 5) {
                        strikerPm.speed = SPEEDS[4];
                        strikerPm.setFacingTarget(
                            angleTo(striker.x, striker.y, landing.x, landing.y),
                        );
                        strikerPm.moveTo(landing.x, landing.y);
                    } else {
                        strikerPm.stop();
                    }
                }

                // 공이 착지했으면 헤딩 실행
                if (!bm.isAerial && !bm.isBouncing) {
                    state = STATE.HEADER_EXECUTE;
                }
                break;

            case STATE.HEADER_EXECUTE: {
                strikerPm.stop();

                // 스트라이커를 공 위치로 이동
                striker.x = ball.x;
                striker.y = ball.y;

                // 공을 스트라이커에게 소유
                bm.possess(striker, POSSESS_OFFSET);
                bm.snapToFront();
                ball.setHeight(0.3);

                // 스트라이커 위치에 따른 보정
                const distToGoal = Math.hypot(GOAL_X - striker.x, CENTER_Y - striker.y);
                const positionPenalty = Math.min(1, distToGoal / 200);

                // 헤딩슛 실행
                const shotResult2 = headingShot.execute(striker, ball, {
                    goalX: GOAL_X,
                    incomingSpeed: crossSpeed,
                    incomingHeight: 0.8,
                    headerSkill: 0.5 - positionPenalty * 0.2,
                });

                // ShotMovement로 슈팅 시작
                const fired = shot.shoot(bm, {
                    targetY: shotResult2.finalTargetY,
                    targetHeight: shotResult2.maxHeight * 3,
                    arcHeight: shotResult2.maxHeight * 0.5,
                    speed: shotResult2.power,
                });

                if (!fired) {
                    // 슈팅 실패 시 즉시 리셋 (무한루프 방지)
                    repeatCount++;
                    if (repeatCount >= MAX_REPEATS) {
                        finish('complete');
                        return;
                    }
                    saveTimer = 0.5;
                    return;
                }

                // 골키퍼 세이브 판정
                const isOnTarget = shotResult2.finalTargetY >= GOAL_TOP_Y
                    && shotResult2.finalTargetY <= GOAL_BOTTOM_Y;

                if (isOnTarget) {
                    const shotTrajectory = headingShot.getShotTrajectory(striker, shotResult2);
                    const evaluation = gkSave.evaluateSave(shotTrajectory, goalkeeper);

                    const cappedSavePointX = Math.min(evaluation.savePointX, GOAL_X - 15);

                    saveInfo = {
                        shotTrajectory,
                        savePointX: cappedSavePointX,
                        savePointY: evaluation.savePointY,
                        canSave: evaluation.canSave,
                        decidedResult: evaluation.result,
                    };

                    gkReactionTimer = GK_REACTION_TIME;
                    gkDiving = true;
                    gkDiveTargetX = cappedSavePointX;
                    gkDiveTargetY = evaluation.savePointY;
                } else {
                    saveInfo = null;
                    gkDiving = false;
                }

                shot.update(dt);
                state = STATE.SHOT_FLIGHT;
                break;
            }
        }

        wingerPm.update(dt);
        strikerPm.update(dt);
    }

    // 첫 크로스를 위해 윙어 위치 설정
    const initWingerY = WINGER_Y_MIN + Math.random() * (WINGER_Y_MAX - WINGER_Y_MIN);
    winger.y = initWingerY;
    bm.possess(winger, POSSESS_OFFSET);
    bm.snapToFront();

    state = STATE.CROSS;

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        wingerPm.stop();
        strikerPm.stop();
    };
}
