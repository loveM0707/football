/**
 * FourPlayerPassCoopDefense - 4인 패스(협력수비)
 *
 * 배치: 4인 패스(수비)와 동일 구조이나 간격 120 + 수비수 2명
 *   선수0: 왼쪽 위   (HALF_X-120, CENTER_Y-120) 빨강
 *   선수1: 왼쪽 아래 (HALF_X-120, CENTER_Y+120) 빨강
 *   선수2: 오른쪽 위 (HALF_X+120, CENTER_Y-120) 빨강
 *   선수3: 오른쪽 아래(HALF_X+120, CENTER_Y+120) 빨강
 *   수비수A: 중앙 좌측 (HALF_X-18, CENTER_Y) 파랑 — 볼 체이서
 *   수비수B: 중앙 우측 (HALF_X+18, CENTER_Y) 파랑 — 패스 길목 차단
 *
 * 초기: 모든 빨강 센터향, 수비수 홀더 방향, 볼은 선수0 발 앞, 첫 패스 후 수비 기동
 *
 * 빨강: IdleMovement + PassReceiver/PassMovement, 2명 수비 모두 고려해 가장 여유 있는 대상에 패스
 * 파랑: 협력 수비 — 1명은 DefenderAI로 볼 추적, 1명은 패스 레인 블록
 *   - 블록 수비는 홀더→예측 수신자 라인 위 40~50% 지점을 선점해 동시에 같은 볼만 쫓지 않음
 *   - 수비 모듈(DefenderAI) 속도·리타게팅 하향 + 시나리오별 오버라이드로 3회 이상 순환 보장
 */
import { Player }          from '../entities/Player.js';
import { Ball }            from '../entities/Ball.js';
import { BallMovement }    from '../movement/BallMovement.js';
import { PassMovement }    from '../movement/PassMovement.js';
import { PassReceiver }    from '../movement/PassReceiver.js';
import { IdleMovement }    from '../movement/IdleMovement.js';
import { PlayerMovement }  from '../movement/PlayerMovement.js';
import { DefenderAI }      from '../movement/DefenderAI.js';
import { CollisionSystem } from '../movement/CollisionSystem.js';
import { angleTo, forwardVector } from '../movement/Direction.js';

const CENTER_Y = 340;
const HALF_X   = 525;
const CENTER_X = HALF_X;

const OFFSET = 120;

const POSITIONS = [
    { x: HALF_X - OFFSET, y: CENTER_Y - OFFSET },
    { x: HALF_X - OFFSET, y: CENTER_Y + OFFSET },
    { x: HALF_X + OFFSET, y: CENTER_Y - OFFSET },
    { x: HALF_X + OFFSET, y: CENTER_Y + OFFSET },
];

const INITIAL_ANGLES = POSITIONS.map(p => angleTo(p.x, p.y, CENTER_X, CENTER_Y));

const POSSESS_OFFSET      = Player.BODY_RADIUS + Ball.RADIUS + 4;
const RECEIVE_DIST        = POSSESS_OFFSET + 3;
const PASS_DELAY          = 0.4;
const PASSER_RETURN_DELAY = 0.2;
const PASS_ANGLE_DEG      = 5;
const LONG_PASS_CHANCE    = 0.4;
const HOME_SPEED          = 75;
const PLAYERS_COUNT = 4;

function distPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx*dx + dy*dy;
    if (len2 < 0.01) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1)*dx + (py - y1)*dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t*dx), py - (y1 + t*dy));
}

export function run(layer, loop, onComplete = null) {
    const players = [];
    for (let i = 0; i < PLAYERS_COUNT; i++) {
        const pos = POSITIONS[i];
        players.push(new Player({ x: pos.x, y: pos.y, team: 'home', number: i+1, angle: INITIAL_ANGLES[i] }).render(layer));
    }

    const defenderA = new Player({ x: CENTER_X - 18, y: CENTER_Y, team: 'away', number: 5, angle: 90 }).render(layer);
    const defenderB = new Player({ x: CENTER_X + 18, y: CENTER_Y, team: 'away', number: 6, angle: 90 }).render(layer);

    const ball = new Ball(players[0].x, players[0].y).render(layer);
    const bm = new BallMovement(ball);
    const homePositions = POSITIONS.map(p => ({ x: p.x, y: p.y }));
    const passReceiver = new PassReceiver();
    const idle = new IdleMovement(PLAYERS_COUNT);

    const chasePM = new PlayerMovement(defenderA);
    const chaseAI = new DefenderAI(chasePM, defenderA, {
        retargetInterval: 0.45,
        speedTable: [
            [280, PlayerMovement.SPEEDS[0]],
            [180, PlayerMovement.SPEEDS[0]],
            [80,  PlayerMovement.SPEEDS[1]],
            [0,   75],
        ],
    });
    const blockPM = new PlayerMovement(defenderB);
    // 블록 수비는 PlayerMovement 직접 제어 — 수비 모듈 협력 형태

    const pms = players.map(p => new PlayerMovement(p, { turnBeforeMove: false, maxVel: 360 }));
    function setTargetAngle(idx, ang) { pms[idx].setFacingTarget(ang); }
    function smoothAngles(dt) { for (let i = 0; i < PLAYERS_COUNT; i++) pms[i].update(dt); }

    let holderIdx = 0, receiverIdx = -1;
    let passTimer = PASS_DELAY, inFlight = false, isLongPass = false;
    let aerialLandX = CENTER_X, aerialLandY = CENTER_Y;
    let passerReturnTimer = 0, passerReturnSpeed = HOME_SPEED;
    let finished = false, defenderStarted = false;

    function homeOf(idx) { return homePositions[idx]; }
    function moveTowardHome(playerIdx, dt, speed = HOME_SPEED) {
        const player = players[playerIdx], home = homeOf(playerIdx);
        const dx = home.x - player.x, dy = home.y - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return;
        const step = Math.min(speed * dt, dist);
        player.setPosition(player.x + (dx/dist)*step, player.y + (dy/dist)*step);
    }
    function calcPasserReturnSpeed(flightTime) {
        const home = homeOf(holderIdx);
        const dist = Math.hypot(players[holderIdx].x - home.x, players[holderIdx].y - home.y);
        if (dist < 1) return HOME_SPEED;
        const available = flightTime + PASS_DELAY - PASSER_RETURN_DELAY;
        if (available < 0.1) return HOME_SPEED;
        return dist / available;
    }

    function scoreVsBoth(hx, hy, rx, ry) {
        const d1r = Math.hypot(defenderA.x - rx, defenderA.y - ry);
        const d2r = Math.hypot(defenderB.x - rx, defenderB.y - ry);
        const d1l = distPointToSegment(defenderA.x, defenderA.y, hx, hy, rx, ry);
        const d2l = distPointToSegment(defenderB.x, defenderB.y, hx, hy, rx, ry);
        const distToReceiver = Math.min(d1r, d2r);
        const distToLine = Math.min(d1l, d2l);
        return distToLine * 1.8 + distToReceiver * 1.0;
    }

    function chooseReceiverAvoidBoth(hIdx) {
        const candidates = [0,1,2,3].filter(i => i !== hIdx);
        let best = candidates[0], bestScore = -Infinity;
        for (const c of candidates) {
            const rx = players[c].x, ry = players[c].y;
            const hx = players[hIdx].x, hy = players[hIdx].y;
            const score = scoreVsBoth(hx, hy, rx, ry) + Math.random()*6;
            if (score > bestScore) { bestScore = score; best = c; }
        }
        return best;
    }

    function faceTarget(hIdx, tIdx) {
        setTargetAngle(hIdx, angleTo(players[hIdx].x, players[hIdx].y, players[tIdx].x, players[tIdx].y));
    }

    function handleIntercept(byDefender) {
        if (finished) return;
        finished = true;
        passReceiver.reset();
        chaseAI.stop(); chasePM.stop(); blockPM.stop();
        const { vx, vy } = CollisionSystem.bounceVelocity(byDefender, ball);
        bm.release(vx, vy);
        if (onComplete) onComplete();
    }

    function onReceive() {
        bm.possess(players[receiverIdx], POSSESS_OFFSET);
        bm.snapToFront();
        passReceiver.reset();
        inFlight = false; isLongPass = false;
        passTimer = PASS_DELAY; passerReturnTimer = 0;
        holderIdx = receiverIdx;
        receiverIdx = chooseReceiverAvoidBoth(holderIdx);
        setTargetAngle(holderIdx, angleTo(players[holderIdx].x, players[holderIdx].y, players[receiverIdx].x, players[receiverIdx].y));
        for (let i = 0; i < PLAYERS_COUNT; i++) if (i !== holderIdx) setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));
    }

    // 초기화
    receiverIdx = chooseReceiverAvoidBoth(holderIdx);
    setTargetAngle(holderIdx, angleTo(players[holderIdx].x, players[holderIdx].y, players[receiverIdx].x, players[receiverIdx].y));
    players[holderIdx].setAngle(pms[holderIdx].getDesiredAngle());
    for (let i = 0; i < PLAYERS_COUNT; i++) if (i !== holderIdx) { players[i].setAngle(INITIAL_ANGLES[i]); setTargetAngle(i, INITIAL_ANGLES[i]); }
    defenderA.setAngle(angleTo(defenderA.x, defenderA.y, players[holderIdx].x, players[holderIdx].y));
    defenderB.setAngle(angleTo(defenderB.x, defenderB.y, players[holderIdx].x, players[holderIdx].y));
    bm.possess(players[holderIdx], POSSESS_OFFSET);
    bm.snapToFront();

    function updateBlockDefender(dt) {
        if (!defenderStarted || finished) return;
        blockPM.update(dt);
        // 재타게팅 주기 0.35s — 체이서(0.45s)보다 약간 빠르게 레인 선점
        if (updateBlockDefender._t === undefined) updateBlockDefender._t = 0;
        updateBlockDefender._t -= dt;
        if (updateBlockDefender._t > 0) return;
        updateBlockDefender._t = 0.35;

        let tx, ty;
        if (inFlight) {
            // 현재 패스 레인 중간 차단 — 체이서는 볼을 쫓고, 블로커는 레인 중간을 커트
            const hx = players[holderIdx].x, hy = players[holderIdx].y;
            const rx = players[receiverIdx].x, ry = players[receiverIdx].y;
            tx = hx + (rx - hx) * 0.5;
            ty = hy + (ry - hy) * 0.5;
        } else {
            // 홀더가 가장 볼 수 있을 레인 예측 — 그 레인 45% 지점 선점
            const predicted = chooseReceiverAvoidBoth(holderIdx);
            const hx = players[holderIdx].x, hy = players[holderIdx].y;
            const rx = players[predicted].x, ry = players[predicted].y;
            tx = hx + (rx - hx) * 0.45;
            ty = hy + (ry - hy) * 0.45;
            // 두 수비수가 같은 레인에 겹치지 않도록 체이서 반대편으로 살짝 오프셋
            const midX = (hx + rx)/2, midY = (hy + ry)/2;
            const vx = defenderA.x - midX, vy = defenderA.y - midY;
            if (Math.hypot(vx, vy) < 40) {
                // 체이서가 블록 타겟 근처에 있으면 블로커는 반대 수직으로 18px 벌림
                const dx = rx - hx, dy = ry - hy;
                const len = Math.hypot(dx, dy) || 1;
                const nx = -dy/len, ny = dx/len;
                const side = (vx*nx + vy*ny) >= 0 ? 1 : -1;
                tx += nx * side * 22;
                ty += ny * side * 22;
            }
        }
        // 블록 수비 속도 — 체이서(최대75)보다 약간 빠르게 레인 선점하되 협력 상한 유지
        blockPM.speed = 85;
        blockPM.moveTo(tx, ty);
    }

    function tick(dt) {
        if (finished) { bm.update(dt); return; }

        bm.update(dt);
        smoothAngles(dt);
        chasePM.update(dt);
        chaseAI.update(dt, ball.x, ball.y, bm.vx, bm.vy);
        updateBlockDefender(dt);

        if (CollisionSystem.isTackle(defenderA, ball)) { handleIntercept(defenderA); return; }
        if (CollisionSystem.isTackle(defenderB, ball)) { handleIntercept(defenderB); return; }

        if (inFlight) {
            passerReturnTimer -= dt;
            if (passerReturnTimer <= 0) moveTowardHome(holderIdx, dt, passerReturnSpeed);
            setTargetAngle(receiverIdx, angleTo(players[receiverIdx].x, players[receiverIdx].y, ball.x, ball.y));
            passReceiver.update(dt, players[receiverIdx], () => {
                if (isLongPass) return { x: aerialLandX, y: aerialLandY };
                return PassMovement.interceptPoint(bm, players[receiverIdx]);
            });
            for (let i = 0; i < PLAYERS_COUNT; i++) if (i !== holderIdx && i !== receiverIdx) {
                setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));
                idle.update(dt, players[i], i, homeOf(i).x, homeOf(i).y);
            }
            if (!isLongPass) {
                const dist = Math.hypot(players[receiverIdx].x - ball.x, players[receiverIdx].y - ball.y);
                if (dist < RECEIVE_DIST) onReceive();
            }
        } else {
            bm.snapToFront();
            moveTowardHome(receiverIdx, dt);
            setTargetAngle(receiverIdx, angleTo(players[receiverIdx].x, players[receiverIdx].y, ball.x, ball.y));
            idle.update(dt, players[holderIdx], holderIdx, homeOf(holderIdx).x, homeOf(holderIdx).y);
            for (let i = 0; i < PLAYERS_COUNT; i++) if (i !== holderIdx && i !== receiverIdx) {
                setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));
                idle.update(dt, players[i], i, homeOf(i).x, homeOf(i).y);
            }
            passTimer -= dt;
            if (passTimer <= 0) {
                receiverIdx = chooseReceiverAvoidBoth(holderIdx);
                setTargetAngle(holderIdx, angleTo(players[holderIdx].x, players[holderIdx].y, players[receiverIdx].x, players[receiverIdx].y));
                players[holderIdx].setAngle(pms[holderIdx].getDesiredAngle());
                bm.snapToFront();
                isLongPass = Math.random() < LONG_PASS_CHANCE;
                const deviationRad = (Math.random() * 2 - 1) * PASS_ANGLE_DEG * Math.PI / 180;
                if (isLongPass) {
                    const receiver = players[receiverIdx];
                    const fwd = forwardVector(receiver.angle);
                    const footX = receiver.x + fwd.x*POSSESS_OFFSET, footY = receiver.y + fwd.y*POSSESS_OFFSET;
                    const dist = Math.hypot(players[holderIdx].x - players[receiverIdx].x, players[holderIdx].y - players[receiverIdx].y);
                    const result = PassMovement.longPass(bm, footX, footY, { deviationRad, flightDuration: Math.max(0.55, dist/420), onLand: onReceive });
                    aerialLandX = result.landX; aerialLandY = result.landY;
                    passerReturnSpeed = calcPasserReturnSpeed(result.flightDuration);
                } else {
                    const result = PassMovement.shortPass(bm, players[receiverIdx].x, players[receiverIdx].y, { deviationRad, arriveSpeed: 170 });
                    passerReturnSpeed = calcPasserReturnSpeed(result.timeToArrive);
                }
                passReceiver.arm();
                inFlight = true; passerReturnTimer = PASSER_RETURN_DELAY;
                if (!defenderStarted) { defenderStarted = true; chaseAI.start(); }
            }
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        chaseAI.stop(); chasePM.stop(); blockPM.stop();
        for (const pm of pms) pm.stop();
    };
}
