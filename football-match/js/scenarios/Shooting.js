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

function randomAimY() {
    const aim = Math.random();
    if (aim < 0.04) return GOAL_TOP_Y - 1 + Math.random() * 3;
    if (aim < 0.08) return GOAL_BOTTOM_Y - 1 + Math.random() * 3;
    if (aim < 0.18) return GOAL_TOP_Y - 11 + Math.random() * 3;
    if (aim < 0.28) return GOAL_BOTTOM_Y + 8 + Math.random() * 3;

    // 포스트에서 공 반지름 이상 떨어진 골문 안쪽을 우선 조준한다.
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
        // 크로스바에 맞을 수 있는 높이
        return { targetHeight: 2.32 + Math.random() * 0.1, arcHeight: 0.06 };
    }
    // 골대 위로 넘어가는 슛
    return { targetHeight: 2.65 + Math.random() * 0.35, arcHeight: 0.08, overBar: true };
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
    const pm = new PlayerMovement(player);
    const bm = new BallMovement(ball);
    const dc = new DribbleController(pm, bm);
    const shot = new ShotMovement({ goalX: GOAL_X });
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

        const targetY = randomAimY();
        const height = randomShotHeight();
        const isSideAim = targetY < GOAL_TOP_Y || targetY > GOAL_BOTTOM_Y;
        const shotTargetY = height.overBar && !isSideAim
            ? GOAL_TOP_Y + 20
            : targetY;
        const targetAngle = angleTo(player.x, player.y, GOAL_X, shotTargetY);

        pm.stop();
        pm.resetTurn(targetAngle);
        pm.setFacingTarget(targetAngle);
        recovering = false;
        dc.stop(); // 마지막으로 발 앞에 붙인 뒤 소유를 해제한다.
        return shot.shoot(bm, {
            targetY: shotTargetY,
            targetHeight: height.targetHeight,
            arcHeight: height.arcHeight,
            speed: 520 + Math.random() * 80,
        });
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
