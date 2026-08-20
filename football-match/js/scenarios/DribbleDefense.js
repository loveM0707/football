/**
 * DribbleDefense - 수비수 피해 드리블
 *
 * 공격수(빨강)가 볼을 소유하고 오른쪽 골까지 드리블.
 * 수비수(파랑)가 접근해 볼을 빼앗으려 함.
 *
 * 공격수 상태 머신:
 *   NORMAL  – 웨이포인트 기반 드리블 (수비수 회피 포함)
 *   BEATEN  – 수비수를 제침 → 곧장 골대 방향 질주
 *   DUEL_A  – 수비수 접근 시: 슬로우 볼키핑 후 갑자기 방향전환+질주
 *   DUEL_B  – 수비수 접근 시: 즉시 방향전환 후 크게 치고 질주
 *   (DUEL_A/B 진입은 랜덤)
 *
 * 충돌 규칙:
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

const CENTER_Y         = 340;
const GOAL_X           = 1050;
const Y_MIN            = 45;
const Y_MAX            = 635;
const DEFENDER_START_X = 525 + 200;  // 725
const DEFENDER_START_Y = CENTER_Y;
const AVOID_DIST       = 80;

const POSSESS_OFFSET   = Player.BODY_RADIUS + Ball.RADIUS + 4;
const FINAL_PLAYER_X   = GOAL_X - POSSESS_OFFSET;

const SPEEDS = PlayerMovement.SPEEDS; // [50, 75, 100, 125, 150]

function randomSpeed()     { return SPEEDS[Math.floor(Math.random() * SPEEDS.length)]; }
function randomSpeedDist() { return 50  + Math.random() * 50; }
function randomDirDist()   { return 100 + Math.random() * 50; }

function defMovSpeed(distToBall) {
    if (distToBall > 280) return SPEEDS[1];
    if (distToBall > 200) return SPEEDS[2];
    if (distToBall > 120) return SPEEDS[3];
    return SPEEDS[4];
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

    const pm  = new PlayerMovement(player);
    const bm  = new BallMovement(ball);
    const dc  = new DribbleController(pm, bm);
    const dpm = new PlayerMovement(defender);

    let finished       = false;
    let tackled        = false;
    let defenderActive = false;

    // 'INIT' | 'NORMAL' | 'BEATEN' | 'DUEL_A' | 'DUEL_B'
    let attackerState = 'INIT';
    let duelTimer     = 0;

    let retargetTimer = 0;
    let aiTimer       = 0;
    const AI_INTERVAL = 0.2;

    /* ── outcome handlers ────────────────────────────── */

    function success() {
        if (finished) return;
        finished = true;
        dc.stop(); pm.stop(); dpm.stop();
        if (onComplete) onComplete();
    }

    function handleTackle() {
        if (finished) return;
        finished = true;
        tackled  = true;
        dc.stop(); pm.stop(); dpm.stop();
        const { vx, vy } = CollisionSystem.bounceVelocity(defender, ball);
        bm.release(vx, vy);
        if (onComplete) onComplete();
    }

    /* ── defender AI ─────────────────────────────────── */

    function retargetDefender() {
        const dist = Math.hypot(defender.x - ball.x, defender.y - ball.y);
        dpm.speed = defMovSpeed(dist);
        dpm.moveTo(ball.x, ball.y, () => {});
    }

    /* ── attacker state transitions ──────────────────── */

    // 수비수를 제친 후 곧장 골대
    function goToGoal() {
        attackerState = 'BEATEN';
        dc.setSpeed(SPEEDS[4]);
        if (Math.abs(player.y - CENTER_Y) > 40) {
            const midX = player.x + (FINAL_PLAYER_X - player.x) * 0.4;
            const midY = player.y + (CENTER_Y - player.y) * 0.6;
            pm.moveTo(midX, midY, () => { if (!finished) pm.moveTo(FINAL_PLAYER_X, CENTER_Y, success); });
        } else {
            pm.moveTo(FINAL_PLAYER_X, CENTER_Y, success);
        }
    }

    // 수비수 반대 방향으로 치고 달리기 후 골대
    function burst(sign) {
        attackerState = 'BEATEN';
        dc.setSpeed(SPEEDS[4]);
        const by = Math.max(Y_MIN, Math.min(Y_MAX, player.y + sign * 100));
        const bx = Math.min(player.x + 180, FINAL_PLAYER_X - 50);
        pm.moveTo(bx, by, () => { if (!finished) goToGoal(); });
    }

    // 유형 A: 슬로우 볼키핑 — 수비수가 가까워지면 갑자기 치고 달리기
    function startDuelA() {
        attackerState = 'DUEL_A';
        duelTimer     = 0;
        dc.setSpeed(SPEEDS[0]); // 50 SVG/s — 아주 느리게

        (function slowStep() {
            if (finished || attackerState !== 'DUEL_A') return;
            const tx = Math.min(player.x + 12, FINAL_PLAYER_X - POSSESS_OFFSET - 5);
            pm.moveTo(tx, player.y, () => { if (attackerState === 'DUEL_A') slowStep(); });
        })();
    }

    // 유형 B: 즉시 방향전환 후 크게 치고 달리기
    function startDuelB() {
        // 수비수 위치 반대 방향으로 이탈
        const sign = (defender.y - player.y) > 0 ? -1 : 1;
        attackerState = 'DUEL_B';
        burst(sign);
    }

    /* ── attacker AI (매 AI_INTERVAL 호출) ──────────── */

    function checkAttackerAI() {
        if (finished || attackerState === 'INIT') return;

        const defDist   = Math.hypot(defender.x - player.x, defender.y - player.y);
        const defBehind = defender.x < player.x - 25; // 수비수가 공격수보다 뒤
        const defThreat = !defBehind && defender.x > player.x + 15 && defDist < 200;

        if (attackerState === 'NORMAL') {
            if (defBehind) {
                // 수비수를 완전히 제침 → 직선 질주
                goToGoal();
            } else if (defThreat) {
                // 수비수가 앞에서 접근 → 랜덤으로 A/B 선택
                if (Math.random() < 0.5) startDuelA();
                else startDuelB();
            }
        } else if (attackerState === 'DUEL_A') {
            duelTimer += AI_INTERVAL;
            // 수비수가 매우 가까워졌거나 1.5초 경과 → 폭발적 이탈
            if (defDist < 70 || duelTimer > 1.5) {
                const sign = (defender.y - player.y) > 0 ? -1 : 1;
                burst(sign);
            }
        }
        // BEATEN / DUEL_B: 이미 목적지가 설정돼 있으므로 방치
    }

    /* ── 웨이포인트 체인 (NORMAL 상태) ──────────────── */

    pm.moveTo(ball.x, ball.y, () => {
        bm.possess(player, POSSESS_OFFSET);
        dc.start();
        defenderActive = true;
        attackerState  = 'NORMAL';

        pm.speed = randomSpeed();
        pm.moveTo(210, CENTER_Y, () => {
            if (attackerState !== 'NORMAL') return; // AI가 이미 상태 전환
            const wps = generateWaypoints(210, CENTER_Y);

            (function next(i) {
                if (finished || attackerState !== 'NORMAL') return;
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

        if (!defenderActive) return;

        // 수비수 AI
        retargetTimer -= dt;
        if (retargetTimer <= 0) {
            retargetTimer = 0.25;
            retargetDefender();
        }
        dpm.update(dt);

        // 태클 판정
        if (!finished && bm.owner === player && CollisionSystem.isTackle(defender, ball)) {
            handleTackle();
            return;
        }

        // 공격수 AI
        aiTimer -= dt;
        if (aiTimer <= 0) {
            aiTimer = AI_INTERVAL;
            checkAttackerAI();
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
