/**
 * main.js — 초기화 및 데모 시퀀스
 *
 * 선수 (200, 340) → 볼 (320, 340) 방향으로 이동해 소유 (동쪽)
 *
 * 시퀀스:
 *   1. 볼 소유 → 같은 방향(동)으로 20m 드리블
 *   2. 왼쪽 45° 전환(북동) → 20m 드리블
 *   3. 오른쪽 45° 전환(동) → 20m 드리블 후 정지
 *
 * 방향 전환 규약 (fwd = (-sin θ, cos θ)):
 *   왼쪽 45° = 선수 기준 반시계 방향 45° = angle - 45
 *   오른쪽 45° = 선수 기준 시계 방향 45°  = angle + 45
 */
import { Player }            from './entities/Player.js';
import { Ball }              from './entities/Ball.js';
import { PlayerMovement }    from './movement/PlayerMovement.js';
import { BallMovement }      from './movement/BallMovement.js';
import { DribbleController } from './movement/DribbleController.js';
import { GameLoop }          from './GameLoop.js';

const layer = document.getElementById('entities-layer');

// ── 엔티티 ──────────────────────────────────────────────
const ball   = new Ball(320, 340).render(layer);
const player = new Player({ x: 200, y: 340, team: 'home', number: 9, angle: 90 }).render(layer);

// ── 이동 모듈 ────────────────────────────────────────────
const pm = new PlayerMovement(player);
const bm = new BallMovement(ball);
const dc = new DribbleController(pm, bm);

// 소유 시 볼이 선수 앞에 붙는 거리
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4; // 19

// 20m = SVG 200 단위
const DRIBBLE_DIST = 200;

// ── 유틸: 현재 방향으로 N 단위 앞의 좌표 ────────────────
function ahead(dist, angleDeg = player.angle) {
    const r = angleDeg * Math.PI / 180;
    return { x: player.x - Math.sin(r) * dist, y: player.y + Math.cos(r) * dist };
}

// ── 데모 시퀀스 ──────────────────────────────────────────
function startSequence() {

    // [1] 볼 쪽으로 이동
    pm.moveTo(ball.x, ball.y, () => {

        // 볼 소유 시작 (위치 전환은 DribbleController lerp에 위임)
        bm.possess(player, POSSESS_OFFSET);
        dc.start();

        // [2] 소유 방향(동, angle≈90°) 그대로 20m 드리블
        const p2 = ahead(DRIBBLE_DIST);
        pm.moveTo(p2.x, p2.y, () => {

            // [3] 왼쪽 45° 전환 후 20m 드리블
            //     선수 기준 왼쪽(반시계) = SVG 좌표계에서 angle - 45
            const leftAngle = player.angle - 45;
            const p3 = ahead(DRIBBLE_DIST, leftAngle);
            pm.moveTo(p3.x, p3.y, () => {

                // [4] 오른쪽 45° 전환 후 20m 드리블 후 정지
                //     선수 기준 오른쪽(시계) = angle + 45
                const rightAngle = player.angle + 45;
                const p4 = ahead(DRIBBLE_DIST, rightAngle);
                pm.moveTo(p4.x, p4.y, () => {
                    dc.stop();
                    pm.stop();
                });
            });
        });
    });
}

// ── 게임 루프 ─────────────────────────────────────────────
// 순서: PlayerMovement → DribbleController → BallMovement
const loop = new GameLoop();
loop.add((dt) => {
    pm.update(dt);
    dc.update(dt);
    bm.update(dt);
});
loop.start();

startSequence();
