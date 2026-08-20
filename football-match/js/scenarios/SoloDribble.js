/**
 * SoloDribble - 1인 드리블 시나리오
 *
 * 시퀀스:
 *   1. 선수가 볼 쪽으로 이동해 소유
 *   2. 동쪽으로 20m 드리블
 *   3. 왼쪽 45°로 방향 전환 후 20m 드리블
 *   4. 오른쪽 45°로 방향 전환 후 20m 드리블 후 정지
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';


const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const DRIBBLE_DIST   = 200;

function ahead(player, dist, angleDeg = player.angle) {
    const r = angleDeg * Math.PI / 180;
    return { x: player.x - Math.sin(r) * dist, y: player.y + Math.cos(r) * dist };
}

/**
 * 시나리오를 시작한다.
 * @param {SVGGElement} layer  엔티티 레이어
 * @param {GameLoop}    loop   공유 게임 루프
 * @returns {Function}         정지 콜백 (씬 전환 시 호출)
 */
export function run(layer, loop) {
    const ball   = new Ball(320, 340).render(layer);
    const player = new Player({ x: 200, y: 340, team: 'home', number: 9, angle: 0 }).render(layer);

    const pm = new PlayerMovement(player);
    const bm = new BallMovement(ball);
    const dc = new DribbleController(pm, bm);

    // 시퀀스 시작
    pm.speed = PlayerMovement.SPEEDS[2]; // 3단계 고정 (100 SVG/s)

    pm.moveTo(ball.x, ball.y, () => {
        bm.possess(player, POSSESS_OFFSET);
        dc.start();

        const p2 = ahead(player, DRIBBLE_DIST);
        pm.moveTo(p2.x, p2.y, () => {

            const leftAngle = player.angle - 45;
            const p3 = ahead(player, DRIBBLE_DIST, leftAngle);
            pm.moveTo(p3.x, p3.y, () => {

                const rightAngle = player.angle + 45;
                const p4 = ahead(player, DRIBBLE_DIST, rightAngle);
                pm.moveTo(p4.x, p4.y, () => {
                    dc.stop();
                    pm.stop();
                });
            });
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
