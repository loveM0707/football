/**
 * CrossHeader - 크로스-헤딩 시나리오
 *
 * 흐름:
 *   1. 미드필더(하프라인 전방 10m 위쪽 10m)가 오른쪽 측면으로 스루패스
 *   2. 윙어(하프라인 전방 10m 오른쪽 20m)가 볼을 받고 측면 끝까지 달림
 *   3. 윙어가 페널티 에어리어로 크로스 올림
 *   4. 스트라이커(하프라인 전방 10m 가운데)가 페널티 에어리어로 침투
 *   5. 스트라이커가 헤딩슛 → 골키퍼 세이브 판정
 *   6. 결과 표시 → 반복
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { BallMovement } from '../movement/BallMovement.js';
import { PassMovement } from '../movement/PassMovement.js';
import { ThroughPass } from '../movement/ThroughPass.js';
import { ShotMovement } from '../movement/ShotMovement.js';
import { GoalkeeperSave, SAVE_RESULT } from '../movement/GoalkeeperSave.js';
import { GoalkeeperMovement } from '../movement/GoalkeeperMovement.js';
import { HeadingSystem } from '../movement/HeadingSystem.js';
import { HeadingShot } from '../movement/HeadingShot.js';
import { BallReception } from '../movement/BallReception.js';
import { angleTo, forwardVector } from '../movement/Direction.js';

const FIELD_HEIGHT = 680;
const CENTER_Y = FIELD_HEIGHT / 2;
const CENTER_X = 525;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const GOAL_X = 1050;
const GOAL_TOP_Y = 303.4;
const GOAL_BOTTOM_Y = 376.6;

// 100 SVG = 10m
const MF_X     = CENTER_X + 100;   // 하프라인 전방 10m
const MF_Y     = CENTER_Y - 100;   // 위쪽 10m

const WINGER_X = CENTER_X + 100;   // 하프라인 전방 10m
const WINGER_Y = CENTER_Y - 200;   // 오른쪽 20m

const STRIKER_X = CENTER_X + 100;  // 하프라인 전방 10m
const STRIKER_Y = CENTER_Y;        // 가운데

// 스루패스 목표: 윙어의 오른쪽前方 공간
const PASS_TARGET_X = WINGER_X + 200;
const PASS_TARGET_Y = WINGER_Y;

// 크로스 위치 (측면 끝)
const CROSS_X = 1000;

// 골키퍼
const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;
const GK_DIVE_SPEED = 450;
const GK_REACTION_TIME = 0.12;

const SPEEDS = PlayerMovement.SPEEDS;

const RESULT_LABELS = {
    goal: '골', save: '세이브',
    'miss-wide': '노골 · 옆으로 빗나감', 'miss-high': '노골 · 골대 위',
    post: '골대 맞음', crossbar: '크로스바 맞음', complete: '완료',
};

const STATE = {
    READY: 'ready',
    THROUGH_PASS: 'through_pass',
    WINGER_DRIBBLE: 'winger_dribble',
    BALL_FLIGHT: 'ball_flight',
    HEADER_EXECUTE: 'header_execute',
    SHOT_FLIGHT: 'shot_flight',
};

export function run(layer, loop, onComplete = null) {
    const resultEl = document.getElementById('match-result');

    const midfielder = new Player({
        x: MF_X, y: MF_Y, team: 'home', number: 10, angle: -90,
    }).render(layer);

    const winger = new Player({
        x: WINGER_X, y: WINGER_Y, team: 'home', number: 7, angle: -90,
    }).render(layer);

    const striker = new Player({
        x: STRIKER_X, y: STRIKER_Y, team: 'home', number: 9, angle: -90,
    }).render(layer);

    const goalkeeper = new Player({
        x: GK_START_X, y: GK_START_Y, team: 'away', number: 1, angle: 90,
    }).render(layer);

    const ball = new Ball(MF_X, MF_Y).render(layer);
    const bm = new BallMovement(ball);
    const mfPM = new PlayerMovement(midfielder, { driftScale: 0 });
    const wingerPM = new PlayerMovement(winger, { driftScale: 0 });
    const strikerPM = new PlayerMovement(striker, { driftScale: 0 });
    // 시나리오는 위치와 기본 지시만 담당 — 움직임은 모듈이 처리한다.
    const throughPass = new ThroughPass({
        leadDistance: 200,
        arriveSpeed: 110,
        maxDeviationDeg: 1,
    });
    // 7번 윙어 수령 — 모듈 기본값으로 트래핑 판정 (멀리서 달라붙지 않음)
    const wingerReception = new BallReception(winger, wingerPM, bm);

    const headingSystem = new HeadingSystem();
    const headingShot = new HeadingShot();
    const shot = new ShotMovement({ goalX: GOAL_X });

    const gkMovement = new GoalkeeperMovement({
        goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y,
    });
    const gkSave = new GoalkeeperSave({
        goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y,
        skill: 0.65, diveSpeed: GK_DIVE_SPEED,
    });

    let state = STATE.READY;
    let complete = false;
    let repeatCount = 0;
    const MAX_REPEATS = 10;
    let shotResult = null;
    let saveTimer = 0;
    let resultTimeout = null;
    let saveInfo = null;
    let gkDiving = false;
    let gkReactionTimer = 0;
    let gkDiveTargetX = 0;
    let gkDiveTargetY = 0;
    let passPlayed = false;
    let readyTimer = 0;
    let crossFired = false;

    bm.possess(midfielder, POSSESS_OFFSET);
    bm.snapToFront();

    function finish(result = null) {
        if (complete) return;
        complete = true;
        if (resultTimeout !== null) { clearTimeout(resultTimeout); resultTimeout = null; }
        wingerReception.stop();
        mfPM.stop(); wingerPM.stop(); strikerPM.stop();
        if (onComplete) onComplete(result);
    }

    function showResult(labelKey) {
        const label = RESULT_LABELS[labelKey];
        if (!label) return;
        resultEl.textContent = label;
        resultEl.dataset.visible = '';
        if (resultTimeout !== null) clearTimeout(resultTimeout);
        resultTimeout = setTimeout(() => {
            resultEl.textContent = '';
            delete resultEl.dataset.visible;
            resultTimeout = null;
        }, 1500);
    }

    function resetScenario() {
        if (resultTimeout !== null) { clearTimeout(resultTimeout); resultTimeout = null; }
        resultEl.textContent = '';
        delete resultEl.dataset.visible;

        while (layer.firstChild) layer.removeChild(layer.firstChild);
        midfielder.render(layer); winger.render(layer);
        striker.render(layer); goalkeeper.render(layer); ball.render(layer);

        midfielder.x = MF_X; midfielder.y = MF_Y; midfielder.setAngle(-90);
        winger.x = WINGER_X; winger.y = WINGER_Y + (Math.random() - 0.5) * 30;
        winger.setAngle(-90);
        striker.x = STRIKER_X; striker.y = STRIKER_Y + (Math.random() - 0.5) * 40;
        striker.setAngle(-90);
        goalkeeper.x = GK_START_X; goalkeeper.y = GK_START_Y; goalkeeper.setAngle(90);

        bm.possess(midfielder, POSSESS_OFFSET);
        bm.snapToFront();
        wingerReception.stop();

        shotResult = null; saveTimer = 0; saveInfo = null;
        gkDiving = false; gkReactionTimer = 0;
        passPlayed = false; crossFired = false; readyTimer = 0;
        shot._phase = 'idle'; shot._result = null;
        state = STATE.READY;
    }

    function tick(dt) {
        if (complete) return;

        // 골키퍼
        const gkTarget = gkMovement.update(
            { x: ball.x, y: ball.y, vx: bm.vx, vy: bm.vy }, goalkeeper,
        );
        const gkDx = gkTarget.x - goalkeeper.x;
        const gkDy = gkTarget.y - goalkeeper.y;
        const gkDist = Math.hypot(gkDx, gkDy);
        if (gkDist > 1) {
            const s = Math.min(350 * dt, gkDist);
            goalkeeper.setPosition(
                goalkeeper.x + (gkDx / gkDist) * s,
                goalkeeper.y + (gkDy / gkDist) * s,
            );
        }
        goalkeeper.setAngle(gkTarget.facingAngle);

        if (saveTimer > 0) {
            saveTimer -= dt;
            if (saveTimer <= 0) {
                repeatCount++;
                if (repeatCount >= MAX_REPEATS) { finish(shotResult || 'complete'); return; }
                resetScenario();
            }
            return;
        }

        // 슈팅 비행 중
        if (state === STATE.SHOT_FLIGHT) {
            if (gkReactionTimer > 0) gkReactionTimer -= dt;
            if (gkDiving && gkReactionTimer <= 0) {
                const dx = gkDiveTargetX - goalkeeper.x;
                const dy = gkDiveTargetY - goalkeeper.y;
                const d = Math.hypot(dx, dy);
                if (d > 1) {
                    const step = Math.min(GK_DIVE_SPEED * dt, d);
                    goalkeeper.setPosition(
                        goalkeeper.x + (dx / d) * step,
                        goalkeeper.y + (dy / d) * step,
                    );
                }
                goalkeeper.setAngle(90);
            }

            if (saveInfo && !saveInfo.intercepted && ball.x >= saveInfo.savePointX - 5) {
                saveInfo.intercepted = true;
                const gd = Math.hypot(
                    goalkeeper.x - saveInfo.savePointX,
                    goalkeeper.y - saveInfo.savePointY,
                );
                if (gd < gkSave.reachRadius) {
                    const st = gkSave.determineSaveType(
                        saveInfo.shotTrajectory, goalkeeper,
                        { x: saveInfo.savePointX, y: saveInfo.savePointY },
                    );
                    if (st !== SAVE_RESULT.GOAL) {
                        if (st === SAVE_RESULT.CATCH) {
                            ball.setPosition(saveInfo.savePointX - 12, saveInfo.savePointY);
                            ball.setHeight(0);
                        } else {
                            const df = gkSave.calculateDeflection(st,
                                { x: saveInfo.savePointX, y: saveInfo.savePointY },
                                saveInfo.shotTrajectory);
                            ball.setPosition(saveInfo.savePointX - 8, saveInfo.savePointY);
                            bm.release(df.vx, df.vy);
                        }
                        shotResult = 'save'; repeatCount++; showResult('save');
                        if (repeatCount >= MAX_REPEATS) { finish('save'); return; }
                        saveTimer = 1.5; return;
                    }
                }
                saveInfo = null;
            }

            shot.update(dt);
            if (shot.result !== null) {
                shotResult = shot.result; repeatCount++; showResult(shot.result);
                if (repeatCount >= MAX_REPEATS) { finish(shot.result); return; }
                saveTimer = 1.5;
            }
            return;
        }

        // ── 상태 처리 ──────────────────────────────────
        switch (state) {
            case STATE.READY: {
                readyTimer += dt;
                if (readyTimer >= 0.3) {
                    // 기본 지시: 10번 선수는 7번 선수에게 스루패스
                    const tpTarget = throughPass.targetSpace({
                        runner: winger,
                        direction: forwardVector(winger.angle),
                        runnerSpeed: SPEEDS[4],
                    });
                    midfielder.setAngle(angleTo(midfielder.x, midfielder.y, tpTarget.x, tpTarget.y));
                    bm.snapToFront();
                    throughPass.play(bm, {
                        runner: winger,
                        direction: forwardVector(winger.angle),
                        runnerSpeed: SPEEDS[4],
                    });
                    passPlayed = true;

                    // 기본 지시: 7번 선수는 왼쪽 측면 침투해서 스루패스를 받음 — 모듈이 침투 런·추적·트래핑 처리
                    wingerReception.start({
                        runTargetX: tpTarget.x,
                        runTargetY: tpTarget.y,
                    });

                    // 기본 지시: 9번 선수는 정면으로 침투
                    strikerPM.speed = SPEEDS[3];
                    strikerPM.moveTo(900, CENTER_Y + (Math.random() - 0.5) * 100);

                    state = STATE.THROUGH_PASS;
                }
                break;
            }

            case STATE.THROUGH_PASS: {
                // 모듈이 침투 런·추적·트래핑을 처리 — 시나리오는 상태 전환만 담당
                wingerReception.update(dt);
                strikerPM.update(dt);
                bm.update(dt);

                // 모듈이 트래핑을 완료하면 7번은 돌파 후 크로스 위치로 이동 (기본 지시)
                if (wingerReception.received) {
                    // 전력질주 — 드리블 킥 리듬은 모듈(BallReception 내부 DribbleController)이 처리
                    wingerPM.speed = SPEEDS[4];
                    wingerPM.moveTo(CROSS_X, winger.y);
                    state = STATE.WINGER_DRIBBLE;
                }
                break;
            }

            case STATE.WINGER_DRIBBLE: {
                // 드리블은 모듈이 킥 리듬으로 처리 — 시나리오는 위치만 지시
                wingerReception.update(dt);
                bm.update(dt);

                if (winger.x >= 970 && !crossFired) {
                    crossFired = true;

                    // 크로스: 랜덤 세기·각도·높이 — 매번 다른 궤적
                    const crossLandX = 900 + Math.random() * 80;
                    const crossLandY = CENTER_Y + (Math.random() - 0.5) * 160;
                    const crossDuration = 0.8 + Math.random() * 0.6;
                    const crossHeight = 0.8 + Math.random() * 0.6;
                    const crossDeviation = (Math.random() - 0.5) * 8 * Math.PI / 180;

                    PassMovement.longPass(bm, crossLandX, crossLandY, {
                        flightDuration: crossDuration,
                        maxHeight: crossHeight,
                        deviationRad: crossDeviation,
                    });

                    state = STATE.BALL_FLIGHT;
                }
                break;
            }

            case STATE.BALL_FLIGHT: {
                bm.update(dt);
                strikerPM.update(dt);

                const landing = headingSystem.predictLandingPoint(ball, bm);
                if (landing) {
                    const d = Math.hypot(landing.x - striker.x, landing.y - striker.y);
                    if (d > 5) {
                        strikerPM.speed = SPEEDS[4];
                        strikerPM.moveTo(landing.x, landing.y);
                    } else {
                        strikerPM.stop();
                    }
                }

                if (!bm.isAerial && !bm.isBouncing) {
                    state = STATE.HEADER_EXECUTE;
                }
                break;
            }

            case STATE.HEADER_EXECUTE: {
                strikerPM.stop();
                striker.x = ball.x; striker.y = ball.y;
                striker.setAngle(angleTo(striker.x, striker.y, GOAL_X, CENTER_Y));

                bm.possess(striker, POSSESS_OFFSET);
                bm.snapToFront();
                ball.setHeight(0.3);

                const sr = headingShot.execute(striker, ball, {
                    goalX: GOAL_X, incomingSpeed: 200, incomingHeight: 0.8, headerSkill: 0.5,
                });

                const fired = shot.shoot(bm, {
                    targetY: sr.finalTargetY, targetHeight: sr.maxHeight * 3,
                    arcHeight: sr.maxHeight * 0.5, speed: sr.power,
                });

                if (!fired) {
                    repeatCount++; showResult('complete');
                    if (repeatCount >= MAX_REPEATS) { finish('complete'); return; }
                    saveTimer = 0.5; return;
                }

                const onTarget = sr.finalTargetY >= GOAL_TOP_Y && sr.finalTargetY <= GOAL_BOTTOM_Y;
                if (onTarget) {
                    const traj = headingShot.getShotTrajectory(striker, sr);
                    const ev = gkSave.evaluateSave(traj, goalkeeper);
                    const cpX = Math.min(ev.savePointX, GOAL_X - 15);
                    saveInfo = {
                        shotTrajectory: traj, savePointX: cpX, savePointY: ev.savePointY,
                        canSave: ev.canSave, decidedResult: ev.result,
                    };
                    gkReactionTimer = GK_REACTION_TIME;
                    gkDiving = true; gkDiveTargetX = cpX; gkDiveTargetY = ev.savePointY;
                } else {
                    saveInfo = null; gkDiving = false;
                }

                shot.update(dt);
                state = STATE.SHOT_FLIGHT;
                break;
            }
        }

        mfPM.update(dt); wingerPM.update(dt); strikerPM.update(dt);
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        mfPM.stop(); wingerPM.stop(); strikerPM.stop();
    };
}
