/**
 * FourPlayerPass - 4인 패스 순환
 *
 * 배치: 하프라인 중심에서 정사각형 형태 (간격 80 SVG)
 *   선수0: 왼쪽 위 (x=HALF_X-80, y=CENTER_Y-80) - 초기 볼 소유자
 *   선수1: 왼쪽 아래 (x=HALF_X-80, y=CENTER_Y+80)
 *   선수2: 오른쪽 위 (x=HALF_X+80, y=CENTER_Y-80)
 *   선수3: 오른쪽 아래 (x=HALF_X+80, y=CENTER_Y+80)
 *
 * 초기 상태:
 *   - 모든 선수는 센터(볼 위치)를 향해 바라봄
 *   - 볼은 선수0(왼쪽 위)의 발 앞에 위치
 *   - 선수0이 패스를 시작
 *
 * 패스 종류 (매 패스마다 랜덤):
 *   - 숏패스 (60%): 지면 굴림
 *   - 롱패스 (40%): 공중 포물선, onLand 콜백으로 수신 처리
 *
 * 수신 공통 (PassReceiver):
 *   - 패스 직후 REACTION_DELAY 대기 (반사신경)
 *   - 반응 후 볼 진행 방향과 수신자 정면 평면의 교점을 향해 측면 이동
 *
 * 패스 흐름:
 *   1. 홀더가 랜덤한 타겟을 향해 몸을 돌리고 패스
 *   2. 수신자는 볼을 향해 바라보면서 측면 인터셉트
 *   3. 미참여 선수들도 볼을 향함
 *   4. 수신 완료 후 다음 랜덤 타겟을 향해 몸을 돌림
 *   5. PASS_DELAY 후 패스 실행
 */
import { Player }        from '../entities/Player.js';
import { Ball }          from '../entities/Ball.js';
import { BallMovement }  from '../movement/BallMovement.js';
import { PassMovement }  from '../movement/PassMovement.js';
import { PassReceiver }  from '../movement/PassReceiver.js';

const CENTER_Y   = 340;
const HALF_X     = 525;
const CENTER_X   = HALF_X;

const OFFSET = 80; // 센터로부터 80 SVG

// 각도 계산: (x, y)에서 (tx, ty)를 향하는 각도
// fwdX = -sin(a), fwdY = cos(a) 기준
function angleTo(x, y, tx, ty) {
    return Math.atan2(x - tx, ty - y) * 180 / Math.PI;
}

const POSITIONS = [
    { x: HALF_X - OFFSET, y: CENTER_Y - OFFSET }, // 왼쪽 위
    { x: HALF_X - OFFSET, y: CENTER_Y + OFFSET }, // 왼쪽 아래
    { x: HALF_X + OFFSET, y: CENTER_Y - OFFSET }, // 오른쪽 위
    { x: HALF_X + OFFSET, y: CENTER_Y + OFFSET }, // 오른쪽 아래
];

// 초기 각도: 센터(525, 340)를 향함
const INITIAL_ANGLES = POSITIONS.map(p => angleTo(p.x, p.y, CENTER_X, CENTER_Y));

const POSSESS_OFFSET     = Player.BODY_RADIUS + Ball.RADIUS + 4;  // 19
const RECEIVE_DIST       = POSSESS_OFFSET + 3;                    // 22
const PASS_DELAY          = 0.4;  // 볼 보유 후 패스까지 대기 (초)
const PASSER_RETURN_DELAY = 0.2;  // 패스 직후 복귀 시작 전 짧은 정지 (초)
const PASS_ANGLE_DEG      = 5;    // 패스 각도 최대 편차 (도)
const LONG_PASS_CHANCE    = 0.4;
const HOME_SPEED          = 75;   // SVG/s 소유 중 수신자 홈 복귀 속도

const PLAYERS_COUNT = 4;

export function run(layer, loop, onComplete = null) {
    const players = [];
    for (let i = 0; i < PLAYERS_COUNT; i++) {
        const pos = POSITIONS[i];
        const player = new Player({
            x: pos.x, y: pos.y, team: 'home', number: i + 1, angle: INITIAL_ANGLES[i],
        }).render(layer);
        players.push(player);
    }

    // 볼은 선수0(왼쪽 위)의 발 앞에 위치
    const ball = new Ball(players[0].x, players[0].y).render(layer);
    const bm   = new BallMovement(ball);

    // 각 선수의 홈 포지션 (고정)
    const homePositions = POSITIONS.map(p => ({ x: p.x, y: p.y }));

    const passReceiver = new PassReceiver();

    let holderIdx          = 0;
    let receiverIdx        = -1;
    let passTimer          = PASS_DELAY;
    let inFlight           = false;
    let isLongPass         = false;
    let aerialLandX        = CENTER_X;
    let aerialLandY        = CENTER_Y;
    let passerReturnTimer  = 0;
    let passerReturnSpeed  = HOME_SPEED;

    function faceTarget(hIdx, tIdx) {
        const holder = players[hIdx];
        const target = players[tIdx];
        holder.setAngle(angleTo(holder.x, holder.y, target.x, target.y));
    }

    function faceBall(idx, ballX, ballY) {
        players[idx].setAngle(angleTo(players[idx].x, players[idx].y, ballX, ballY));
    }

    function homeOf(idx) { return homePositions[idx]; }

    function moveTowardHome(player, idx, dt, speed = HOME_SPEED) {
        const home = homeOf(idx);
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

    function getRandomReceiver(hIdx) {
        const available = [0, 1, 2, 3].filter(i => i !== hIdx);
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

        // 수신자가 새로운 홀더
        holderIdx   = receiverIdx;
        receiverIdx = getRandomReceiver(holderIdx);

        // 새 홀더는 다음 타겟을 향함
        faceTarget(holderIdx, receiverIdx);

        // 나머지 선수들은 볼을 향함
        for (let i = 0; i < PLAYERS_COUNT; i++) {
            if (i !== holderIdx) faceBall(i, ball.x, ball.y);
        }
    }

    // 초기화
    receiverIdx = getRandomReceiver(holderIdx);
    faceTarget(holderIdx, receiverIdx);
    for (let i = 0; i < PLAYERS_COUNT; i++) {
        if (i !== holderIdx) faceBall(i, ball.x, ball.y);
    }
    bm.possess(players[holderIdx], POSSESS_OFFSET);
    bm.snapToFront();

    function tick(dt) {
        bm.update(dt);

        if (inFlight) {
            // 패서: 짧은 정지 후 역산된 속도로 홈 복귀
            passerReturnTimer -= dt;
            if (passerReturnTimer <= 0) {
                moveTowardHome(players[holderIdx], holderIdx, dt, passerReturnSpeed);
            }

            // 수신자: 볼을 향해 바라보면서 측면 인터셉트
            faceBall(receiverIdx, ball.x, ball.y);
            passReceiver.update(dt, players[receiverIdx], () => {
                if (isLongPass) return { x: aerialLandX, y: aerialLandY };
                return PassMovement.interceptPoint(bm, players[receiverIdx]);
            });

            // 미참여 선수들도 볼을 향함
            for (let i = 0; i < PLAYERS_COUNT; i++) {
                if (i !== holderIdx && i !== receiverIdx) {
                    faceBall(i, ball.x, ball.y);
                }
            }

            // 숏패스 수신 판정 (지면 볼)
            if (!isLongPass) {
                const dist = Math.hypot(players[receiverIdx].x - ball.x, players[receiverIdx].y - ball.y);
                if (dist < RECEIVE_DIST) onReceive();
            }
            // 롱패스: bm.update() 내 onLand → onReceive 자동 호출

        } else {
            // 소유 중: 볼 위치 유지
            bm.snapToFront();

            // 수신자(이전 패서)는 홈 복귀
            moveTowardHome(players[receiverIdx], receiverIdx, dt);

            // 홀더를 제외한 나머지는 볼을 향함 (홀더는 이미 타겟을 향하고 있음)
            for (let i = 0; i < PLAYERS_COUNT; i++) {
                if (i !== holderIdx) faceBall(i, ball.x, ball.y);
            }

            passTimer -= dt;
            if (passTimer <= 0) {
                isLongPass = Math.random() < LONG_PASS_CHANCE;

                if (isLongPass) {
                    // 수신자 발 앞을 착지 목표로
                    const receiver = players[receiverIdx];
                    const rad      = receiver.angle * Math.PI / 180;
                    const fwdX     = -Math.sin(rad);
                    const fwdY     =  Math.cos(rad);
                    const footX    = receiver.x + fwdX * POSSESS_OFFSET;
                    const footY    = receiver.y + fwdY * POSSESS_OFFSET;

                    const result = PassMovement.longPass(bm, footX, footY, {
                        angleDevDeg: PASS_ANGLE_DEG,
                        onLand: onReceive,
                    });
                    aerialLandX        = result.landX;
                    aerialLandY        = result.landY;
                    passerReturnSpeed  = calcPasserReturnSpeed(result.flightDuration);
                } else {
                    const receiver = players[receiverIdx];
                    const result   = PassMovement.shortPass(bm, receiver.x, receiver.y, {
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
