/**
 * DribbleDefense - 수비수 피해 드리블
 *
 * 공격수(빨강)가 볼을 소유하고 오른쪽 골까지 드리블.
 * 수비수(파랑)가 공격수 쪽으로 접근해 볼을 빼앗으려 함.
 *
 * 충돌 규칙:
 *   - 몸통 충돌은 무시 (몸싸움 허용, 1/3 겹침까지)
 *   - 수비수가 볼에 닿으면 태클 성공 → 볼 튕김, 2초 후 리셋
 *   - 공격수가 골까지 가면 드리블 성공, 2초 후 리셋
 */
import { Player }           from '../entities/Player.js';
import { Ball }             from '../entities/Ball.js';
import { PlayerMovement }   from '../movement/PlayerMovement.js';
import { BallMovement }     from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { CollisionSystem }  from '../movement/CollisionSystem.js';

const CENTER_Y       = 340;
const GOAL_X         = 1050;
const Y_MIN          = 45;
const Y_MAX          = 635;

const HALF_X         = 525;
const DEFENDER_START_X = HALF_X + 200;   // 725
const DEFENDER_START_Y = CENTER_Y;
const AVOID_DIST     = 80;

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const FINAL_PLAYER_X = GOAL_X - POSSESS_OFFSET;

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

function randomSpeed()     { return SPEEDS[Math.floor(Math.random() * SPEEDS.length)]; }
function randomSpeedDist() { return 50  + Math.random() * 50; }
function randomDirDist()   { return 100 + Math.random() * 50; }

/** Pick attacker speed based on distance to defender */
function attackerSpeed(baseSpeed, distToDefender) {
    if (distToDefender < 100) return SPEEDS[4]; // 150 — sprint away
    if (distToDefender < 160) return Math.max(baseSpeed, SPEEDS[3]); // ≥125
    return baseSpeed;
}

/** Pick defender speed based on distance to ball */
function defenderSpeed(distToBall) {
    if (distToBall > 280) return SPEEDS[1];  // 75 — jog
    if (distToBall > 200) return SPEEDS[2];  // 100
    if (distToBall > 120) return SPEEDS[3];  // 125
    return SPEEDS[4];                         // 150 — sprint
}

function generateWaypoints(startX, startY) {
    const wps       = [];
    const avoidSign = Math.random() < 0.5 ? -1 : 1;

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

        if (!avoided && x < DEFENDER_START_X - 20 && cx >= DEFENDER_START_X - 20) {
            avoided = true;
            const safeY = Math.max(Y_MIN, Math.min(Y_MAX,
                          DEFENDER_START_Y + avoidSign * (AVOID_DIST + 10)));
            wps.push({ x: DEFENDER_START_X - 20, y: safeY, speed });
            x = DEFENDER_START_X - 20;
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

            const proximity = (!avoided && x < DEFENDER_START_X)
                ? Math.max(0, 1 - (DEFENDER_START_X - x) / 300)
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
    // Entities
    const defender = new Player({ x: DEFENDER_START_X, y: DEFENDER_START_Y,
                                   team: 'away', number: 5, angle: 90 }).render(layer);
    const player   = new Player({ x: 0, y: CENTER_Y, team: 'home', number: 9, angle: -90 }).render(layer);
    const ball     = new Ball(110, CENTER_Y).render(layer);

    // Movement controllers
    const pm  = new PlayerMovement(player);
    const bm  = new BallMovement(ball);
    const dc  = new DribbleController(pm, bm);
    const dpm = new PlayerMovement(defender);

    let tackled       = false;
    let finished      = false;
    let defenderActive = false; // Defender starts moving when ball is past start line
    let retargetTimer = 0;

    // Retarget defender toward ball
    function retargetDefender() {
        const dist = Math.hypot(defender.x - ball.x, defender.y - ball.y);
        dpm.speed  = defenderSpeed(dist);
        dpm.moveTo(ball.x, ball.y, () => {
            // Callback fires when arriving — will retarget again in tick
        });
    }

    // Handle tackle: release ball, stop players, trigger completion
    function handleTackle() {
        if (finished) return;
        finished = true;
        tackled  = true;

        dc.stop();
        pm.stop();
        dpm.stop();

        const { vx, vy } = CollisionSystem.bounceVelocity(defender, ball);
        bm.release(vx, vy);

        if (onComplete) onComplete();
    }

    // Start attacker sequence
    pm.moveTo(ball.x, ball.y, () => {
        bm.possess(player, POSSESS_OFFSET);
        dc.start();
        defenderActive = true;

        pm.speed = randomSpeed();
        pm.moveTo(210, CENTER_Y, () => {
            const wps = generateWaypoints(210, CENTER_Y);

            function next(i) {
                if (finished) return;
                if (i >= wps.length) {
                    if (!finished) {
                        finished = true;
                        dc.stop();
                        pm.stop();
                        dpm.stop();
                        if (onComplete) onComplete();
                    }
                    return;
                }

                // Adjust speed based on proximity to defender
                const dist = Math.hypot(player.x - defender.x, player.y - defender.y);
                const effectiveSpeed = attackerSpeed(wps[i].speed, dist);
                dc.setSpeed(effectiveSpeed);
                pm.moveTo(wps[i].x, wps[i].y, () => next(i + 1));
            }
            next(0);
        });
    });

    function tick(dt) {
        if (tackled) {
            // Only update free ball physics after tackle
            bm.update(dt);
            return;
        }

        pm.update(dt);
        dc.update(dt);
        bm.update(dt);

        // Activate defender when attacker gets near halfway
        if (defenderActive) {
            retargetTimer -= dt;
            if (retargetTimer <= 0) {
                retargetTimer = 0.25; // Retarget every 250ms
                retargetDefender();
            }
            dpm.update(dt);

            // Tackle check: only when attacker owns the ball
            if (!finished && bm.owner === player) {
                if (CollisionSystem.isTackle(defender, ball)) {
                    handleTackle();
                }
            }
        }
    }
    loop.add(tick);

    return function stop() {
        loop.remove(tick);
        dc.stop();
        pm.stop();
        dpm.stop();
    };
}
