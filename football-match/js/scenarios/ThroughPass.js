/**
 * ThroughPass - 중앙에서 달려가는 동료에게 스루패스
 *
 * 배치:
 *   패서: 센터서클 중앙 (525, 340)
 *   러너: 패서의 왼쪽 30m·아래쪽 20m (225, 540)
 *
 * 러너가 하프라인에 가까워지면 오른쪽 진행 공간으로 대각선 스루패스를
 * 보내고, 러너가 공을 잡으면 시나리오를 완료한다.
 */
import { Player }        from '../entities/Player.js';
import { Ball }          from '../entities/Ball.js';
import { BallMovement }  from '../movement/BallMovement.js';
import { PlayerMovement} from '../movement/PlayerMovement.js';
import { ThroughPass as ThroughPassMovement } from '../movement/ThroughPass.js';
import { BallReception } from '../movement/BallReception.js';
import { angleTo, forwardVector } from '../movement/Direction.js';

const CENTER_X = 525;
const CENTER_Y = 340;
const RUNNER_START_X = CENTER_X - 300;
const RUNNER_START_Y = CENTER_Y + 200;
const PASS_TRIGGER_X = CENTER_X - 18;
const RUNNER_RUN_TO_X = 900;
const RUNNER_SPEED = PlayerMovement.SPEEDS[4];
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const Y_MIN = 45;
const Y_MAX = 635;
const COURSE_UPDATE_INTERVAL = 0.12;
const MAX_COURSE_STEP = 18;

export function run(layer, loop, onComplete = null) {
    const passer = new Player({
        x: CENTER_X,
        y: CENTER_Y,
        team: 'home',
        number: 10,
        angle: -90,
    }).render(layer);
    const runner = new Player({
        x: RUNNER_START_X,
        y: RUNNER_START_Y,
        team: 'home',
        number: 9,
        angle: -90,
    }).render(layer);
    const ball = new Ball(CENTER_X, CENTER_Y).render(layer);
    const bm = new BallMovement(ball);
    const passerPM = new PlayerMovement(passer, { turnBeforeMove: false, maxVel: 360 });
    const runnerPM = new PlayerMovement(runner, { turnBeforeMove: false, maxVel: 360, speed: RUNNER_SPEED });
    const throughPass = new ThroughPassMovement({
        leadDistance: 180,
        arriveSpeed: 100,
        maxDeviationDeg: 5,
    });
    const runnerReception = new BallReception(runner, runnerPM, bm);

    let passPlayed = false;
    let completed = false;
    let runnerTargetY = RUNNER_START_Y;
    let courseUpdateTimer = 0;

    bm.possess(passer, POSSESS_OFFSET);
    bm.snapToFront();
    runnerPM.moveTo(RUNNER_RUN_TO_X, RUNNER_START_Y);

    function adjustRunnerCourse(dt) {
        if (!passPlayed) return;
        courseUpdateTimer -= dt;
        if (courseUpdateTimer > 0) return;
        courseUpdateTimer = COURSE_UPDATE_INTERVAL;

        const ballAhead = ball.x >= runner.x - 30;
        if (!ballAhead) return;

        const ballSpeed = Math.hypot(bm.vx, bm.vy);
        if (ballSpeed < 1) return;

        // 공의 예상 정지 지점 오차를 반영해 러너의 진행 각도를 보정한다.
        const remainingDistance = ballSpeed ** 2 / (2 * BallMovement.FRICTION);
        const projectedBallY = ball.y + (bm.vy / ballSpeed) * remainingDistance;
        const yError = projectedBallY - runnerTargetY;
        const correction = Math.max(-MAX_COURSE_STEP, Math.min(MAX_COURSE_STEP, yError * 0.18));
        runnerTargetY = Math.max(Y_MIN, Math.min(Y_MAX, runnerTargetY + correction));
        runnerPM.moveTo(RUNNER_RUN_TO_X, runnerTargetY);
        runnerPM.setFacingTarget(angleTo(
            runner.x,
            runner.y,
            runner.x + 100,
            runner.y + Math.max(-45, Math.min(45, yError)),
        ));
    }

    function complete() {
        if (completed) return;
        completed = true;
        runnerReception.stop();
        bm.possess(runner, POSSESS_OFFSET);
        bm.snapToFront();
        passerPM.stop();
        runnerPM.stop();
        if (onComplete) onComplete();
    }

    function tick(dt) {
        if (completed) {
            bm.update(dt);
            return;
        }

        adjustRunnerCourse(dt);
        passerPM.update(dt);
        runnerPM.update(dt);

        if (!passPlayed && runner.x >= PASS_TRIGGER_X) {
            const direction = forwardVector(runner.angle);
            const target = throughPass.targetSpace({
                runner,
                direction,
                runnerSpeed: RUNNER_SPEED,
                leadDistance: 180,
            });
            passer.setAngle(angleTo(passer.x, passer.y, target.x, target.y));
            bm.snapToFront();
            throughPass.play(bm, {
                runner,
                direction,
                runnerSpeed: RUNNER_SPEED,
                leadDistance: 180,
                arriveSpeed: 100,
            });
            passPlayed = true;
            runnerReception.start({ runTargetX: target.x, runTargetY: target.y });
        }

        bm.update(dt);
        runnerReception.update(dt);
        if (passPlayed && runnerReception.received) complete();
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        passerPM.stop();
        runnerPM.stop();
    };
}
