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
import { generateDefensiveWaypoints } from '../movement/DribbleRoute.js';
import { CENTER_Y, GOAL_X, Y_MIN, Y_MAX } from '../movement/FieldGeometry.js';
const DEFENDER_START_X = 525 + 200;  // 725
const DEFENDER_START_Y = CENTER_Y;
const AVOID_DIST       = 80;

const POSSESS_OFFSET   = Player.BODY_RADIUS + Ball.RADIUS + 4;
const FINAL_PLAYER_X   = GOAL_X - POSSESS_OFFSET;

const SPEEDS = PlayerMovement.SPEEDS;

function randomSpeed()     { return SPEEDS[Math.floor(Math.random() * SPEEDS.length)]; }

// 공유 모듈 DribbleRoute.generateDefensiveWaypoints 사용
function generateWaypoints(startX, startY) {
    return generateDefensiveWaypoints(startX, startY, {
        endX: 870,
        finalX: FINAL_PLAYER_X,
        finalY: CENTER_Y,
        yMin: Y_MIN,
        yMax: Y_MAX,
        defenderX: DEFENDER_START_X,
        defenderY: DEFENDER_START_Y,
        avoidDist: AVOID_DIST,
        centerY: CENTER_Y,
        maxX: 900,
    });
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
        dc.stop();
        // 볼 없는 드리블만 정지 — 선수 이동은 멈추지 않아 태클 후에도 장면이 살아있다.
        // (전원 정지하면 자동 리셋까지 2초간 시체 장면이 된다)
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
        if (tackled) {
            // 종료 후에도 볼·수비수는 계속 움직인다 (2초 시체 장면 방지).
            // 공격수 pm은 마지막 웨이포인트로 자연 감속, 수비수는 튄 볼을 계속 압박.
            bm.update(dt);
            pm.update(dt);
            defenseAI.update(dt, {
                ball,
                ballVelocity: { x: bm.vx, y: bm.vy },
                attackers: [player],
                holder: player,
                inFlight: false,
            });
            return;
        }

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
