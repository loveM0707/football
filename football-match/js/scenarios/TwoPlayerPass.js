/**
 * TwoPlayerPass - 2인 숏/롱패스 무한 반복
 *
 * 배치:
 *   선수A (홈, 7번)  – x=125, 오른쪽 방향 (angle=-90)
 *   선수B (홈, 11번) – x=425, 왼쪽 방향  (angle=90)
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
 */
import { Player }        from '../entities/Player.js';
import { Ball }          from '../entities/Ball.js';
import { BallMovement }  from '../movement/BallMovement.js';
import { PassMovement }  from '../movement/PassMovement.js';
import { PassReceiver }  from '../movement/PassReceiver.js';

const CENTER_Y   = 340;
const HALF_X     = 525;
const PLAYER_A_X = HALF_X - 400;  // 125
const PLAYER_B_X = HALF_X - 100;  // 425

const ANGLE_A    = -90;  // 오른쪽
const ANGLE_B    =  90;  // 왼쪽

const POSSESS_OFFSET     = Player.BODY_RADIUS + Ball.RADIUS + 4;  // 19
const RECEIVE_DIST       = POSSESS_OFFSET + 3;                    // 22
const PASS_DELAY          = 0.4;  // 볼 보유 후 패스까지 대기 (초)
const PASSER_RETURN_DELAY = 0.2;  // 패스 직후 복귀 시작 전 짧은 정지 (초)
const PASS_ANGLE_DEV      = 5;    // 패스 각도 최대 편차 (도)
const LONG_PASS_CHANCE    = 0.4;
const HOME_SPEED          = 75;   // SVG/s 소유 중 수신자 홈 복귀 속도
const Y_MIN              = 45;
const Y_MAX              = 635;

export function run(layer, loop, onComplete = null) {
    const playerA = new Player({
        x: PLAYER_A_X, y: CENTER_Y, team: 'home', number: 7, angle: ANGLE_A,
    }).render(layer);

    const playerB = new Player({
        x: PLAYER_B_X, y: CENTER_Y, team: 'home', number: 11, angle: ANGLE_B,
    }).render(layer);

    const ball = new Ball(PLAYER_A_X + POSSESS_OFFSET, CENTER_Y).render(layer);
    const bm   = new BallMovement(ball);

    const homeA = { x: PLAYER_A_X, y: CENTER_Y };
    const homeB = { x: PLAYER_B_X, y: CENTER_Y };

    bm.possess(playerA, POSSESS_OFFSET);
    bm.snapToFront();

    let holder   = playerA;
    let receiver = playerB;

    const passReceiver = new PassReceiver();

    let passTimer          = PASS_DELAY;
    let inFlight           = false;
    let isLongPass         = false;
    let aerialLandY        = CENTER_Y;
    let passerReturnTimer  = 0;
    let passerReturnSpeed  = HOME_SPEED; // 역산된 복귀 속도

    function homeOf(p) { return p === playerA ? homeA : homeB; }

    function moveTowardHome(player, dt, speed = HOME_SPEED) {
        const home = homeOf(player);
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

    /**
     * 패스 비행 시간을 바탕으로 패서가 홈까지 이동할 최소 속도를 역산.
     * "천천히 걷되 수신 직전 도착" — available = flightTime + PASS_DELAY - PASSER_RETURN_DELAY
     */
    function calcPasserReturnSpeed(flightTime) {
        const home = homeOf(holder);
        const dist = Math.hypot(holder.x - home.x, holder.y - home.y);
        if (dist < 1) return HOME_SPEED;
        const available = flightTime + PASS_DELAY - PASSER_RETURN_DELAY;
        if (available < 0.1) return HOME_SPEED;
        return dist / available;  // 딱 맞게 도달하는 최소 속도
    }

    function onReceive() {
        bm.possess(receiver, POSSESS_OFFSET);
        bm.snapToFront();
        passReceiver.reset();
        inFlight          = false;
        isLongPass        = false;
        passTimer         = PASS_DELAY;
        passerReturnTimer = 0;
        [holder, receiver] = [receiver, holder];
    }

    function tick(dt) {
        playerA.setAngle(ANGLE_A);
        playerB.setAngle(ANGLE_B);

        bm.update(dt);

        if (inFlight) {
            // 패서: 짧은 정지 후 역산된 느린 속도로 홈 복귀
            passerReturnTimer -= dt;
            if (passerReturnTimer <= 0) {
                moveTowardHome(holder, dt, passerReturnSpeed);
            }

            // 수신자: 반응 후 Y축 인터셉트 (숏/롱패스 공통)
            passReceiver.update(dt, receiver, () => {
                if (isLongPass) return aerialLandY;
                return PassMovement.interceptPoint(bm, receiver, { yMin: Y_MIN, yMax: Y_MAX }).y;
            });

            // 숏패스 수신 판정 (지면 볼)
            if (!isLongPass) {
                const dist = Math.hypot(receiver.x - ball.x, receiver.y - ball.y);
                if (dist < RECEIVE_DIST) onReceive();
            }
            // 롱패스: bm.update() 내 onLand → onReceive 자동 호출

        } else {
            // 소유 중: 볼 위치 유지, 수신자(이전 패서)는 홈 복귀
            bm.snapToFront();
            moveTowardHome(receiver, dt);

            passTimer -= dt;
            if (passTimer <= 0) {
                isLongPass = Math.random() < LONG_PASS_CHANCE;

                if (isLongPass) {
                    // 착지 목표: 수신자 발 앞
                    const rad   = receiver.angle * Math.PI / 180;
                    const fwdX  = -Math.sin(rad);
                    const fwdY  =  Math.cos(rad);
                    const footX = receiver.x + fwdX * POSSESS_OFFSET;
                    const footY = receiver.y + fwdY * POSSESS_OFFSET;

                    const result = PassMovement.longPass(bm, footX, footY, {
                        angleDevDeg: PASS_ANGLE_DEV,
                        onLand: onReceive,
                    });
                    aerialLandY        = result.landY;
                    passerReturnSpeed  = calcPasserReturnSpeed(result.flightDuration);
                } else {
                    const result = PassMovement.shortPass(bm, receiver.x, receiver.y, {
                        angleDevDeg: PASS_ANGLE_DEV,
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
