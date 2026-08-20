/**
 * TwoPlayerPass - 2인 숏패스 무한 반복
 *
 * 배치:
 *   선수A (홈, 7번) – 하프라인 왼쪽 40m (x=125), 오른쪽 방향 (angle=-90)
 *   선수B (홈, 11번) – 하프라인 왼쪽 10m (x=425), 왼쪽 방향 (angle=90)
 *
 * 시퀀스:
 *   1. A가 볼 소유
 *   2. PASS_DELAY 후 B에게 숏패스 (0~5° 각도 편차)
 *   3. 볼이 일정 거리 이내로 오면 B가 예상 도달 위치로 이동
 *   4. 볼이 B에게 도달하면 B 소유, 보유 중 CENTER_Y로 복귀
 *   5. PASS_DELAY 후 A에게 숏패스
 *   6. 무한 반복
 *
 * 선수는 항상 앞(상대방 방향)을 바라본다. (PlayerMovement 회전 무시)
 */
import { Player }         from '../entities/Player.js';
import { Ball }           from '../entities/Ball.js';
import { BallMovement }   from '../movement/BallMovement.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { PassMovement }   from '../movement/PassMovement.js';

const CENTER_Y       = 340;
const HALF_X         = 525;
const PLAYER_A_X     = HALF_X - 400;  // 125
const PLAYER_B_X     = HALF_X - 100;  // 425

const ANGLE_A        = -90;  // 오른쪽
const ANGLE_B        =  90;  // 왼쪽

const POSSESS_OFFSET   = Player.BODY_RADIUS + Ball.RADIUS + 4;  // 21
const RECEIVE_DIST     = POSSESS_OFFSET + 10;                   // 31
const INTERCEPT_DIST   = 150;  // 이 거리 이내에 볼이 들어오면 수신자가 이동
const PASS_DELAY       = 0.4;  // 볼 보유 후 패스까지 대기 시간 (초)
const PASS_ANGLE_DEV   = 5;    // 패스 각도 최대 편차 (도)
const Y_MIN            = 45;
const Y_MAX            = 635;

export function run(layer, loop, onComplete = null) {
    // 선수 A: 오른쪽을 향함
    const playerA = new Player({
        x: PLAYER_A_X, y: CENTER_Y, team: 'home', number: 7, angle: ANGLE_A,
    }).render(layer);

    // 선수 B: 왼쪽을 향함
    const playerB = new Player({
        x: PLAYER_B_X, y: CENTER_Y, team: 'home', number: 11, angle: ANGLE_B,
    }).render(layer);

    const ball = new Ball(PLAYER_A_X + POSSESS_OFFSET, CENTER_Y).render(layer);
    const bm   = new BallMovement(ball);

    const pmA = new PlayerMovement(playerA);
    const pmB = new PlayerMovement(playerB);

    bm.possess(playerA, POSSESS_OFFSET);
    bm.snapToFront();

    let holder       = playerA;
    let holderPm     = pmA;
    let holderAngle  = ANGLE_A;
    let receiver     = playerB;
    let receiverPm   = pmB;
    let receiverAngle = ANGLE_B;

    let passTimer      = PASS_DELAY;
    let inFlight       = false;
    let interceptDone  = false;

    function tick(dt) {
        pmA.update(dt);
        pmB.update(dt);

        // 방향 고정: PlayerMovement 내부 회전 덮어쓰기
        playerA.setAngle(ANGLE_A);
        playerB.setAngle(ANGLE_B);

        if (inFlight) {
            bm.update(dt);

            const dx   = receiver.x - ball.x;
            const dy   = receiver.y - ball.y;
            const dist = Math.hypot(dx, dy);

            // 볼이 충분히 날아왔을 때 수신자가 도달 위치로 이동
            if (!interceptDone && dist < INTERCEPT_DIST) {
                interceptDone = true;
                // 볼의 현재 속도 방향으로 수신자 X 위치의 Y를 예측
                if (Math.abs(bm.vx) > 1) {
                    const arrivalY = ball.y + (bm.vy / bm.vx) * (receiver.x - ball.x);
                    const clampedY = Math.max(Y_MIN, Math.min(Y_MAX, arrivalY));
                    receiverPm.speed = PlayerMovement.SPEEDS[2]; // 100
                    receiverPm.moveTo(receiver.x, clampedY, () => {});
                }
            }

            // 수신 판정
            if (dist < RECEIVE_DIST) {
                bm.possess(receiver, POSSESS_OFFSET);
                bm.snapToFront();
                inFlight      = false;
                interceptDone = false;
                passTimer     = PASS_DELAY;

                // 보유 중 CENTER_Y로 복귀
                receiverPm.speed = PlayerMovement.SPEEDS[1]; // 75
                receiverPm.moveTo(receiver.x, CENTER_Y, () => {});

                // 역할 교체
                [holder, holderPm, holderAngle, receiver, receiverPm, receiverAngle] =
                [receiver, receiverPm, receiverAngle, holder, holderPm, holderAngle];
            }
        } else {
            bm.update(dt);
            passTimer -= dt;
            if (passTimer <= 0) {
                PassMovement.shortPass(bm, receiver.x, receiver.y, {
                    angleDevDeg: PASS_ANGLE_DEV,
                });
                inFlight = true;
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
