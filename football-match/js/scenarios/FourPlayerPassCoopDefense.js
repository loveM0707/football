/**
 * FourPlayerPassCoopDefense - 4인 패스(협력수비)
 *
 * 배치: 4인 패스(수비)와 동일 구조이나 간격 120 + 수비수 3명
 *   선수0: 왼쪽 위   (HALF_X-120, CENTER_Y-120) 빨강
 *   선수1: 왼쪽 아래 (HALF_X-120, CENTER_Y+120) 빨강
 *   선수2: 오른쪽 위 (HALF_X+120, CENTER_Y-120) 빨강
 *   선수3: 오른쪽 아래(HALF_X+120, CENTER_Y+120) 빨강
 *   수비수A~C: 중앙 부근에 배치된 파랑 수비수 3명 (역할은 상황에 따라 변경)
 *
 * 초기: 모든 빨강 센터향, 수비수 홀더 방향, 볼은 선수0 발 앞, 첫 패스 후 수비 기동
 *
 * 빨강: IdleMovement + PassReceiver/PassMovement, 3명 수비 모두 고려해 가장 여유 있는 대상에 패스
 * 파랑: CooperativeDefenseAI가 압박·패스 레인 차단·맨마킹·커버를 상황에 따라 재배정
 */
import { Player }          from '../entities/Player.js';
import { Ball }            from '../entities/Ball.js';
import { BallMovement }    from '../movement/BallMovement.js';
import { PassMovement }    from '../movement/PassMovement.js';
import { PassReceiver }    from '../movement/PassReceiver.js';
import { IdleMovement }    from '../movement/IdleMovement.js';
import { PlayerMovement }  from '../movement/PlayerMovement.js';
import { CooperativeDefenseAI } from '../movement/CooperativeDefenseAI.js';
import { NonStopPass }     from '../movement/NonStopPass.js';
import { CollisionSystem } from '../movement/CollisionSystem.js';
import { angleTo, forwardVector } from '../movement/Direction.js';
import { CENTER_Y, CENTER_X, HALF_X } from '../movement/FieldGeometry.js';
import { PassDecision } from '../movement/PassDecision.js';
import { PassAccuracy } from '../movement/PassAccuracy.js';

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
const HOME_SPEED          = 75;
const PLAYERS_COUNT = 4;

export function run(layer, loop, onComplete = null) {
    const players = [];
    for (let i = 0; i < PLAYERS_COUNT; i++) {
        const pos = POSITIONS[i];
        players.push(new Player({ x: pos.x, y: pos.y, team: 'home', number: i+1, angle: INITIAL_ANGLES[i] }).render(layer));
    }

    const defenderA = new Player({ x: CENTER_X - 18, y: CENTER_Y, team: 'away', number: 5, angle: 90 }).render(layer);
    const defenderB = new Player({ x: CENTER_X + 18, y: CENTER_Y, team: 'away', number: 6, angle: 90 }).render(layer);
    const defenderC = new Player({ x: CENTER_X, y: CENTER_Y - 40, team: 'away', number: 7, angle: 90 }).render(layer);
    const defenders = [defenderA, defenderB, defenderC];

    const ball = new Ball(players[0].x, players[0].y).render(layer);
    const bm = new BallMovement(ball);
    const homePositions = POSITIONS.map(p => ({ x: p.x, y: p.y }));
    const passReceiver = new PassReceiver();
    const idle = new IdleMovement(PLAYERS_COUNT);
    const nonStopPass = new NonStopPass();
    // 패스 대상·정확도는 공통 모듈이 담당한다 (랜덤 선택·편차 제거)
    const passDecision = new PassDecision();
    const passAccuracy = new PassAccuracy();

    const defenseAI = new CooperativeDefenseAI(
        defenders.map(player => ({ player, movement: new PlayerMovement(player) })),
        {
            assignmentInterval: 0.35,
            retargetInterval: 0.15,
            switchPenalty: 14,
        },
    );

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

    function chooseReceiverAvoidDefenders(hIdx) {
        // 3명의 수비를 피해 가장 여유 있는 동료를 선택한다 (공통 모듈)
        const res = passDecision.evaluate({
            passer: players[hIdx],
            candidates: [0,1,2,3].filter(i => i !== hIdx)
                .map(i => ({ player: players[i], idx: i })),
            opponents: defenders,
        });
        if (res.ok) return res.idx;
        return [0,1,2,3].filter(i => i !== hIdx)[0];
    }

    function kickPass() {
        // 드릴 variety: 숏/롱을 번갈아 연습한다 (시나리오 연출, 엔진 랜덤 아님)
        isLongPass = !isLongPass;
        // 정확도: 거리·수비 압박 기반 (무조건 ±5도 랜덤 제거)
        const acc = passAccuracy.evaluate({
            dist: Math.hypot(
                players[receiverIdx].x - players[holderIdx].x,
                players[receiverIdx].y - players[holderIdx].y),
            nearestOpp: PassAccuracy.nearestOpponent(players[holderIdx], defenders),
        });
        const deviationRad = acc.deviationRad;
        if (isLongPass) {
            const receiver = players[receiverIdx];
            const fwd = forwardVector(receiver.angle);
            const footX = receiver.x + fwd.x*POSSESS_OFFSET;
            const footY = receiver.y + fwd.y*POSSESS_OFFSET;
            const dist = Math.hypot(
                players[holderIdx].x - players[receiverIdx].x,
                players[holderIdx].y - players[receiverIdx].y,
            );
            const result = PassMovement.longPass(bm, footX, footY, {
                deviationRad,
                flightDuration: Math.max(0.55, dist/420),
                onLand: onReceive,
            });
            aerialLandX = result.landX;
            aerialLandY = result.landY;
            passerReturnSpeed = calcPasserReturnSpeed(result.flightDuration);
        } else {
            const result = PassMovement.shortPass(bm, players[receiverIdx].x, players[receiverIdx].y, {
                deviationRad,
                arriveSpeed: 170,
            });
            passerReturnSpeed = calcPasserReturnSpeed(result.timeToArrive);
        }

        passReceiver.arm();
        inFlight = true;
        passerReturnTimer = PASSER_RETURN_DELAY;
    }

    function handleIntercept(byDefender) {
        if (finished) return;
        finished = true;
        passReceiver.reset();
        defenseAI.stop();
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
        receiverIdx = chooseReceiverAvoidDefenders(holderIdx);
        setTargetAngle(holderIdx, angleTo(players[holderIdx].x, players[holderIdx].y, players[receiverIdx].x, players[receiverIdx].y));
        for (let i = 0; i < PLAYERS_COUNT; i++) if (i !== holderIdx) setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));

        nonStopPass.tryPass({
            receiver: players[holderIdx],
            target: players[receiverIdx],
            defenders,
            onPass: ({ angle }) => {
                setTargetAngle(holderIdx, angle);
                kickPass();
            },
        });
    }

    // 초기화
    receiverIdx = chooseReceiverAvoidDefenders(holderIdx);
    setTargetAngle(holderIdx, angleTo(players[holderIdx].x, players[holderIdx].y, players[receiverIdx].x, players[receiverIdx].y));
    players[holderIdx].setAngle(pms[holderIdx].getDesiredAngle());
    for (let i = 0; i < PLAYERS_COUNT; i++) if (i !== holderIdx) { players[i].setAngle(INITIAL_ANGLES[i]); setTargetAngle(i, INITIAL_ANGLES[i]); }
    for (const defender of defenders) {
        defender.setAngle(angleTo(defender.x, defender.y, players[holderIdx].x, players[holderIdx].y));
    }
    bm.possess(players[holderIdx], POSSESS_OFFSET);
    bm.snapToFront();

    function tick(dt) {
        if (finished) { bm.update(dt); return; }

        bm.update(dt);
        smoothAngles(dt);
        defenseAI.update(dt, {
            ball,
            ballVelocity: { x: bm.vx, y: bm.vy },
            attackers: players,
            holderIndex: holderIdx,
            receiverIndex: receiverIdx,
            inFlight,
        });

        for (const defender of defenders) {
            if (CollisionSystem.isTackle(defender, ball)) {
                handleIntercept(defender);
                return;
            }
        }

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
                receiverIdx = chooseReceiverAvoidDefenders(holderIdx);
                setTargetAngle(holderIdx, angleTo(players[holderIdx].x, players[holderIdx].y, players[receiverIdx].x, players[receiverIdx].y));
                players[holderIdx].setAngle(pms[holderIdx].getDesiredAngle());
                bm.snapToFront();
                kickPass();
                if (!defenderStarted) { defenderStarted = true; defenseAI.start(); }
            }
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        defenseAI.stop();
        for (const pm of pms) pm.stop();
    };
}
