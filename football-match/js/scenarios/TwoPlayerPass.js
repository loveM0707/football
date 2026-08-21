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
 * 자연스러운 움직임:
 *   - 볼 없는 선수: 홈 포지션 근처에서 미세하게 움직임 (IdleMovement)
 *   - 수신자: 볼이 오면 볼 방향을 향해 몸을 돌리고 마중 나감 (PlayerMovement)
 *   - 수신 후: 원래 방향으로 부드럽게 돌아오며 패스 준비
 *   - 패서: 패스 직후 잠시 정지, 역산 속도로 홈 복귀
 */
import { Player }        from '../entities/Player.js';
import { Ball }          from '../entities/Ball.js';
import { BallMovement }  from '../movement/BallMovement.js';
import { PassMovement }  from '../movement/PassMovement.js';
import { PassReceiver }  from '../movement/PassReceiver.js';
import { IdleMovement }  from '../movement/IdleMovement.js';
import { PlayerMovement} from '../movement/PlayerMovement.js';
import { angleTo, forwardVector } from '../movement/Direction.js';

const CENTER_Y   = 340;
const HALF_X     = 525;
const PLAYER_A_X = HALF_X - 400;  // 125
const PLAYER_B_X = HALF_X - 100;  // 425

const ANGLE_A    = -90;  // 오른쪽
const ANGLE_B    =  90;  // 왼쪽

const POSSESS_OFFSET     = Player.BODY_RADIUS + Ball.RADIUS + 4;  // 19
const RECEIVE_DIST       = POSSESS_OFFSET + 3;                    // 22
const PASS_DELAY          = 0.4;   // 볼 보유 후 패스까지 대기 (초)
const PASSER_RETURN_DELAY = 0.2;   // 패스 직후 복귀 시작 전 짧은 정지 (초)
const PASS_ANGLE_DEV      = 5;     // 패스 각도 최대 편차 (도)
const LONG_PASS_CHANCE    = 0.4;
const HOME_SPEED          = 75;    // SVG/s 소유 중 수신자 홈 복귀 속도

export function run(layer, loop, onComplete = null) {
    const playerA = new Player({
        x: PLAYER_A_X, y: CENTER_Y, team: 'home', number: 7, angle: ANGLE_A,
    }).render(layer);

    const playerB = new Player({
        x: PLAYER_B_X, y: CENTER_Y, team: 'home', number: 11, angle: ANGLE_B,
    }).render(layer);

    const ball = new Ball(PLAYER_A_X + POSSESS_OFFSET, CENTER_Y).render(layer);
    const bm   = new BallMovement(ball);

    // 패스 시나리오에서는 이동과 회전을 분리 (쪽쪽 이동 중 볼 방향 보기)
    const pmA = new PlayerMovement(playerA, { turnBeforeMove: false, maxVel: 360 });
    const pmB = new PlayerMovement(playerB, { turnBeforeMove: false, maxVel: 360 });

    const homeA = { x: PLAYER_A_X, y: CENTER_Y };
    const homeB = { x: PLAYER_B_X, y: CENTER_Y };

    bm.possess(playerA, POSSESS_OFFSET);
    bm.snapToFront();

    let holder   = playerA;
    let receiver = playerB;

    let passTimer          = PASS_DELAY;
    let inFlight           = false;
    let isLongPass         = false;
    let aerialLandX        = PLAYER_B_X;
    let aerialLandY        = CENTER_Y;
    let passerReturnTimer  = 0;
    let passerReturnSpeed  = HOME_SPEED;

    const passReceiver = new PassReceiver();
    const idle         = new IdleMovement(2); // 0=playerA, 1=playerB

    function setTargetAngle(player, angle) {
        if (player === playerA) pmA.setFacingTarget(angle);
        else                    pmB.setFacingTarget(angle);
    }

    function readyAngle(player) {
        return player === playerA ? ANGLE_A : ANGLE_B;
    }

    function idxOf(player) { return player === playerA ? 0 : 1; }
    function homeOf(player) { return player === playerA ? homeA : homeB; }

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

    function calcPasserReturnSpeed(flightTime) {
        const home = homeOf(holder);
        const dist = Math.hypot(holder.x - home.x, holder.y - home.y);
        if (dist < 1) return HOME_SPEED;
        const available = flightTime + PASS_DELAY - PASSER_RETURN_DELAY;
        if (available < 0.1) return HOME_SPEED;
        return dist / available;
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
        // 수신자(새 홀더)는 상대방 방향으로 부드럽게 회전
        setTargetAngle(holder,   readyAngle(holder));
        setTargetAngle(receiver, readyAngle(receiver));
    }

    function tick(dt) {
        bm.update(dt);
        pmA.update(dt);
        pmB.update(dt);

        if (inFlight) {
            // 패서: 짧은 정지 후 역산된 속도로 홈 복귀
            passerReturnTimer -= dt;
            if (passerReturnTimer <= 0) {
                moveTowardHome(holder, dt, passerReturnSpeed);
            }

            // 수신자: 볼 쪽으로 몸을 돌리고 인터셉트 위치로 이동
            setTargetAngle(receiver, angleTo(receiver.x, receiver.y, ball.x, ball.y));
            passReceiver.update(dt, receiver, () => {
                if (isLongPass) return { x: aerialLandX, y: aerialLandY };
                return PassMovement.interceptPoint(bm, receiver);
            });

            // 숏패스 수신 판정
            if (!isLongPass) {
                const dist = Math.hypot(receiver.x - ball.x, receiver.y - ball.y);
                if (dist < RECEIVE_DIST) onReceive();
            }

        } else {
            // 소유 중: 볼 위치 유지, 수신자는 홈 복귀
            bm.snapToFront();
            moveTowardHome(receiver, dt);

            // 홀더: 다음 패스 대상 방향을 바라본다
            setTargetAngle(holder, readyAngle(holder));

            // 홀더: 대기 중 미세 움직임
            const holderHome = homeOf(holder);
            idle.update(dt, holder, idxOf(holder), holderHome.x, holderHome.y);

            passTimer -= dt;
            if (passTimer <= 0) {
                isLongPass = Math.random() < LONG_PASS_CHANCE;

                const deviationRad = (Math.random() * 2 - 1) * PASS_ANGLE_DEV * Math.PI / 180;
                if (isLongPass) {
                    const fwd   = forwardVector(receiver.angle);
                    const footX = receiver.x + fwd.x * POSSESS_OFFSET;
                    const footY = receiver.y + fwd.y * POSSESS_OFFSET;

                    const result = PassMovement.longPass(bm, footX, footY, {
                        deviationRad,
                        onLand: onReceive,
                    });
                    aerialLandX       = result.landX;
                    aerialLandY       = result.landY;
                    passerReturnSpeed = calcPasserReturnSpeed(result.flightDuration);
                } else {
                    const result = PassMovement.shortPass(bm, receiver.x, receiver.y, {
                        deviationRad,
                    });
                    passerReturnSpeed = calcPasserReturnSpeed(result.timeToArrive);
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
        pmA.stop();
        pmB.stop();
    };
}
