/**
 * FourPlayerPassDefense - 4인 패스(수비)
 *
 * 배치: 4인 패스와 동일한 정사각형 (간격 100 SVG) + 중앙 수비수
 *   선수0: 왼쪽 위   (HALF_X-100, CENTER_Y-100)  빨강
 *   선수1: 왼쪽 아래 (HALF_X-100, CENTER_Y+100)  빨강
 *   선수2: 오른쪽 위 (HALF_X+100, CENTER_Y-100)  빨강
 *   선수3: 오른쪽 아래(HALF_X+100, CENTER_Y+100) 빨강
 *   수비수: 중앙 (HALF_X, CENTER_Y)  파랑
 *
 * 초기 상태:
 *   - 모든 빨강 선수: 센터를 향해 바라봄
 *   - 수비수: 홀더 방향
 *   - 볼은 선수0(왼쪽 위) 발 앞, 선수0이 첫 패스를 시작
 *
 * 빨강 로직 (선수/패스 모듈):
 *   - IdleMovement: 비참여 시 홈 근처 미세 움직임
 *   - PassReceiver + PassMovement: 수신 반응·인터셉트
 *   - 수비 없는 곳으로 패스: holder가 3명의 후보 중
 *     수비수와의 거리(수신자 거리 + 패스 라인 거리)가 가장 큰 쪽을 선택
 *
 * 파랑 로직 (선수 모듈):
 *   - 초기에는 중앙에서 정지
 *   - 첫 패스 시작 직후 DefenderAI (PlayerMovement 기반): 볼 chasing, 거리 비례 속도
 *   - CollisionSystem.isTackle: 볼 접촉 시 인터셉트 판정 → 바운스 + onComplete
 */
import { Player }           from '../entities/Player.js';
import { Ball }             from '../entities/Ball.js';
import { BallMovement }     from '../movement/BallMovement.js';
import { PassMovement }     from '../movement/PassMovement.js';
import { PassReceiver }     from '../movement/PassReceiver.js';
import { IdleMovement }     from '../movement/IdleMovement.js';
import { PlayerMovement }   from '../movement/PlayerMovement.js';
import { DefenderAI }       from '../movement/DefenderAI.js';
import { NonStopPass }      from '../movement/NonStopPass.js';
import { CollisionSystem }  from '../movement/CollisionSystem.js';
import { angleTo, forwardVector } from '../movement/Direction.js';

const CENTER_Y = 340;
const HALF_X   = 525;
const CENTER_X = HALF_X;

const OFFSET = 100;

const POSITIONS = [
    { x: HALF_X - OFFSET, y: CENTER_Y - OFFSET },
    { x: HALF_X - OFFSET, y: CENTER_Y + OFFSET },
    { x: HALF_X + OFFSET, y: CENTER_Y - OFFSET },
    { x: HALF_X + OFFSET, y: CENTER_Y + OFFSET },
];

const INITIAL_ANGLES = POSITIONS.map(p => angleTo(p.x, p.y, CENTER_X, CENTER_Y));

const POSSESS_OFFSET      = Player.BODY_RADIUS + Ball.RADIUS + 4; // 19
const RECEIVE_DIST        = POSSESS_OFFSET + 3;                   // 22
const PASS_DELAY          = 0.4;
const PASSER_RETURN_DELAY = 0.2;
const PASS_ANGLE_DEG      = 5;
const LONG_PASS_CHANCE    = 0.4;
const HOME_SPEED          = 75;

const PLAYERS_COUNT = 4;

function distPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 0.01) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
}

export function run(layer, loop, onComplete = null) {
    const players = [];
    for (let i = 0; i < PLAYERS_COUNT; i++) {
        const pos = POSITIONS[i];
        players.push(new Player({
            x: pos.x, y: pos.y, team: 'home', number: i + 1, angle: INITIAL_ANGLES[i],
        }).render(layer));
    }

    const defender = new Player({
        x: CENTER_X, y: CENTER_Y, team: 'away', number: 5, angle: 90,
    }).render(layer);

    const ball = new Ball(players[0].x, players[0].y).render(layer);
    const bm   = new BallMovement(ball);

    const homePositions = POSITIONS.map(p => ({ x: p.x, y: p.y }));

    const passReceiver = new PassReceiver();
    const idle         = new IdleMovement(PLAYERS_COUNT);
    const nonStopPass  = new NonStopPass();
    const defPM        = new PlayerMovement(defender);
    // 수비수도 공격수와 같은 PlayerMovement 속도 단계를 사용한다.
    const defAI        = new DefenderAI(defPM, defender, {
        retargetInterval: 0.45,
    });

    const pms = players.map(p => new PlayerMovement(p, { turnBeforeMove: false, maxVel: 360 }));
    function setTargetAngle(idx, ang) { pms[idx].setFacingTarget(ang); }
    function smoothAngles(dt) { for (let i = 0; i < PLAYERS_COUNT; i++) pms[i].update(dt); }

    let holderIdx         = 0;
    let receiverIdx       = -1;
    let passTimer         = PASS_DELAY;
    let inFlight          = false;
    let isLongPass        = false;
    let aerialLandX       = CENTER_X;
    let aerialLandY       = CENTER_Y;
    let passerReturnTimer = 0;
    let passerReturnSpeed = HOME_SPEED;
    let finished          = false;
    let defenderStarted   = false;

    function homeOf(idx) { return homePositions[idx]; }

    function moveTowardHome(playerIdx, dt, speed = HOME_SPEED) {
        const player = players[playerIdx];
        const home = homeOf(playerIdx);
        const dx = home.x - player.x;
        const dy = home.y - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return;
        const step = Math.min(speed * dt, dist);
        player.setPosition(
            player.x + (dx / dist) * step,
            player.y + (dy / dist) * step,
        );
    }

    function calcPasserReturnSpeed(flightTime) {
        const home = homeOf(holderIdx);
        const dist = Math.hypot(players[holderIdx].x - home.x, players[holderIdx].y - home.y);
        if (dist < 1) return HOME_SPEED;
        const available = flightTime + PASS_DELAY - PASSER_RETURN_DELAY;
        if (available < 0.1) return HOME_SPEED;
        return dist / available;
    }

    function chooseReceiverAvoidDefender(hIdx) {
        const candidates = [0, 1, 2, 3].filter(i => i !== hIdx);
        let bestIdx = candidates[0];
        let bestScore = -Infinity;
        for (const c of candidates) {
            const rx = players[c].x;
            const ry = players[c].y;
            const hx = players[hIdx].x;
            const hy = players[hIdx].y;
            const distToReceiver = Math.hypot(defender.x - rx, defender.y - ry);
            const distToLine = distPointToSegment(defender.x, defender.y, hx, hy, rx, ry);
            // 패스 라인 차단 위험을 더 크게 가중, 수신자 주변 여유도 함께 고려
            const score = distToLine * 1.8 + distToReceiver * 1.0 + Math.random() * 6;
            if (score > bestScore) {
                bestScore = score;
                bestIdx = c;
            }
        }
        return bestIdx;
    }

    function faceTarget(hIdx, tIdx) {
        setTargetAngle(hIdx, angleTo(players[hIdx].x, players[hIdx].y, players[tIdx].x, players[tIdx].y));
    }

    function kickPass() {
        isLongPass = Math.random() < LONG_PASS_CHANCE;
        const deviationRad = (Math.random() * 2 - 1) * PASS_ANGLE_DEG * Math.PI / 180;
        if (isLongPass) {
            const receiver = players[receiverIdx];
            const fwd = forwardVector(receiver.angle);
            const footX = receiver.x + fwd.x * POSSESS_OFFSET;
            const footY = receiver.y + fwd.y * POSSESS_OFFSET;
            const dist = Math.hypot(
                players[holderIdx].x - players[receiverIdx].x,
                players[holderIdx].y - players[receiverIdx].y,
            );
            const result = PassMovement.longPass(bm, footX, footY, {
                deviationRad,
                flightDuration: Math.max(0.55, dist / 420),
                onLand: onReceive,
            });
            aerialLandX = result.landX;
            aerialLandY = result.landY;
            passerReturnSpeed = calcPasserReturnSpeed(result.flightDuration);
        } else {
            const receiver = players[receiverIdx];
            const result = PassMovement.shortPass(bm, receiver.x, receiver.y, {
                deviationRad,
                arriveSpeed: 170,
            });
            passerReturnSpeed = calcPasserReturnSpeed(result.timeToArrive);
        }

        passReceiver.arm();
        inFlight = true;
        passerReturnTimer = PASSER_RETURN_DELAY;
    }

    function handleIntercept() {
        if (finished) return;
        finished = true;
        passReceiver.reset();
        defAI.stop();
        defPM.stop();
        const { vx, vy } = CollisionSystem.bounceVelocity(defender, ball);
        bm.release(vx, vy);
        if (onComplete) onComplete();
    }

    function onReceive() {
        bm.possess(players[receiverIdx], POSSESS_OFFSET);
        bm.snapToFront();
        passReceiver.reset();
        inFlight = false;
        isLongPass = false;
        passTimer = PASS_DELAY;
        passerReturnTimer = 0;

        holderIdx = receiverIdx;
        receiverIdx = chooseReceiverAvoidDefender(holderIdx);

        setTargetAngle(holderIdx, angleTo(
            players[holderIdx].x, players[holderIdx].y,
            players[receiverIdx].x, players[receiverIdx].y,
        ));

        for (let i = 0; i < PLAYERS_COUNT; i++) {
            if (i !== holderIdx) {
                setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));
            }
        }

        nonStopPass.tryPass({
            receiver: players[holderIdx],
            target: players[receiverIdx],
            defenders: [defender],
            onPass: ({ angle }) => {
                setTargetAngle(holderIdx, angle);
                kickPass();
            },
        });
    }

    // 초기화
    receiverIdx = chooseReceiverAvoidDefender(holderIdx);
    setTargetAngle(holderIdx, angleTo(
        players[holderIdx].x, players[holderIdx].y,
        players[receiverIdx].x, players[receiverIdx].y,
    ));
    players[holderIdx].setAngle(pms[holderIdx].getDesiredAngle());
    for (let i = 0; i < PLAYERS_COUNT; i++) {
        if (i !== holderIdx) {
            players[i].setAngle(INITIAL_ANGLES[i]);
            setTargetAngle(i, INITIAL_ANGLES[i]);
        }
    }
    // 수비수 초기 각도: 홀더 방향
    defender.setAngle(angleTo(defender.x, defender.y, players[holderIdx].x, players[holderIdx].y));

    bm.possess(players[holderIdx], POSSESS_OFFSET);
    bm.snapToFront();

    // 수비수는 첫 패스 전까지 중앙에서 대기 — defAI.start()를 패스 시작 시점으로 지연

    function tick(dt) {
        if (finished) {
            bm.update(dt);
            return;
        }

        bm.update(dt);
        smoothAngles(dt);
        defPM.update(dt);
        defAI.update(dt, ball.x, ball.y, bm.vx, bm.vy);

        // 수비수 태클/인터셉트 판정: 소유 중이거나 비행 중 모두
        if (CollisionSystem.isTackle(defender, ball)) {
            // 소유 중이거나 볼이 자유/공중 상태일 때 수비수가 볼에 닿으면 빼앗김
            // 단, 이미 onReceive 직후 등 순간 겹침 오탐 방지: inFlight 중이거나 owner 있을 때만
            handleIntercept();
            return;
        }

        if (inFlight) {
            passerReturnTimer -= dt;
            if (passerReturnTimer <= 0) {
                moveTowardHome(holderIdx, dt, passerReturnSpeed);
            }

            setTargetAngle(receiverIdx, angleTo(
                players[receiverIdx].x, players[receiverIdx].y, ball.x, ball.y,
            ));
            passReceiver.update(dt, players[receiverIdx], () => {
                if (isLongPass) return { x: aerialLandX, y: aerialLandY };
                return PassMovement.interceptPoint(bm, players[receiverIdx]);
            });

            for (let i = 0; i < PLAYERS_COUNT; i++) {
                if (i !== holderIdx && i !== receiverIdx) {
                    setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));
                    idle.update(dt, players[i], i, homeOf(i).x, homeOf(i).y);
                }
            }

            if (!isLongPass) {
                const dist = Math.hypot(players[receiverIdx].x - ball.x, players[receiverIdx].y - ball.y);
                if (dist < RECEIVE_DIST) onReceive();
            }

        } else {
            bm.snapToFront();

            moveTowardHome(receiverIdx, dt);
            setTargetAngle(receiverIdx, angleTo(
                players[receiverIdx].x, players[receiverIdx].y, ball.x, ball.y,
            ));

            idle.update(dt, players[holderIdx], holderIdx, homeOf(holderIdx).x, homeOf(holderIdx).y);

            for (let i = 0; i < PLAYERS_COUNT; i++) {
                if (i !== holderIdx && i !== receiverIdx) {
                    setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));
                    idle.update(dt, players[i], i, homeOf(i).x, homeOf(i).y);
                }
            }

            passTimer -= dt;
            if (passTimer <= 0) {
                // 수비 위치를 고려해 최적 패스 대상 재선정 (홀더가 움직였을 수 있음)
                receiverIdx = chooseReceiverAvoidDefender(holderIdx);
                setTargetAngle(holderIdx, angleTo(
                    players[holderIdx].x, players[holderIdx].y,
                    players[receiverIdx].x, players[receiverIdx].y,
                ));
                players[holderIdx].setAngle(pms[holderIdx].getDesiredAngle());
                bm.snapToFront();

                kickPass();

                if (!defenderStarted) {
                    defenderStarted = true;
                    defAI.start();
                }
            }
        }
    }

    loop.add(tick);

    return function stop() {
        loop.remove(tick);
        defAI.stop();
        defPM.stop();
        for (const pm of pms) pm.stop();
    };
}
