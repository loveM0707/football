/**
 * FourPlayerPass - 4인 패스 순환
 *
 * 배치: 하프라인 중심에서 정사각형 형태
 *   선수A: 왼쪽 위 (x=HALF_X-30, y=CENTER_Y-30)
 *   선수B: 왼쪽 아래 (x=HALF_X-30, y=CENTER_Y+30)
 *   선수C: 오른쪽 위 (x=HALF_X+30, y=CENTER_Y-30)
 *   선수D: 오른쪽 아래 (x=HALF_X+30, y=CENTER_Y+30)
 *
 * 볼 소유자: 랜덤 시작
 *
 * 패스 종류 (매 패스마다 랜덤):
 *   - 숏패스 (60%): 지면 굴림
 *   - 롱패스 (40%): 공중 포물선, onLand 콜백으로 수신 처리
 *
 * 수신 공통 (PassReceiver):
 *   - 패스 직후 REACTION_DELAY 대기 (반사신경)
 *   - 반응 후 착지/예측 Y를 향해 Y축 이동 (X축 고정)
 *
 * 이동:
 *   - 선수 각도 고정 (setAngle), PlayerMovement 미사용
 *   - 홈 복귀/인터셉트 모두 setPosition 직접 사용
 *   - 패서: 패스 직후 잠시 정지(PASSER_RETURN_DELAY), 이후 패스 비행시간+PASS_DELAY에
 *          맞춰 역산된 느린 속도로 홈 복귀 → 수신 직전 정확히 도착
 *   - 수신자: 소유 중 홈 복귀, 패스 비행 중 Y축 인터셉트
 *
 * 볼 수신 후 방향전환 후 패스: 패스를 받은 선수가 방향을 전환하여
 * 나머지 선수 중 랜덤한 선수에게 패스함.
 */
import { Player }        from '../entities/Player.js';
import { Ball }          from '../entities/Ball.js';
import { BallMovement }  from '../movement/BallMovement.js';
import { PassMovement }  from '../movement/PassMovement.js';
import { PassReceiver }  from '../movement/PassReceiver.js';

const CENTER_Y   = 340;
const HALF_X     = 525;

const POSITIONS = [
    { x: HALF_X - 30, y: CENTER_Y - 30, angle: 180 },   // 왼쪽 위
    { x: HALF_X - 30, y: CENTER_Y + 30, angle:  0 },   // 왼쪽 아래
    { x: HALF_X + 30, y: CENTER_Y - 30, angle: 180 },   // 오른쪽 위
    { x: HALF_X + 30, y: CENTER_Y + 30, angle:  0 },    // 오른쪽 아래
];

const POSSESS_OFFSET     = Player.BODY_RADIUS + Ball.RADIUS + 4;  // 19
const RECEIVE_DIST       = POSSESS_OFFSET + 3;                    // 22
const PASS_DELAY          = 0.4;  // 볼 보유 후 패스까지 대기 (초)
const PASSER_RETURN_DELAY = 0.2;  // 패스 직후 복귀 시작 전 짧은 정지 (초)
const PASS_ANGLE_DEG      = 5;    // 패스 각도 최대 편차 (도)
const LONG_PASS_CHANCE    = 0.4;
const HOME_SPEED          = 75;   // SVG/s 소유 중 수신자 홈 복귀 속도
const Y_MIN              = 45;
const Y_MAX              = 635;

const PLAYERS_COUNT = 4;

export function run(layer, loop, onComplete = null) {
    const players = [];
    for (let i = 0; i < PLAYERS_COUNT; i++) {
        const pos = POSITIONS[i];
        const player = new Player({
            x: pos.x, y: pos.y, team: 'home', number: i + 1, angle: pos.angle,
        }).render(layer);
        players.push(player);
    }

    const ball = new Ball(players[0].x, players[0].y).render(layer);
    const bm   = new BallMovement(ball);

    const homePositions = players.map(p => ({ x: p.x, y: p.y }));

    const passReceiver = new PassReceiver();

    let holderIdx   = 0;
    let receiverIdx = 1;
    let passTimer          = PASS_DELAY;
    let inFlight           = false;
    let isLongPass         = false;
    let aerialLandY        = CENTER_Y;
    let passerReturnTimer  = 0;
    let passerReturnSpeed  = HOME_SPEED;

    function homeOf(idx) { return { x: players[idx].x, y: players[idx].y }; }

    function moveTowardHome(player, dt, speed = HOME_SPEED) {
        const home = homeOf(holderIdx);
        const dx   = home.x - player.x;
        const dy   = home.y - player.y;
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

    function getRandomReceiver(holderIdx) {
        const available = [0, 1, 2, 3].filter(i => i !== holderIdx);
        return available[Math.floor(Math.random() * available.length)];
    }

    function onReceive() {
        bm.possess(players[receiverIdx], POSSESS_OFFSET);
        bm.snapToFront();
        passReceiver.reset();
        inFlight          = false;
        isLongPass        = false;
        passTimer         = PASS_DELAY;
        passerReturnTimer = 0;

        // 이전 holder가 홈으로 복귀하도록 holder 교체
        holderIdx = receiverIdx;

        // 다음 랜덤 리시버 선택 (홀더가 아닌 다른 선수)
        receiverIdx = getRandomReceiver(holderIdx);

        // 볼 소유자 player 각도 설정 (패스 방향)
        const targetPos = POSITIONS[receiverIdx];
        players[receiverIdx].setAngle(targetPos.angle);
    }

    function tick(dt) {
        for (let i = 0; i < PLAYERS_COUNT; i++) {
            players[i].setAngle(POSITIONS[i].angle);
        }

        bm.update(dt);

        if (inFlight) {
            // 패서: 짧은 정지 후 역산된 느린 속도로 홈 복귀
            passerReturnTimer -= dt;
            if (passerReturnTimer <= 0) {
                moveTowardHome(players[holderIdx], dt, passerReturnSpeed);
            }

            // 수신자: 반응 후 Y축 인터셉트 (숏/롱패스 공통)
            passReceiver.update(dt, players[receiverIdx], () => {
                if (isLongPass) return aerialLandY;
                return PassMovement.interceptPoint(bm, players[receiverIdx], { yMin: Y_MIN, yMax: Y_MAX }).y;
            });

            // 숏패스 수신 판정 (지면 볼)
            if (!isLongPass) {
                const dist = Math.hypot(players[receiverIdx].x - ball.x, players[receiverIdx].y - ball.y);
                if (dist < RECEIVE_DIST) onReceive();
            }
            // 롱패스: bm.update() 내 onLand → onReceive 자동 호출

        } else {
            // 소유 중: 볼 위치 유지, 수신자(이전 패서)는 홈 복귀
            bm.snapToFront();
            moveTowardHome(players[receiverIdx], dt);

            passTimer -= dt;
            if (passTimer <= 0) {
                isLongPass = Math.random() < LONG_PASS_CHANCE;

                if (isLongPass) {
                    // 홀더 위치 기반 롱패스 목표 설정
                    const holder = players[holderIdx];
                    const rad   = holder.angle * Math.PI / 180;
                    const fwdX  = -Math.sin(rad);
                    const fwdY  =  Math.cos(rad);
                    const footX = holder.x + fwdX * POSSESS_OFFSET;
                    const footY = holder.y + fwdY * POSSESS_OFFSET;

                    // 리시버는 랜덤 (홀더 제외)
                    const possibleReceivers = [0, 1, 2, 3].filter(i => i !== holderIdx);
                    const randomReceiverIdx = possibleReceivers[Math.floor(Math.random() * possibleReceivers.length)];
                    const receiver = players[randomReceiverIdx];

                    const result = PassMovement.longPass(bm, receiver.x, receiver.y, {
                        angleDevDeg: PASS_ANGLE_DEG,
                        onLand: onReceive,
                    });
                    aerialLandY        = result.landY;
                    passerReturnSpeed  = calcPasserReturnSpeed(result.flightDuration);
                } else {
                    // 숏패스: 랜덤 리시버에게 패스
                    const possibleReceivers = [0, 1, 2, 3].filter(i => i !== holderIdx);
                    const randomReceiverIdx = possibleReceivers[Math.floor(Math.random() * possibleReceivers.length)];
                    const receiver = players[randomReceiverIdx];

                    const result = PassMovement.shortPass(bm, receiver.x, receiver.y, {
                        angleDevDeg: PASS_ANGLE_DEG,
                    });
                    passerReturnSpeed  = calcPasserReturnSpeed(result.timeToArrive);
                }

                passReceiver.arm();
                inFlight          = true;
                passerReturnTimer  = PASSER_RETURN_DELAY;
            }
        }
    }

    loop.add(tick);

    return function stop() {
        loop.remove(tick);
    };
}
