/**
 * FourPlayerPass - 4인 패스 순환
 *
 * 배치: 하프라인 중심에서 정사각형 형태 (간격 20m)
 *   선수0: 왼쪽 위 (x=HALF_X-20, y=CENTER_Y-20) - 초기 볼 소유자
 *   선수1: 왼쪽 아래 (x=HALF_X-20, y=CENTER_Y+20)
 *   선수2: 오른쪽 위 (x=HALF_X+20, y=CENTER_Y-20)
 *   선수3: 오른쪽 아래 (x=HALF_X+20, y=CENTER_Y+20)
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
 *   - 반응 후 착지/예측 Y를 향해 Y축 이동 (X축 고정)
 *
 * 패스 흐름:
 *   1. 홀더가 랜덤한 타겟을 향해 몸을 돌리고 패스
 *   2. 수신자는 센터를 향한 자세로 볼을 받음
 *   3. 수신 완료 후 다음 랜덤 타겟을 향해 몸을 돌림
 *   4. PASS_DELAY 후 패스 실행
 *   5. 미참여 선수들은 계속 센터를 향함
 */
import { Player }        from '../entities/Player.js';
import { Ball }          from '../entities/Ball.js';
import { BallMovement }  from '../movement/BallMovement.js';
import { PassMovement }  from '../movement/PassMovement.js';
import { PassReceiver }  from '../movement/PassReceiver.js';

const CENTER_Y   = 340;
const HALF_X     = 525;
const CENTER_X   = HALF_X;

const OFFSET = 20; // 센터로부터 20m

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
const Y_MIN              = 45;
const Y_MAX              = 635;

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

    const homePositions = players.map(p => ({ x: p.x, y: p.y }));

    const passReceiver = new PassReceiver();

    let holderIdx   = 0; // 선수0이 시작
    let receiverIdx = -1; // 패스 시 랜덤 선택
    let passTimer          = PASS_DELAY;
    let inFlight           = false;
    let isLongPass         = false;
    let aerialLandY        = CENTER_Y;
    let passerReturnTimer  = 0;
    let passerReturnSpeed  = HOME_SPEED;

    // 홀더가 패스할 타겟을 향하도록 각도 설정
    function faceTarget(holderIdx, targetIdx) {
        const holder = players[holderIdx];
        const target = players[targetIdx];
        const ang = angleTo(holder.x, holder.y, target.x, target.y);
        holder.setAngle(ang);
    }

    // 미참여 선수들은 센터를 향함
    function faceCenterExcept(exceptIdx) {
        for (let i = 0; i < PLAYERS_COUNT; i++) {
            if (i !== exceptIdx) {
                players[i].setAngle(INITIAL_ANGLES[i]);
            }
        }
    }

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

        // 수신자가 새로운 홀더가 됨
        holderIdx = receiverIdx;

        // 다음 랜덤 리시버 선택 (홀더 제외)
        receiverIdx = getRandomReceiver(holderIdx);

        // 새로운 홀더가 다음 타겟을 향하도록 몸을 돌림
        faceTarget(holderIdx, receiverIdx);

        // 나머지 선수들은 센터를 향함
        faceCenterExcept(holderIdx);
    }

    // 초기 상태: 선수0이 첫 타겟을 향함
    receiverIdx = getRandomReceiver(holderIdx);
    faceTarget(holderIdx, receiverIdx);
    faceCenterExcept(holderIdx);

    // 볼을 홀더 발 앞에 위치시킴
    bm.possess(players[holderIdx], POSSESS_OFFSET);
    bm.snapToFront();

    function tick(dt) {
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

            // 홀더는 이미 타겟을 향하고 있음 (faceTarget에서 설정됨)
            // 미참여 선수들은 센터를 향함 (이미 faceCenterExcept에서 설정됨)

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

                    const receiver = players[receiverIdx];

                    const result = PassMovement.longPass(bm, receiver.x, receiver.y, {
                        angleDevDeg: PASS_ANGLE_DEG,
                        onLand: onReceive,
                    });
                    aerialLandY        = result.landY;
                    passerReturnSpeed  = calcPasserReturnSpeed(result.flightDuration);
                } else {
                    // 숏패스
                    const receiver = players[receiverIdx];

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