/**
 * ShootingWithGoalkeeper - 하프라인 오른쪽 10m 지점에서 드리블 후 슈팅 (골키퍼 포함)
 *
 * 기존 슈팅 메뉴와 동일하게 진행하되, 골대 앞에 골키퍼가 배치되어
 * GoalkeeperMovement 모듈에 따라 위치를 조정하고,
 * 슈팅이 날아가는 동안 GoalkeeperSave 모듈에 따라 세이브를 시도한다.
 *
 * 흐름:
 *   1. 공격수가 슈팅
 *   2. 골키퍼가 세이브 지점을 계산하고 다이브 시작
 *   3. 공과 골키퍼가 세이브 지점에서 만나면 세이브 판정
 *   4. 만나지 못하면 골라인까지 공이 진행 → 골/빗나감 판정
 */
import { Player } from '../entities/Player.js';
import { Ball } from '../entities/Ball.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { BallMovement } from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { ShotMovement } from '../movement/ShotMovement.js';
import { GoalkeeperMovement } from '../movement/GoalkeeperMovement.js';
import { GoalkeeperSave } from '../movement/GoalkeeperSave.js';
import { GoalkeeperController } from '../movement/GoalkeeperController.js';
import { forwardVector } from '../movement/Direction.js';
import { generateGoalDribbleWaypoints } from '../movement/DribbleRoute.js';
import { ShotExecution }     from '../movement/ShotExecution.js';
import { ShotAttempt }       from '../movement/ShotAttempt.js';
import {
    CENTER_Y, GOAL_X, HALF_LINE_X, GOAL_TOP_Y, GOAL_BOTTOM_Y,
} from '../movement/FieldGeometry.js';

const START_X = HALF_LINE_X + 10 * 10;
const SHOOT_MIN_X = GOAL_X - 30 * 10;
const SHOOT_MAX_X = GOAL_X - 16.5 * 10;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;

// 골키퍼 설정
const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;
const GK_POSITION_SPEED = 350; // 드리블 중 위치 조정 속도
const GK_DIVE_SPEED = 500; // 세이브 다이브 속도
const GK_REACTION_TIME = 0.1; // 공이 슈팅된 후 반응 지연 (초)

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
    // ── 공격수 ────────────────────────────────────────
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
    // 발사 순서 공통 모듈 — 조준·정렬·발사·궤적을 한 흐름으로 수행한다
    const shotAttempt = new ShotAttempt({ shotExec });
    const dribblePlan = createDribblePlan();

    // ── 골키퍼 ────────────────────────────────────────
    const goalkeeper = new Player({
        x: GK_START_X,
        y: GK_START_Y,
        team: 'away',
        number: 1,
        angle: 90,
    }).render(layer);
    const gkMovement = new GoalkeeperMovement({
        goalX: GOAL_X,
        goalTopY: GOAL_TOP_Y,
        goalBottomY: GOAL_BOTTOM_Y,
    });
    const gkSave = new GoalkeeperSave({
        goalX: GOAL_X,
        goalTopY: GOAL_TOP_Y,
        goalBottomY: GOAL_BOTTOM_Y,
        skill: 0.7,
        diveSpeed: GK_DIVE_SPEED,
    });
    // 골키퍼 위치·다이브·세이브 감시는 공통 모듈이 소유한다
    const gkc = new GoalkeeperController({
        goalkeeper,
        gkMovement,
        gkSave,
        ballMovement: bm,
        positionSpeed: GK_POSITION_SPEED,
        diveSpeed: GK_DIVE_SPEED,
        reactionTime: GK_REACTION_TIME,
    });

    // ── 드리블 상태 ───────────────────────────────────
    let planIndex = 0;
    let shootReady = false;
    let shooting = false;
    let complete = false;
    let recovering = false;
    let currentWaypoint = null;

    // ── 골키퍼 다이브 상태 (위치·다이브·감시는 GoalkeeperController가 소유) ──
    let saveTimer = 0; // 세이브 후 잔여 시간 (parry/deflection 시 잠시 공 이동)

    bm.possess(player, POSSESS_OFFSET);
    bm.snapToFront();
    dc.start();

    // ── 드리블 흐름 ───────────────────────────────────
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

    // ── 슈팅 처리 ─────────────────────────────────────
    function fireShot() {
        if (!shootReady || !dc.ballAttached) return false;

        // 발사 순서는 공통 모듈이 담당한다 (조준·정렬·발사·궤적)
        recovering = false;
        const res = shotAttempt.fire({
            shooter: player,
            movement: pm,
            dribble: dc,
            ballMovement: bm,
            shot,
            goalX: GOAL_X,
        });
        if (!res.fired) return false;

        // 골키퍼 세이브 지점 사전 계산은 공통 모듈이 담당한다
        if (res.plan.onTarget) {
            gkc.watchShot(res.trajectory);
        } else {
            // 빗나가는 슛: 골키퍼는 반응만
            gkc.reset();
        }

        return true;
    }

    nextDribble();

    // ── 메인 루프 ─────────────────────────────────────
    function tick(dt) {
        if (complete) return;

        // ── 세이브 후 잔여 모션 (parry/deflection) ──────
        if (saveTimer > 0) {
            saveTimer -= dt;
            bm.update(dt);
            if (saveTimer <= 0) finish('save');
            return;
        }

        // ── 슈팅 비행 중 ──────────────────────────────
        if (shooting) {
            // 골키퍼 다이브 + 세이브 지점 감시는 공통 모듈이 담당한다
            gkc.updateDive(dt);

            // 공이 세이브 지점에 도달했는지 확인 (볼 처리는 모듈이 완료)
            const hit = gkc.checkIntercept();
            if (hit && hit.saved) {
                // 세이브 성공: 공이 골키퍼 앞쪽에서 1초간 이동 후 종료
                saveTimer = 1.0;
                return;
            }

            // ShotMovement 업데이트 (공 이동, 골/빗나감 판정)
            shot.update(dt);
            if (shot.result !== null) {
                finish(shot.result);
            }
            return;
        }

        // ── 드리블 중: 골키퍼 위치 조정 (공통 모듈) ──
        gkc.updatePosition(dt);

        // ── 공격수 드리블 ──────────────────────────────
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
