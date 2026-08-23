/**
 * DriveToGoal - 왼쪽 골라인에서 오른쪽 골까지 드리블
 *
 * 시퀀스:
 *   1. 선수(왼쪽 골라인 중앙) → 볼(왼쪽 페널티 스팟) 이동 후 소유
 *   2. 동쪽으로 10m 직진 (시작 속도: 랜덤)
 *   3. 방향 전환 주기 10~15m, 속도 전환 주기 5~10m (독립적으로 관리)
 *      - 항상 +x 방향, 수직 이동 없음
 *      - 골에 가까울수록 각도 편차 감소, Y 중앙 수렴 강화
 *   4. 오른쪽 골라인 중앙에 볼을 두고 정지
 *
 * 좌표계 (SVG):
 *   angle=-90° → fwd=(+1, 0) → 오른쪽(동)
 *   fwd_x = -sin(θ), fwd_y = cos(θ)
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { generateGoalDribbleWaypoints } from '../movement/DribbleRoute.js';

const CENTER_Y = 340;
const GOAL_X   = 1050;
const Y_MIN    = 45;
const Y_MAX    = 635;

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4; // 19
const FINAL_PLAYER_X = GOAL_X - POSSESS_OFFSET;              // ≈ 1031

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

function randomSpeed() {
    return SPEEDS[Math.floor(Math.random() * SPEEDS.length)];
}

export function run(layer, loop, onComplete = null) {
    const player = new Player({ x: 0, y: CENTER_Y, team: 'home', number: 9, angle: -90 }).render(layer);
    const ball   = new Ball(110, CENTER_Y).render(layer);

    const pm = new PlayerMovement(player);
    const bm = new BallMovement(ball);
    const dc = new DribbleController(pm, bm);

    pm.moveTo(ball.x, ball.y, () => {
        bm.possess(player, POSSESS_OFFSET);
        dc.start();

        // 1단계: 10m 직진, 랜덤 스피드
        pm.speed = randomSpeed();
        pm.moveTo(210, CENTER_Y, () => {

            const wps = generateGoalDribbleWaypoints(210, CENTER_Y, {
                endX: 870,
                finalX: FINAL_PLAYER_X,
                finalY: CENTER_Y,
                yMin: Y_MIN,
                yMax: Y_MAX,
            });

            function next(i) {
                if (i >= wps.length) {
                    dc.stop();
                    pm.stop();
                    if (onComplete) onComplete();
                    return;
                }
                dc.setSpeed(wps[i].speed); // 볼이 발에 붙을 때 속도 변경
                pm.moveTo(wps[i].x, wps[i].y, () => next(i + 1));
            }

            next(0);
        });
    });

    function tick(dt) {
        pm.update(dt);
        dc.update(dt);
        bm.update(dt);
    }
    loop.add(tick);

    return function stop() {
        loop.remove(tick);
        dc.stop();
        pm.stop();
    };
}
