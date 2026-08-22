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
import { DefenderAI } from '../movement/DefenderAI.js';
import { LobbedThroughPass } from '../movement/LobbedThroughPass.js';
import { angleTo } from '../movement/Direction.js';

const CENTER_Y = 340;
const END_LINE_X = 1040;
const HOLDER_START_X = 425;
const RUNNER_START_X = 425;
const RUNNER_START_Y = CENTER_Y + 300;
const DEFENDER_START_X = 725;
const DEFENDER_START_Y = CENTER_Y + 200;
const HOLDER_TARGET_X = END_LINE_X - 60;
const RUNNER_TARGET_X = END_LINE_X - 10;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const RUNNER_SPEED = PlayerMovement.SPEEDS[4];
const LINE_TOLERANCE = 18;
const RECEIVE_DRIBBLE_DISTANCE = 100;

export function run(layer, loop, onComplete = null) {
    const holder = new Player({ x: HOLDER_START_X, y: CENTER_Y, team: 'home', number: 10, angle: -90 }).render(layer);
    const runner = new Player({ x: RUNNER_START_X, y: RUNNER_START_Y, team: 'home', number: 9, angle: -90 }).render(layer);
    const defender = new Player({ x: DEFENDER_START_X - 50, y: DEFENDER_START_Y + 100, team: 'away', number: 4, angle: 90 }).render(layer);
    const ball = new Ball(holder.x, holder.y).render(layer);

    const holderPM = new PlayerMovement(holder, { turnBeforeMove: false, maxVel: 360 });
    const runnerPM = new PlayerMovement(runner, { turnBeforeMove: false, maxVel: 360, speed: RUNNER_SPEED });
    const defenderPM = new PlayerMovement(defender);
    const bm = new BallMovement(ball);
    const dribble = new DribbleController(holderPM, bm);
    const runnerReception = new BallReception(runner, runnerPM, bm, {
        catchDistance: 28,
        maxBallSpeed: 300,
        trackDistance: 220,
        trackReceiver: true,
    });
    const defenderAI = new DefenderAI(defenderPM, defender, {
        retargetInterval: 0.12,
        speedTable: [[280, 190], [180, 200], [0, 220]],
    });
    const lobbedPass = new LobbedThroughPass({
        leadDistance: 140,
        arriveSpeed: 90,
        maxHeight: 1.25,
        angleVariationDeg: 2,
        heightVariation: 0.12,
        powerVariation: 0.05,
    });

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
            // 수비 압박 강도에 따라 패스 편차를 결정한다
            const defDist = Math.hypot(defender.x - holder.x, defender.y - holder.y);
            const underPressure = defDist < 130;
            const angleVariationDeg = underPressure ? 5 : 1;
            const powerVariation = underPressure ? 0.1 : 0.03;

            // 착지 목표: 러너의 현재 위치에서 비행 시간 동안 달릴 거리 앞
            const distToBall = Math.hypot(runner.x - ball.x, runner.y - ball.y);
            const flightDuration = Math.max(0.65, distToBall / 290);
            const targetX = Math.min(END_LINE_X - 20, runner.x + RUNNER_SPEED * flightDuration);
            const targetY = runner.y;

            holder.setAngle(angleTo(holder.x, holder.y, targetX, targetY));
            bm.snapToFront();
            lobbedPass.play(bm, {
                runner,
                direction: { x: 1, y: 0 },
                leadDistance: targetX - runner.x,
                flightDuration,
                maxHeight: 1.2,
                angleVariationDeg,
                powerVariation,
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
        defenderAI.update(dt, ball.x, ball.y, bm.vx, bm.vy);

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
