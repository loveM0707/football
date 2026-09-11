/**
 * ThroughPassDefense - 수비를 끌어낸 뒤 침투 선수에게 스루패스
 *
 * 빨간색 볼 소유자는 하프라인 왼쪽에서 오른쪽으로 드리블하고,
 * 파란색 수비수 두 명은 볼을 압박한다. 동료가 최종 수비라인을
 * 통과할 시점에 동료의 앞 공간으로 스루패스를 보낸다.
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { BallMovement } from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { CooperativeDefenseAI } from '../movement/CooperativeDefenseAI.js';
import { CollisionSystem } from '../movement/CollisionSystem.js';
import { ThroughPass } from '../movement/ThroughPass.js';
import { BallReception } from '../movement/BallReception.js';
import { PassIntent } from '../movement/PassIntent.js';
import { PassAccuracy } from '../movement/PassAccuracy.js';
import { angleTo } from '../movement/Direction.js';
import { CENTER_Y, HALF_LINE_X } from '../movement/FieldGeometry.js';
const HOLDER_START_X = HALF_LINE_X - 100;
const RUNNER_START_X = HOLDER_START_X;
const RUNNER_START_Y = CENTER_Y + 300;
const DEFENDER_START_X = 800;
const END_LINE_X = 1040;
const HOLDER_DRIBBLE_END_X = END_LINE_X - 60;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const RUNNER_SPEED = PlayerMovement.SPEEDS[4];

export function run(layer, loop, onComplete = null) {
    const holder = new Player({ x: HOLDER_START_X, y: CENTER_Y, team: 'home', number: 10, angle: -90 }).render(layer);
    const runner = new Player({ x: RUNNER_START_X, y: RUNNER_START_Y, team: 'home', number: 9, angle: -90 }).render(layer);
    const defenderNear = new Player({ x: DEFENDER_START_X, y: CENTER_Y + 150, team: 'away', number: 4, angle: 90 }).render(layer);
    const defenderFar = new Player({ x: DEFENDER_START_X + 20, y: CENTER_Y - 150, team: 'away', number: 5, angle: 90 }).render(layer);
    const ball = new Ball(holder.x, holder.y).render(layer);

    const holderPM = new PlayerMovement(holder, { turnBeforeMove: false, maxVel: 360 });
    const runnerPM = new PlayerMovement(runner, { turnBeforeMove: false, maxVel: 360, speed: RUNNER_SPEED });
    const defenderNearPM = new PlayerMovement(defenderNear);
    const defenderFarPM = new PlayerMovement(defenderFar);
    const bm = new BallMovement(ball);
    const dribble = new DribbleController(holderPM, bm);
    const defense = new CooperativeDefenseAI([
        { player: defenderNear, movement: defenderNearPM },
        { player: defenderFar, movement: defenderFarPM },
    ], {
        assignmentInterval: 0.25,
        retargetInterval: 0.12,
        pressHolder: true,
        speeds: { press: 190, 'lane-block': 175 },
    });
    const throughPass = new ThroughPass({ leadDistance: 190, arriveSpeed: 115, maxDeviationDeg: 3 });
    const runnerReception = new BallReception(runner, runnerPM, bm);
    // 패스 의도·정확도는 공통 모듈이 담당한다 (고정 리드·무조건 랜덤 편차 제거)
    const passIntent = new PassIntent();
    const passAccuracy = new PassAccuracy();

    let passPlayed = false;
    let complete = false;
    let holderTargetY = CENTER_Y;
    let holderCourseTimer = 0;

    bm.possess(holder, POSSESS_OFFSET);
    bm.snapToFront();
    dribble.start();
    defense.start();
    holderPM.moveTo(HOLDER_DRIBBLE_END_X, holderTargetY);
    runnerPM.moveTo(END_LINE_X, RUNNER_START_Y - 20);

    function finish() {
        if (complete) return;
        complete = true;
        dribble.stop();
        runnerReception.stop();
        defense.stop();
        holderPM.stop();
        runnerPM.stop();
        if (onComplete) onComplete();
    }

    function tackle(defender) {
        if (complete) return;
        const { vx, vy } = CollisionSystem.bounceVelocity(defender, ball);
        bm.release(vx, vy);
        finish();
    }

    function updateHolderCourse(dt) {
        holderCourseTimer -= dt;
        if (holderCourseTimer > 0) return;
        holderCourseTimer = 0.12;

        const defender = [defenderNear, defenderFar]
            .sort((a, b) => Math.hypot(a.x - holder.x, a.y - holder.y)
                - Math.hypot(b.x - holder.x, b.y - holder.y))[0];
        const distance = Math.hypot(defender.x - holder.x, defender.y - holder.y);
        if (distance < 260) {
            const side = holder.y <= defender.y ? -1 : 1;
            holderTargetY = Math.max(80, Math.min(600, defender.y + side * 115));
        } else {
            holderTargetY += (CENTER_Y - holderTargetY) * 0.2;
        }
        holderPM.moveTo(HOLDER_DRIBBLE_END_X, holderTargetY);
    }

    function rightmostDefenderX() {
        return Math.max(defenderNear.x, defenderFar.x);
    }

    function tick(dt) {
        if (complete) {
            bm.update(dt);
            return;
        }

        updateHolderCourse(dt);
        holderPM.setFacingTarget(angleTo(holder.x, holder.y, 900, holderTargetY));
        runnerPM.setFacingTarget(angleTo(runner.x, runner.y, END_LINE_X, runner.y));
        holderPM.update(dt);
        runnerPM.update(dt);
        dribble.update(dt);

        // 침투 동료가 최종 수비라인에 도달할 때 패스를 시작한다.
        // 볼 소유자는 오른쪽 골대를 향해 계속 수비를 피하며 전진한다.
        // 패스 기준은 두 수비수 중 가장 오른쪽 선수의 현재 위치다.
        if (!passPlayed && runner.x >= rightmostDefenderX() + 30) {
            // 의도: 달리는 수신자의 예상 위치를 조준한다 (공통 모듈)
            const intent = passIntent.plan({
                ball, receiver: runner,
                receiverVel: runnerPM.getVelocity(),
                kind: 'through',
            });
            // 압박: 홀더와 가장 가까운 수비수까지 거리로 정확도 계산
            const pressD = Math.min(
                Math.hypot(defenderNear.x - holder.x, defenderNear.y - holder.y),
                Math.hypot(defenderFar.x - holder.x, defenderFar.y - holder.y),
            );
            const acc = passAccuracy.evaluate({
                dist: Math.hypot(runner.x - ball.x, runner.y - ball.y),
                nearestOpp: pressD,
                moving: true,
            });
            const target = { x: intent.aimX, y: intent.aimY };
            // 킥 전 조준: 직접 setAngle 대신 회전 관성 초기화로 방향 확정
            holderPM.resetTurn(angleTo(holder.x, holder.y, target.x, target.y));
            bm.snapToFront();
            throughPass.play(bm, {
                runner,
                target,
                arriveSpeed: 115,
                deviationRad: acc.deviationRad,
            });
            passPlayed = true;
            dribble.stop();
            runnerReception.start({ runTargetX: target.x, runTargetY: target.y });
        }

        bm.update(dt);
        defense.update(dt, {
            ball,
            ballVelocity: { x: bm.vx, y: bm.vy },
            attackers: [holder, runner],
            holder: passPlayed ? null : holder,
            receiver: passPlayed ? runner : null,
            inFlight: passPlayed && bm.owner === null,
        });

        if (!passPlayed && bm.owner === holder) {
            if (CollisionSystem.isTackle(defenderNear, ball)) return tackle(defenderNear);
            if (CollisionSystem.isTackle(defenderFar, ball)) return tackle(defenderFar);
        }

        if (passPlayed) {
            runnerReception.update(dt);
            if (CollisionSystem.isTackle(defenderNear, ball)) return tackle(defenderNear);
            if (CollisionSystem.isTackle(defenderFar, ball)) return tackle(defenderFar);
            if (runnerReception.received) return finish();
            if (ball.x > END_LINE_X || ball.y < 0 || ball.y > 680) return finish();
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        dribble.stop();
        defense.stop();
        holderPM.stop();
        runnerPM.stop();
    };
}
