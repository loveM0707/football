/**
 * DriveToGoal - 왼쪽 골라인에서 오른쪽 골까지 드리블
 *
 * 시퀀스:
 *   1. 선수(왼쪽 골라인 중앙) → 볼(왼쪽 페널티 스팟) 이동 후 소유
 *   2. 동쪽으로 10m 직진
 *   3. 랜덤 방향 전환 반복 (항상 +x, 수직 이동 없음)
 *      - 구간마다 ~10m, 랜덤 스피드 적용
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

const CENTER_Y = 340;   // 필드 세로 중심 y
const GOAL_X   = 1050;  // 오른쪽 골라인 x
const Y_MIN    = 45;    // 이동 가능 y 상한 (필드 여백)
const Y_MAX    = 635;   // 이동 가능 y 하한

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4; // 19

// dc.stop() 시 ball이 frontPos에 스냅 → 볼이 x=1050에 오도록 선수 위치 조정
const FINAL_PLAYER_X = GOAL_X - POSSESS_OFFSET; // ≈ 1031

const SPEEDS = PlayerMovement.SPEEDS; // [75, 100, 130, 160, 200]

/** 5단계 중 랜덤 스피드 하나를 반환 */
function randomSpeed() {
    return SPEEDS[Math.floor(Math.random() * SPEEDS.length)];
}

/**
 * 10m 직진 이후의 웨이포인트 목록을 생성 (각 구간 약 10m).
 * 웨이포인트마다 적용할 랜덤 스피드도 함께 저장.
 */
function generateWaypoints(startX, startY) {
    const wps = [];
    let x = startX;
    let y = startY;

    while (x < 870) {
        const progress = (x - startX) / (870 - startX); // 0 → 1

        // 각도 편차 한계: 골 근처일수록 줄어듦 (42° → 18°)
        const maxDev = 42 * (1 - progress * 0.57);

        // Y 중앙 복귀 바이어스
        const yOffset      = y - CENTER_Y;
        const pullStrength = 0.25 + progress * 0.55;
        const centerBias   = -yOffset * pullStrength * 0.38;

        const rawDev   = (Math.random() * 2 - 1) * maxDev + centerBias;
        const deviation = Math.max(-maxDev, Math.min(maxDev, rawDev));

        const angle = -90 + deviation;
        // 구간 거리: ~10m(100 SVG) ± 20%
        const dist  = 85 + Math.random() * 30;

        const rad = angle * Math.PI / 180;
        const nx  = x + (-Math.sin(rad)) * dist;
        const ny  = y +   Math.cos(rad)  * dist;

        // 항상 +x 방향, 필드 내 클램핑
        const cx = Math.min(Math.max(nx, x + 35), 890);
        const cy = Math.max(Y_MIN, Math.min(Y_MAX, ny));

        wps.push({ x: cx, y: cy, speed: randomSpeed() });
        x = cx;
        y = cy;
    }

    // 호밍 1: Y가 중앙에서 멀면 중간 정렬
    if (Math.abs(y - CENTER_Y) > 25) {
        const midX = x + (FINAL_PLAYER_X - x) * 0.5;
        const midY = y + (CENTER_Y - y) * 0.6;
        wps.push({ x: midX, y: midY, speed: randomSpeed() });
        x = midX;
    }

    // 호밍 2: 골라인 정중앙
    wps.push({ x: FINAL_PLAYER_X, y: CENTER_Y, speed: randomSpeed() });

    return wps;
}

export function run(layer, loop) {
    // 선수: 왼쪽 골라인 중앙, 동쪽을 바라봄 (angle=-90)
    const player = new Player({ x: 0, y: CENTER_Y, team: 'home', number: 9, angle: -90 }).render(layer);

    // 볼: 왼쪽 페널티 스팟
    const ball = new Ball(110, CENTER_Y).render(layer);

    const pm = new PlayerMovement(player);
    const bm = new BallMovement(ball);
    const dc = new DribbleController(pm, bm);

    pm.moveTo(ball.x, ball.y, () => {
        bm.possess(player, POSSESS_OFFSET);
        dc.start();

        // 1단계: 10m 직진 (동쪽, x: 110 → 210), 랜덤 스피드 적용
        pm.speed = randomSpeed();
        pm.moveTo(210, CENTER_Y, () => {

            // 2단계: 랜덤 방향 전환으로 오른쪽 골까지
            const wps = generateWaypoints(210, CENTER_Y);

            function next(i) {
                if (i >= wps.length) {
                    dc.stop(); // 볼이 FINAL_PLAYER_X 앞(x=1050)에 스냅
                    pm.stop();
                    return;
                }
                // 각 구간 시작 시 스피드 전환
                pm.speed = wps[i].speed;
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
