/**
 * Shooting - 하프라인 오른쪽 10m 지점에서 드리블 후 슈팅
 *
 * 슈터는 오른쪽 골대를 향해 짧은 랜덤 드리블을 한 뒤,
 * 페널티 에어리어 라인과 30m 지점 사이에서 공이 발에 붙은 순간 슈팅한다.
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { BallMovement } from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { ShotMovement } from '../movement/ShotMovement.js';
import { angleTo, forwardVector } from '../movement/Direction.js';
import { generateGoalDribbleWaypoints } from '../movement/DribbleRoute.js';
import { ShotExecution }     from '../movement/ShotExecution.js';

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



export function run(layer, loop, onComplete = null) {
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
    // 슛 실행 공통 모듈 — 모든 슈팅 시나리오가 동일한 조준·오차·힘 모델을 쓴다
    const shotExec = new ShotExecution({ goalTopY: GOAL_TOP_Y, goalBotY: GOAL_BOTTOM_Y });
    const dribblePlan = createDribblePlan();

    let planIndex = 0;
    let shootReady = false;
    let shooting = false;
    let complete = false;
    let recovering = false;
    let currentWaypoint = null;

    bm.possess(player, POSSESS_OFFSET);
    bm.snapToFront();
    dc.start();

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
        // 현재 몸 방향은 유지하면서, 발 앞 접점까지 공을 다시 따라간다.
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

    function fireShot() {
        if (!shootReady || !dc.ballAttached) return false;

        // 조준·오차·높이·힘은 ShotExecution 공통 모듈이 결정한다
        const plan = shotExec.plan({ ball, goalX: GOAL_X, shooter: player });
        const targetAngle = angleTo(player.x, player.y, GOAL_X, plan.targetY);

        pm.stop();
        pm.resetTurn(targetAngle);
        pm.setFacingTarget(targetAngle);
        recovering = false;
        dc.stop(); // 마지막으로 발 앞에 붙인 뒤 소유를 해제한다.
        return shot.shoot(bm, ShotExecution.toShootOptions(plan));
    }

    nextDribble();

    function tick(dt) {
        if (complete) return;

        if (shooting) {
            shot.update(dt);
            if (shot.result !== null) finish(shot.result);
            return;
        }

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
