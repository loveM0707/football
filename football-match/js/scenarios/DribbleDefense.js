/**
 * DribbleDefense - 수비수 피해 드리블
 *
 * '골까지 드리블'과 동일한 기본 흐름이며,
 * 하프라인(x=525) 오른쪽 20m 지점(x=725)에 파란색 수비수가 서 있다.
 * 빨간색 선수는 수비수를 상하로 피해 오른쪽 골까지 드리블한다.
 *
 * 회피 로직:
 *   - avoidSign (-1: 위, +1: 아래) 을 랜덤으로 결정
 *   - 수비수 진입 직전(x = DEFENDER_X - 20)에 회피 웨이포인트 강제 삽입
 *   - 수비수 통과 전 방향 변화 시 avoidSign 방향으로 편향
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';

const CENTER_Y       = 340;
const GOAL_X         = 1050;
const Y_MIN          = 45;
const Y_MAX          = 635;

const HALF_X         = 525;
const DEFENDER_X     = HALF_X + 200;   // 725 SVG (하프라인 오른쪽 20m)
const DEFENDER_Y     = CENTER_Y;
const AVOID_DIST     = 80;             // 수비수 중심에서 최소 이격 거리 (SVG, 8m)

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const FINAL_PLAYER_X = GOAL_X - POSSESS_OFFSET;

const SPEEDS = PlayerMovement.SPEEDS;

function randomSpeed()     { return SPEEDS[Math.floor(Math.random() * SPEEDS.length)]; }
function randomSpeedDist() { return 50  + Math.random() * 50;  }
function randomDirDist()   { return 100 + Math.random() * 50;  }

function generateWaypoints(startX, startY) {
    const wps       = [];
    const avoidSign = Math.random() < 0.5 ? -1 : 1; // -1: 위(북), +1: 아래(남)

    let x = startX, y = startY;
    let dir       = -90;
    let speed     = randomSpeed();
    let dirLeft   = randomDirDist();
    let speedLeft = randomSpeedDist();
    let avoided   = false;

    while (x < 870) {
        const progress = (x - startX) / (870 - startX);
        const step = Math.min(dirLeft, speedLeft);

        const rad = dir * Math.PI / 180;
        let cx = Math.min(x + (-Math.sin(rad)) * step, 900);
        let cy = Math.max(Y_MIN, Math.min(Y_MAX, y + Math.cos(rad) * step));

        // 수비수 진입 직전: 회피 웨이포인트 강제 삽입
        if (!avoided && x < DEFENDER_X - 20 && cx >= DEFENDER_X - 20) {
            avoided = true;
            const safeY = Math.max(Y_MIN, Math.min(Y_MAX,
                          DEFENDER_Y + avoidSign * (AVOID_DIST + 10)));
            wps.push({ x: DEFENDER_X - 20, y: safeY, speed });
            x = DEFENDER_X - 20;
            y = safeY;
            dirLeft   = randomDirDist();
            speedLeft = randomSpeedDist();
            continue;
        }

        wps.push({ x: cx, y: cy, speed });
        x = cx;
        y = cy;
        dirLeft   -= step;
        speedLeft -= step;

        if (dirLeft <= 0.5) {
            const maxDev  = 42 * (1 - progress * 0.57);
            const yOffset = y - CENTER_Y;
            const pull    = 0.25 + progress * 0.55;

            // 수비수 통과 전: avoidSign 방향으로 편향 (가까울수록 강하게)
            const proximity = (!avoided && x < DEFENDER_X)
                ? Math.max(0, 1 - (DEFENDER_X - x) / 300)
                : 0;
            const bias = -yOffset * pull * 0.38 + avoidSign * maxDev * proximity * 0.5;
            const deviation = Math.max(-maxDev, Math.min(maxDev,
                              (Math.random() * 2 - 1) * maxDev + bias));
            dir     = -90 + deviation;
            dirLeft = randomDirDist();
        }
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

export function run(layer, loop, onComplete = null) {
    // 파란색 수비수 (정지 — 나중에 움직임 추가 예정)
    // angle=90: fwdX=-sin(90°)=-1 → 서쪽(공격 방향) 을 바라봄
    new Player({ x: DEFENDER_X, y: DEFENDER_Y, team: 'away', number: 5, angle: 90 }).render(layer);

    // 빨간색 드리블 선수
    const player = new Player({ x: 0, y: CENTER_Y, team: 'home', number: 9, angle: -90 }).render(layer);
    const ball   = new Ball(110, CENTER_Y).render(layer);

    const pm = new PlayerMovement(player);
    const bm = new BallMovement(ball);
    const dc = new DribbleController(pm, bm);

    pm.moveTo(ball.x, ball.y, () => {
        bm.possess(player, POSSESS_OFFSET);
        dc.start();

        pm.speed = randomSpeed();
        pm.moveTo(210, CENTER_Y, () => {
            const wps = generateWaypoints(210, CENTER_Y);

            function next(i) {
                if (i >= wps.length) { dc.stop(); pm.stop(); if (onComplete) onComplete(); return; }
                dc.setSpeed(wps[i].speed);
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
