/**
 * DribbleDefense - 수비수 피해 드리블
 *
 * 공격수(빨강)가 볼을 소유하고 오른쪽 골까지 드리블.
 * 수비수(파랑)가 접근해 볼을 빼앗으려 함.
 *
 * 공격수 상태 머신 → AttackerDuelAI:
 *   NORMAL  웨이포인트 드리블, 수비수 감시
 *   BEATEN  수비수를 제침 → DribbleBehaviors.sprintHomed 로 곧장 골대
 *   DUEL_A  슬로우 볼키핑(DribbleBehaviors.slowKeepStep) 후 lateralBurst
 *   DUEL_B  즉시 DribbleBehaviors.lateralBurst
 *
 * 수비수 AI → CooperativeDefenseAI 단일 수비수 압박 모드
 *
 * 충돌 규칙 → CollisionSystem:
 *   몸통 충돌 – 무시 (몸싸움)
 *   수비수 볼 접촉 – 태클 성공 → 볼 튕김, 2초 후 리셋
 *   골대 도달 – 성공, 2초 후 리셋
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { CollisionSystem }   from '../movement/CollisionSystem.js';
import { DribbleBehaviors }  from '../movement/DribbleBehaviors.js';
import { AttackerDuelAI }    from '../movement/AttackerDuelAI.js';
import { CooperativeDefenseAI } from '../movement/CooperativeDefenseAI.js';
import { forwardVector }     from '../movement/Direction.js';

const CENTER_Y         = 340;
const GOAL_X           = 1050;
const Y_MIN            = 45;
const Y_MAX            = 635;
const DEFENDER_START_X = 525 + 200;  // 725
const DEFENDER_START_Y = CENTER_Y;
const AVOID_DIST       = 80;

const POSSESS_OFFSET   = Player.BODY_RADIUS + Ball.RADIUS + 4;
const FINAL_PLAYER_X   = GOAL_X - POSSESS_OFFSET;

const SPEEDS = PlayerMovement.SPEEDS;

function randomSpeed()     { return SPEEDS[Math.floor(Math.random() * SPEEDS.length)]; }
function randomSpeedDist() { return 50  + Math.random() * 50; }
function randomDirDist()   { return 100 + Math.random() * 50; }

function generateWaypoints(startX, startY) {
    const wps       = [];
    const avoidSign = Math.random() < 0.5 ? -1 : 1;
    let x = startX, y = startY;
    let dir = -90, speed = randomSpeed();
    let dirLeft = randomDirDist(), speedLeft = randomSpeedDist();
    let avoided = false;

    while (x < 870) {
        const progress = (x - startX) / (870 - startX);
        const step = Math.min(dirLeft, speedLeft);
        const fwd = forwardVector(dir);
        let cx = Math.min(x + fwd.x * step, 900);
        let cy = Math.max(Y_MIN, Math.min(Y_MAX, y + fwd.y * step));

        if (!avoided && x < DEFENDER_START_X - 20 && cx >= DEFENDER_START_X - 20) {
            avoided = true;
            const safeY = Math.max(Y_MIN, Math.min(Y_MAX,
                          DEFENDER_START_Y + avoidSign * (AVOID_DIST + 10)));
            wps.push({ x: DEFENDER_START_X - 20, y: safeY, speed });
            x = DEFENDER_START_X - 20; y = safeY;
            dirLeft = randomDirDist(); speedLeft = randomSpeedDist();
            continue;
        }

        wps.push({ x: cx, y: cy, speed });
        x = cx; y = cy;
        dirLeft -= step; speedLeft -= step;

        if (dirLeft <= 0.5) {
            const maxDev  = 42 * (1 - progress * 0.57);
            const yOffset = y - CENTER_Y;
            const pull    = 0.25 + progress * 0.55;
            const proximity = (!avoided && x < DEFENDER_START_X)
                ? Math.max(0, 1 - (DEFENDER_START_X - x) / 300) : 0;
            const bias = -yOffset * pull * 0.38 + avoidSign * maxDev * proximity * 0.5;
            const deviation = Math.max(-maxDev, Math.min(maxDev,
                              (Math.random() * 2 - 1) * maxDev + bias));
            dir = -90 + deviation; dirLeft = randomDirDist();
        }
        if (speedLeft <= 0.5) { speed = randomSpeed(); speedLeft = randomSpeedDist(); }
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
    const defender = new Player({ x: DEFENDER_START_X, y: DEFENDER_START_Y,
                                   team: 'away', number: 5, angle: 90 }).render(layer);
    const player   = new Player({ x: 0, y: CENTER_Y,
                                   team: 'home', number: 9, angle: -90 }).render(layer);
    const ball     = new Ball(110, CENTER_Y).render(layer);

    const pm   = new PlayerMovement(player);
    const bm   = new BallMovement(ball);
    const dc   = new DribbleController(pm, bm);
    const dpm  = new PlayerMovement(defender);

    let finished = false;
    let tackled  = false;

    /* ── 수비수 AI ─────────────────────────────────── */
    const defenseAI = new CooperativeDefenseAI(
        [{ player: defender, movement: dpm }],
        {
            assignmentInterval: 0.25,
            retargetInterval: 0.15,
        },
    );

    /* ── 공격수 AI ─────────────────────────────────── */

    function success() {
        if (finished) return;
        finished = true;
        dc.stop(); pm.stop(); defenseAI.stop();
        if (onComplete) onComplete();
    }

    function handleTackle() {
        if (finished) return;
        finished = true;
        tackled  = true;
        duelAI.stop();
        dc.stop(); pm.stop(); defenseAI.stop();
        const { vx, vy } = CollisionSystem.bounceVelocity(defender, ball);
        bm.release(vx, vy);
        if (onComplete) onComplete();
    }

    function goToGoal() {
        DribbleBehaviors.sprintHomed(pm, dc, player, FINAL_PLAYER_X, CENTER_Y, success);
    }

    const duelAI = new AttackerDuelAI(player, defender, {
        onBeaten: () => goToGoal(),

        onDuelA: () => {
            // 슬로우 볼키핑: 수비수가 접근할 때까지 조금씩 전진
            const maxX = FINAL_PLAYER_X - POSSESS_OFFSET - 5;
            (function keepStep() {
                if (duelAI.state !== 'DUEL_A' || finished) return;
                DribbleBehaviors.slowKeepStep(pm, dc, player, maxX, keepStep);
            })();
        },

        onDuelBurst: (sign) => {
            // 수비수 반대 방향으로 크게 치고 달린 후 골대
            DribbleBehaviors.lateralBurst(pm, dc, player, sign,
                () => { if (!finished) goToGoal(); },
                { maxX: FINAL_PLAYER_X - 50, yMin: Y_MIN, yMax: Y_MAX }
            );
        },
    });

    /* ── 공격수 시퀀스 시작 ─────────────────────────── */

    pm.moveTo(ball.x, ball.y, () => {
        bm.possess(player, POSSESS_OFFSET);
        dc.start();
        defenseAI.start();
        duelAI.start();

        pm.speed = randomSpeed();
        pm.moveTo(210, CENTER_Y, () => {
            if (duelAI.state !== 'NORMAL') return;
            const wps = generateWaypoints(210, CENTER_Y);

            (function next(i) {
                if (finished || duelAI.state !== 'NORMAL') return;
                if (i >= wps.length) { success(); return; }

                // 수비수 근접 시 속도 상향
                const dist = Math.hypot(player.x - defender.x, player.y - defender.y);
                const spd  = dist < 100 ? SPEEDS[4]
                           : dist < 160 ? Math.max(wps[i].speed, SPEEDS[3])
                           : wps[i].speed;
                dc.setSpeed(spd);
                pm.moveTo(wps[i].x, wps[i].y, () => next(i + 1));
            })(0);
        });
    });

    /* ── game loop ───────────────────────────────────── */

    function tick(dt) {
        if (tackled) { bm.update(dt); return; }

        pm.update(dt);
        dc.update(dt);
        bm.update(dt);

        // 수비수 AI: 공의 진행 방향을 예측해 압박
        defenseAI.update(dt, {
            ball,
            ballVelocity: { x: bm.vx, y: bm.vy },
            attackers: [player],
            holder: player,
            inFlight: false,
        });

        // 태클 판정
        if (!finished && bm.owner === player && CollisionSystem.isTackle(defender, ball)) {
            handleTackle();
            return;
        }

        // 공격수 AI
        duelAI.update(dt);
    }

    loop.add(tick);

    return function stop() {
        loop.remove(tick);
        dc.stop(); pm.stop(); defenseAI.stop();
    };
}
