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

/** 50~100 SVG(5~10m) 사이 랜덤 */
function randomSpeedDist() {
    return 50 + Math.random() * 50;
}

/** 100~150 SVG(10~15m) 사이 랜덤 */
function randomDirDist() {
    return 100 + Math.random() * 50;
}

/**
 * 방향(10~15m)과 속도(5~10m) 변화 주기를 독립적으로 관리하는 웨이포인트 생성.
 *
 * 두 타이머 중 먼저 만료되는 거리마다 웨이포인트를 찍고,
 * 해당 타이머만 리셋한다. (속도·방향이 서로 다른 주기로 바뀜)
 */
function generateWaypoints(startX, startY) {
    const wps = [];
    let x = startX, y = startY;

    // 현재 방향과 속도
    let dir   = -90;           // 동쪽 기준 (SVG rotate angle)
    let speed = randomSpeed();

    // 각 타이머: 다음 변화까지 남은 거리 (SVG 단위)
    let dirLeft   = randomDirDist();
    let speedLeft = randomSpeedDist();

    while (x < 870) {
        const progress = (x - startX) / (870 - startX); // 0 → 1

        // 다음 이벤트는 두 타이머 중 빠른 쪽
        const step = Math.min(dirLeft, speedLeft);

        // 현재 방향으로 step 만큼 이동
        const rad = dir * Math.PI / 180;
        const nx  = x + (-Math.sin(rad)) * step;
        const ny  = y +   Math.cos(rad)  * step;

        const cx = Math.min(nx, 900);                         // 호밍 구간 보존
        const cy = Math.max(Y_MIN, Math.min(Y_MAX, ny));

        wps.push({ x: cx, y: cy, speed });
        x = cx;
        y = cy;

        dirLeft   -= step;
        speedLeft -= step;

        // 방향 변화
        if (dirLeft <= 0.5) {
            const maxDev     = 42 * (1 - progress * 0.57);
            const yOffset    = y - CENTER_Y;
            const pull       = 0.25 + progress * 0.55;
            const bias       = -yOffset * pull * 0.38;
            const deviation  = Math.max(-maxDev, Math.min(maxDev,
                               (Math.random() * 2 - 1) * maxDev + bias));
            dir     = -90 + deviation;
            dirLeft = randomDirDist();
        }

        // 속도 변화
        if (speedLeft <= 0.5) {
            speed     = randomSpeed();
            speedLeft = randomSpeedDist();
        }
    }

    // 호밍: Y 중앙 정렬 후 골라인 진입
    if (Math.abs(y - CENTER_Y) > 25) {
        const midX = x + (FINAL_PLAYER_X - x) * 0.5;
        const midY = y + (CENTER_Y - y) * 0.6;
        wps.push({ x: midX, y: midY, speed: randomSpeed() });
        x = midX;
    }
    wps.push({ x: FINAL_PLAYER_X, y: CENTER_Y, speed: randomSpeed() });

    return wps;
}

export function run(layer, loop) {
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

            const wps = generateWaypoints(210, CENTER_Y);

            function next(i) {
                if (i >= wps.length) {
                    dc.stop();
                    pm.stop();
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
