/**
 * main.js — 초기화 및 데모 시퀀스
 *
 * 시퀀스:
 *   1. 선수가 볼 위치로 이동
 *   2. 볼 소유 → 같은 방향(볼 쪽 방향)으로 20m 드리블
 *   3. 화면 위(북) 방향으로 전환 → 20m 드리블
 *   4. 화면 오른쪽(동) 방향으로 전환 → 20m 드리블
 *   5. 정지
 */
import { Player }             from './entities/Player.js';
import { Ball }               from './entities/Ball.js';
import { PlayerMovement }     from './movement/PlayerMovement.js';
import { BallMovement }       from './movement/BallMovement.js';
import { DribbleController }  from './movement/DribbleController.js';
import { GameLoop }           from './GameLoop.js';

const layer = document.getElementById('entities-layer');

// ── 엔티티 생성 ─────────────────────────────────────────
const ball   = new Ball(525, 340).render(layer);
const player = new Player({ x: 480, y: 320, team: 'home', number: 9, angle: 0 }).render(layer);

// ── 이동 모듈 ────────────────────────────────────────────
const pm = new PlayerMovement(player);
const bm = new BallMovement(ball);
const dc = new DribbleController(pm, bm);

// 소유 거리: 선수 몸통 반지름 + 볼 반지름 + 여유
const POSSESS_OFFSET = BallMovement.possessionOffset(Player.BODY_RADIUS, Ball.RADIUS);

// ── 데모 시퀀스 ──────────────────────────────────────────
function startSequence() {
    // 1) 볼 위치로 이동
    pm.moveTo(ball.x, ball.y, () => {

        // 2) 볼 소유 → 같은 방향으로 20m (200 단위) 드리블
        bm.possess(player, POSSESS_OFFSET);
        dc.start();

        // 소유 직후 선수의 방향(볼을 향해 왔던 방향)으로 200 단위 전진
        const rad1  = player.angle * Math.PI / 180;
        const tx1   = player.x + Math.sin(rad1) * 200;
        const ty1   = player.y + Math.cos(rad1) * 200;

        pm.moveTo(tx1, ty1, () => {

            // 3) 화면 위(북, angle=180°) 방향으로 전환 → 20m 드리블
            const tx2 = player.x;
            const ty2 = player.y - 200;

            pm.moveTo(tx2, ty2, () => {

                // 4) 화면 오른쪽(동, angle=90°) 방향으로 전환 → 20m 드리블
                const tx3 = player.x + 200;
                const ty3 = player.y;

                pm.moveTo(tx3, ty3, () => {

                    // 5) 정지
                    dc.stop();
                    pm.stop();
                });
            });
        });
    });
}

// ── 게임 루프 ────────────────────────────────────────────
// 호출 순서가 중요: PlayerMovement → DribbleController → BallMovement
const loop = new GameLoop();
loop.add((dt) => {
    pm.update(dt);
    dc.update(dt);
    bm.update(dt);
});
loop.start();

startSequence();
