/**
 * HeadingPass - 헤딩 패스 시나리오
 *
 * 같은 편 세 선수가 플레이한다.
 * passer(왼쪽) → header(오른쪽) → teammate(헤더 위 10m) → passer
 * 이 플레이를 반복한다.
 *
 * 흐름:
 *   1. 패서(왼쪽)가 롱패스
 *   2. 헤더(오른쪽)가 공중볼을 추적
 *   3. 헤더가 동료선수(위 10m)에게 헤딩 패스
 *   4. 동료선수가 공을 받음
 *   5. 동료선수가 패서에게 발로 패스
 *   6. 패서가 공을 받음
 *   7. 다시 1번으로
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { BallMovement } from '../movement/BallMovement.js';
import { PassMovement } from '../movement/PassMovement.js';
import { PassReceiver } from '../movement/PassReceiver.js';
import { HeadingSystem } from '../movement/HeadingSystem.js';
import { angleTo, forwardVector } from '../movement/Direction.js';

const CENTER_Y = 340;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const RECEIVE_DIST = POSSESS_OFFSET + 3;
const PASSER_X = 300;
const HEADER_X = 500;
const TEAMMATE_OFFSET_Y = -100; // 동료선수 Y 오프셋 (위 10m = 100단위)
const SPEEDS = PlayerMovement.SPEEDS;

export function run(layer, loop, onComplete = null) {
    const passer = new Player({
        x: PASSER_X,
        y: CENTER_Y,
        team: 'home',
        number: 8,
        angle: -90,
    }).render(layer);

    const header = new Player({
        x: HEADER_X,
        y: CENTER_Y,
        team: 'home',
        number: 9,
        angle: -90,
    }).render(layer);

    const teammate = new Player({
        x: HEADER_X,
        y: CENTER_Y + TEAMMATE_OFFSET_Y,
        team: 'home',
        number: 10,
        angle: -90,
    }).render(layer);

    const ball = new Ball(PASSER_X, CENTER_Y).render(layer);
    const passerPm = new PlayerMovement(passer, { driftScale: 0 });
    const headerPm = new PlayerMovement(header, { driftScale: 0 });
    const teammatePm = new PlayerMovement(teammate, { driftScale: 0 });
    const bm = new BallMovement(ball);
    const headingSystem = new HeadingSystem();
    const passerReceiver = new PassReceiver();

    const STATE = {
        INIT: 'init',
        PASS: 'pass',
        BALL_FLIGHT: 'ball_flight',
        HEADER_EXECUTE: 'header_execute',
        HEADER_FLIGHT: 'header_flight',
        TEAMMATE_RECEIVE: 'teammate_receive',
        TEAMMATE_PASS: 'teammate_pass',
        PASS_FLIGHT: 'pass_flight',
        RECEIVE: 'receive',
    };

    let state = STATE.INIT;
    let complete = false;
    let flightTimer = 0;
    let flightDuration = 0;
    let receiveTimer = 0;
    let repeatCount = 0;
    const MAX_REPEATS = 10;

    bm.possess(passer, POSSESS_OFFSET);
    bm.snapToFront();

    function finish(result = null) {
        if (complete) return;
        complete = true;
        passerPm.stop();
        headerPm.stop();
        teammatePm.stop();
        if (onComplete) onComplete(result);
    }

    function tick(dt) {
        if (complete) return;

        // 매 프레임 모든 선수가 볼을 바라보게
        passerPm.setFacingTarget(angleTo(passer.x, passer.y, ball.x, ball.y));
        headerPm.setFacingTarget(angleTo(header.x, header.y, ball.x, ball.y));
        teammatePm.setFacingTarget(angleTo(teammate.x, teammate.y, ball.x, ball.y));

        switch (state) {
            case STATE.INIT:
                passerPm.setFacingTarget(angleTo(passer.x, passer.y, header.x, header.y));
                state = STATE.PASS;
                break;

            case STATE.PASS: {
                const passResult = PassMovement.longPass(bm, header.x, header.y, {
                    flightDuration: 0.8,
                    maxHeight: 1.2,
                });
                flightDuration = passResult.flightDuration;
                flightTimer = 0;
                state = STATE.BALL_FLIGHT;
                break;
            }

            case STATE.BALL_FLIGHT:
                flightTimer += dt;
                bm.update(dt);

                if (ball.height < 0.4 && ball.height > 0 && !bm.isAerial) {
                    state = STATE.HEADER_EXECUTE;
                }

                if (!bm.isAerial && !bm.isBouncing && flightTimer > flightDuration * 0.8) {
                    state = STATE.HEADER_EXECUTE;
                }
                break;

            case STATE.HEADER_EXECUTE: {
                headerPm.stop();

                const hPower = 160 + Math.random() * 40;

                // 실제 거리에 비례해 비행시간 계산 (공이 목표 근처에 도달하도록)
                const hDist = Math.hypot(teammate.x - header.x, teammate.y - header.y);
                const hFlightDur = hDist / hPower + (Math.random() - 0.5) * 0.1;

                // 방향: 정확한 목표 + 랜덤 편차 (±6도)
                const baseAngle = Math.atan2(teammate.y - header.y, teammate.x - header.x);
                const deviationRad = (Math.random() - 0.5) * 12 * Math.PI / 180;
                const finalAngle = baseAngle + deviationRad;
                const vx = Math.cos(finalAngle) * hPower;
                const vy = Math.sin(finalAngle) * hPower;

                ball.setPosition(header.x, header.y);
                ball.setHeight(0.5);

                const hMaxHeight = 0.4 + Math.random() * 0.3;
                bm.releaseAerial(vx, vy, hFlightDur, hMaxHeight);

                flightTimer = 0;
                flightDuration = hFlightDur;
                state = STATE.HEADER_FLIGHT;
                break;
            }

            case STATE.HEADER_FLIGHT:
                flightTimer += dt;
                bm.update(dt);

                {
                    const landing = headingSystem.predictLandingPoint(ball, bm);
                    if (landing) {
                        const dist = Math.hypot(landing.x - teammate.x, landing.y - teammate.y);
                        if (dist > 1) {
                            teammatePm.speed = SPEEDS[3];
                            teammatePm.setFacingTarget(angleTo(teammate.x, teammate.y, landing.x, landing.y));
                            teammatePm.moveTo(landing.x, landing.y);
                        }
                    }
                }

                if (!bm.isAerial && !bm.isBouncing && flightTimer > flightDuration * 0.8) {
                    state = STATE.TEAMMATE_RECEIVE;
                }
                break;

            case STATE.TEAMMATE_RECEIVE:
                teammatePm.stop();
                bm.possess(teammate, POSSESS_OFFSET);
                bm.snapToFront();
                teammatePm.setFacingTarget(angleTo(teammate.x, teammate.y, passer.x, passer.y));

                receiveTimer += dt;
                if (receiveTimer > 0.3) {
                    receiveTimer = 0;
                    state = STATE.TEAMMATE_PASS;
                }
                break;

            case STATE.TEAMMATE_PASS: {
                teammatePm.stop();

                const passResult2 = PassMovement.shortPass(bm, passer.x, passer.y, {
                    arriveSpeed: 120,
                });

                passerReceiver.arm();
                flightTimer = 0;
                flightDuration = passResult2.timeToArrive;
                state = STATE.PASS_FLIGHT;
                break;
            }

            case STATE.PASS_FLIGHT:
                flightTimer += dt;
                bm.update(dt);

                passerPm.setFacingTarget(angleTo(passer.x, passer.y, ball.x, ball.y));
                passerReceiver.update(dt, passer, () => PassMovement.interceptPoint(bm, passer));

                {
                    const dist = Math.hypot(passer.x - ball.x, passer.y - ball.y);
                    if (dist < RECEIVE_DIST) {
                        state = STATE.RECEIVE;
                    }
                }

                if (flightTimer > flightDuration * 1.5) {
                    state = STATE.RECEIVE;
                }
                break;

            case STATE.RECEIVE:
                passerPm.stop();
                passerReceiver.reset();
                bm.possess(passer, POSSESS_OFFSET);
                bm.snapToFront();

                repeatCount++;
                if (repeatCount >= MAX_REPEATS) {
                    finish('complete');
                    return;
                }

                receiveTimer += dt;
                if (receiveTimer > 0.5) {
                    receiveTimer = 0;
                    state = STATE.PASS;
                }
                break;
        }

        passerPm.update(dt);
        headerPm.update(dt);
        teammatePm.update(dt);
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        passerPm.stop();
        headerPm.stop();
        teammatePm.stop();
    };
}
