/**
 * LobbedThroughPass - 측면 침투 선수에게 보내는 로빙 스루패스
 *
 * 10번은 오른쪽 골대를 향해 수비를 피하며 전진하고, 9번은 오른쪽
 * 측면으로 침투한다. 수비수와 9번의 X축이 가까워지면 9번의 앞 공간으로
 * 공중 패스를 보내 9번이 받아 공격을 완성한다.
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { BallMovement } from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { BallReception } from '../movement/BallReception.js';
import { CollisionSystem } from '../movement/CollisionSystem.js';
import { CooperativeDefenseAI } from '../movement/CooperativeDefenseAI.js';
import { LobbedThroughPass } from '../movement/LobbedThroughPass.js';
import { PassIntent } from '../movement/PassIntent.js';
import { PassAccuracy } from '../movement/PassAccuracy.js';
import { angleTo } from '../movement/Direction.js';
import { CENTER_Y, HALF_LINE_X } from '../movement/FieldGeometry.js';
const END_LINE_X = 1040;
const HOLDER_START_X = 425;
const RUNNER_START_X = 425;
const RUNNER_START_Y = CENTER_Y + 300;
const HOLDER_TARGET_X = END_LINE_X - 60;
const RUNNER_TARGET_X = END_LINE_X - 10;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const RUNNER_SPEED = PlayerMovement.SPEEDS[4];
const LINE_TOLERANCE = 18;
const RECEIVE_DRIBBLE_DISTANCE = 100;

// 필드 스케일: 10 SVG = 1m (1050×680 = 105m×68m), 하프라인 525
const METER_TO_SVG = 10;

export function run(layer, loop, onComplete = null) {
    const defenderStartX = HALF_LINE_X + (20 + Math.random() * 10) * METER_TO_SVG;
    const defenderStartY = CENTER_Y + (Math.random() * 40 - 20) * METER_TO_SVG;
    const holder = new Player({ x: HOLDER_START_X, y: CENTER_Y, team: 'home', number: 10, angle: -90 }).render(layer);
    const runner = new Player({ x: RUNNER_START_X, y: RUNNER_START_Y, team: 'home', number: 9, angle: -90 }).render(layer);
    const defender = new Player({ x: defenderStartX, y: defenderStartY, team: 'away', number: 4, angle: 90 }).render(layer);
    const ball = new Ball(holder.x, holder.y).render(layer);

    const holderPM = new PlayerMovement(holder, { turnBeforeMove: false, maxVel: 360 });
    const runnerPM = new PlayerMovement(runner, { turnBeforeMove: false, maxVel: 360, speed: RUNNER_SPEED });
    const defenderPM = new PlayerMovement(defender);
    const bm = new BallMovement(ball);
    const dribble = new DribbleController(holderPM, bm);
    const runnerReception = new BallReception(runner, runnerPM, bm);
    // 단일 수비수도 협력수비 PRESS로 운용한다 (골사이드 자키 + 킥윈도우 압박).
    // 기존 추적 속도 상한(220)은 press 속도로 유지한다.
    const defenderAI = new CooperativeDefenseAI(
        [{ player: defender, movement: defenderPM }],
        {
            assignmentInterval: 0.25,
            retargetInterval: 0.12,
            pressHolder: true,
            speeds: { press: 220 },
        },
    );
    const lobbedPass = new LobbedThroughPass({
        leadDistance: 140,
        arriveSpeed: 90,
        maxHeight: 1.25,
        angleVariationDeg: 2,
        heightVariation: 0.12,
        powerVariation: 0.05,
    });
    // 패스 의도·정확도는 공통 모듈이 담당한다 (이분법 편차 → 압박 기반 정확도)
    const passIntent = new PassIntent();
    const passAccuracy = new PassAccuracy();

    let passPlayed = false;
    let complete = false;
    let holderTargetY = CENTER_Y;
    let courseTimer = 0;

    bm.possess(holder, POSSESS_OFFSET);
    bm.snapToFront();
    dribble.start();
    defenderAI.start();
    holderPM.moveTo(HOLDER_TARGET_X, holderTargetY);
    runnerPM.moveTo(RUNNER_TARGET_X, RUNNER_START_Y - 20);

    function finish() {
        if (complete) return;
        complete = true;
        dribble.stop();
        runnerReception.stop();
        defenderAI.stop();
        holderPM.stop();
        runnerPM.stop();
        if (onComplete) onComplete();
    }

    function tackle() {
        if (complete) return;
        const { vx, vy } = CollisionSystem.bounceVelocity(defender, ball);
        bm.release(vx, vy);
        finish();
    }

    function updateHolderCourse(dt) {
        courseTimer -= dt;
        if (courseTimer > 0) return;
        courseTimer = 0.12;
        const distance = Math.hypot(defender.x - holder.x, defender.y - holder.y);
        if (distance < 260) {
            const side = holder.y <= defender.y ? -1 : 1;
            holderTargetY = Math.max(80, Math.min(600, defender.y + side * 120));
        } else {
            holderTargetY += (CENTER_Y - holderTargetY) * 0.2;
        }
        holderPM.moveTo(HOLDER_TARGET_X, holderTargetY);
    }

    function tick(dt) {
        if (complete) {
            bm.update(dt);
            return;
        }

        updateHolderCourse(dt);
        holderPM.setFacingTarget(angleTo(holder.x, holder.y, END_LINE_X, holderTargetY));
        if (!passPlayed) {
            runnerPM.setFacingTarget(angleTo(runner.x, runner.y, RUNNER_TARGET_X, runner.y));
        }
        holderPM.update(dt);
        runnerPM.update(dt);
        dribble.update(dt);

        const lineGap = Math.abs(defender.x - runner.x);
        if (!passPlayed && lineGap <= LINE_TOLERANCE) {
            // 수비 압박 강도를 정확도에 반영한다 (공통 모듈)
            const defDist = Math.hypot(defender.x - holder.x, defender.y - holder.y);
            const distToBall = Math.hypot(runner.x - ball.x, runner.y - ball.y);
            const acc = passAccuracy.evaluate({
                dist: distToBall,
                nearestOpp: defDist,
                moving: true,
            });

            // 착지 목표: 러너의 예상 위치 (공통 모듈, 기존 비행시간 공식 유지)
            const flightDuration = Math.max(0.65, distToBall / 290);
            const intent = passIntent.plan({
                ball, receiver: runner,
                receiverVel: runnerPM.getVelocity(),
                kind: 'through',
                flightDiv: 290,
                bounds: { minX: 0, maxX: END_LINE_X - 20, minY: 0, maxY: 680 },
            });
            const targetX = intent.aimX;
            const targetY = intent.aimY;

            // 킥 전 조준: 직접 setAngle 대신 회전 관성 초기화로 방향 확정
            holderPM.resetTurn(angleTo(holder.x, holder.y, targetX, targetY));
            bm.snapToFront();
            lobbedPass.play(bm, {
                runner,
                target: { x: targetX, y: targetY },
                flightDuration,
                maxHeight: 1.2,
                deviationRad: acc.deviationRad,
                powerVariation: 0.03 + acc.pressure * 0.07,
                bounce: {
                    duration: 0.3,
                    maxHeight: 0.25,
                    velocityScale: 0.5,
                    postVx: RUNNER_SPEED * 0.7,
                    postVy: 0,
                },
            });
            passPlayed = true;
            dribble.stop();
            runnerReception.start({
                runTargetX: targetX,
                runTargetY: targetY,
                receiveAngle: angleTo(runner.x, runner.y, END_LINE_X, runner.y),
                onReceive: () => {
                    // 수신 시점의 이동 방향을 유지하며 드리블 계속
                    const dribbleAngle = angleTo(runner.x, runner.y, END_LINE_X, runner.y);
                    runnerPM.resetTurn(dribbleAngle);
                    runnerPM.setFacingTarget(dribbleAngle);
                    runnerPM.speed = RUNNER_SPEED;
                    runnerPM.moveTo(
                        Math.min(END_LINE_X, runner.x + RECEIVE_DRIBBLE_DISTANCE),
                        runner.y,
                        finish,
                    );
                },
                onFinish: finish,
            });
        }

        bm.update(dt);
        // 협력수비가 수비수 이동을 직접 갱신한다
        // (ThroughPassDefense와 동일한 홀더/리시버/비행 컨텍스트)
        defenderAI.update(dt, {
            ball,
            ballVelocity: { x: bm.vx, y: bm.vy },
            attackers: [holder, runner],
            holder: passPlayed ? null : holder,
            receiver: passPlayed ? runner : null,
            inFlight: passPlayed && bm.owner === null,
        });

        if (CollisionSystem.isTackle(defender, ball)) return tackle();

        // 볼 수령 감시
        runnerReception.update(dt);

        if (ball.x > END_LINE_X || ball.y < 0 || ball.y > 680) return finish();
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        dribble.stop();
        runnerReception.stop();
        defenderAI.stop();
        holderPM.stop();
        runnerPM.stop();
    };
}
