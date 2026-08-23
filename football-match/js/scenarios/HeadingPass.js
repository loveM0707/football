/**
 * HeadingPass - 헤딩 패스 시나리오
 *
 * 같은 편 두 선수가 20m 거리에서 서 있다.
 * 한 선수는 롱패스를 하고, 다른 선수는 헤딩 패스로 돌려준다.
 * 이 플레이를 반복한다.
 *
 * 흐름:
 *   1. 패서(왼쪽)가 롱패스
 *   2. 헤더(오른쪽)가 공중볼을 추적
 *   3. 헤더가 헤딩 패스로 공을 돌려줌
 *   4. 패서가 공을 받음
 *   5. 다시 1번으로
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { BallMovement } from '../movement/BallMovement.js';
import { PassMovement } from '../movement/PassMovement.js';
import { HeadingSystem } from '../movement/HeadingSystem.js';
import { angleTo, forwardVector } from '../movement/Direction.js';

const CENTER_Y = 340;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const PASSER_X = 300;   // 패서 위치 (왼쪽)
const HEADER_X = 500;    // 헤더 위치 (오른쪽, 20m 거리)
const SPEEDS = PlayerMovement.SPEEDS;

export function run(layer, loop, onComplete = null) {
    // ── 선수 생성 ─────────────────────────────────────
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

    const ball = new Ball(PASSER_X, CENTER_Y).render(layer);
    const passerPm = new PlayerMovement(passer, { driftScale: 0 });
    const headerPm = new PlayerMovement(header, { driftScale: 0 });
    const bm = new BallMovement(ball);
    const headingSystem = new HeadingSystem();

    // ── 상태 머신 ──────────────────────────────────────
    const STATE = {
        INIT: 'init',
        PASS: 'pass',
        BALL_FLIGHT: 'ball_flight',
        HEADER_TRACK: 'header_track',
        HEADER_EXECUTE: 'header_execute',
        RETURN_FLIGHT: 'return_flight',
        RECEIVER_TRACK: 'receiver_track',
        RECEIVE: 'receive',
    };

    let state = STATE.INIT;
    let complete = false;
    let flightTimer = 0;
    let flightDuration = 0;
    let headerAttempted = false;
    let headerResult = null;
    let receiveTimer = 0;
    let repeatCount = 0;
    const MAX_REPEATS = 10; // 최대 반복 횟수

    // 패서 소유 시작
    bm.possess(passer, POSSESS_OFFSET);
    bm.snapToFront();

    // ── 종료 ───────────────────────────────────────────
    function finish(result = null) {
        if (complete) return;
        complete = true;
        passerPm.stop();
        headerPm.stop();
        if (onComplete) onComplete(result);
    }

    // ── 메인 루프 ─────────────────────────────────────
    function tick(dt) {
        if (complete) return;

        switch (state) {
            // ── 초기: 패서가 헤더를 바라보며 정지 ──────
            case STATE.INIT:
                passerPm.setFacingTarget(angleTo(passer.x, passer.y, header.x, header.y));
                state = STATE.PASS;
                break;

            // ── 롱패스 ─────────────────────────────────
            case STATE.PASS:
                // 패서가 헤더에게 롱패스
                const passResult = PassMovement.longPass(bm, header.x, header.y, {
                    flightDuration: 0.8,
                    maxHeight: 1.2,
                });
                flightDuration = passResult.flightDuration;
                flightTimer = 0;
                headerAttempted = false;
                headerResult = null;
                state = STATE.BALL_FLIGHT;
                break;

            // ── 볼 비행 중 (패스) ──────────────────────
            case STATE.BALL_FLIGHT:
                flightTimer += dt;
                bm.update(dt);

                // 헤더가 공을 추적
                if (!headerAttempted) {
                    const landing = headingSystem.predictLandingPoint(ball, bm);
                    if (landing) {
                        const dist = Math.hypot(landing.x - header.x, landing.y - header.y);
                        if (dist > 1) {
                            headerPm.speed = SPEEDS[3];
                            headerPm.setFacingTarget(angleTo(header.x, header.y, landing.x, landing.y));
                            headerPm.moveTo(landing.x, landing.y);
                        }
                    }

                    // 공이 일정 높이 이하로 내려오면 헤딩 시도
                    if (ball.height < 0.4 && ball.height > 0 && !bm.isAerial) {
                        state = STATE.HEADER_EXECUTE;
                    }
                }

                // 착지 시
                if (!bm.isAerial && !bm.isBouncing && flightTimer > flightDuration * 0.8) {
                    state = STATE.HEADER_EXECUTE;
                }
                break;

            // ── 헤딩 실행 ──────────────────────────────
            case STATE.HEADER_EXECUTE:
                headerPm.stop();

                // 헤딩 실행: 패서에게 다시 패스
                headerResult = headingSystem.executeHeader(header, ball, {
                    targetX: passer.x,
                    targetY: passer.y,
                    power: 250,
                    type: 'pass',
                });

                // 공을 헤더 위치로 이동하고 속도 적용
                ball.setPosition(header.x, header.y);
                ball.setHeight(0.5);
                bm.releaseAerial(
                    headerResult.vx,
                    headerResult.vy,
                    0.8,
                    0.8,
                );

                flightTimer = 0;
                flightDuration = 0.8;
                state = STATE.RETURN_FLIGHT;
                break;

            // ── 볼 비행 중 (헤딩 복귀) ────────────────
            case STATE.RETURN_FLIGHT:
                flightTimer += dt;
                bm.update(dt);

                // 패서가 공 추적
                const landing2 = headingSystem.predictLandingPoint(ball, bm);
                if (landing2) {
                    const dist2 = Math.hypot(landing2.x - passer.x, landing2.y - passer.y);
                    if (dist2 > 1) {
                        passerPm.speed = SPEEDS[3];
                        passerPm.setFacingTarget(angleTo(passer.x, passer.y, landing2.x, landing2.y));
                        passerPm.moveTo(landing2.x, landing2.y);
                    }
                }

                // 착지 시
                if (!bm.isAerial && !bm.isBouncing && flightTimer > flightDuration * 0.8) {
                    state = STATE.RECEIVE;
                }
                break;

            // ── 공 수령 ────────────────────────────────
            case STATE.RECEIVE:
                passerPm.stop();

                // 공을 패서에게 소유
                bm.possess(passer, POSSESS_OFFSET);
                bm.snapToFront();

                repeatCount++;

                // 최대 반복 횟수 도달 시 종료
                if (repeatCount >= MAX_REPEATS) {
                    finish('complete');
                    return;
                }

                // 잠시 대기 후 다시 패스
                receiveTimer += dt;
                if (receiveTimer > 0.5) {
                    receiveTimer = 0;
                    state = STATE.PASS;
                }
                break;
        }

        // 플레이어 업데이트
        passerPm.update(dt);
        headerPm.update(dt);
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        passerPm.stop();
        headerPm.stop();
    };
}
