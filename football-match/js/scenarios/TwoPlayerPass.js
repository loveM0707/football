/**
 * TwoPlayerPass - 2인 숏패스 무한 반복
 *
 * 배치:
 *   선수A (홈, 7번) – 하프라인 왼쪽 40m (x=125), 오른쪽 방향 (angle=-90)
 *   선수B (홈, 11번) – 하프라인 왼쪽 10m (x=425), 왼쪽 방향 (angle=90)
 *
 * 시퀀스:
 *   1. A가 볼 소유 후 PASS_DELAY 대기, 홈 위치로 복귀
 *   2. B에게 숏패스 (0~5° 각도 편차)
 *   3. REACTION_DELAY 후 B가 볼 도달 Y로 옆으로 이동 (X는 고정)
 *   4. 볼이 B에게 도달 → B 소유 → 홈으로 복귀하며 대기
 *   5. 무한 반복
 *
 * 선수는 항상 상대 방향을 바라본다. (PlayerMovement 내부 회전을 setAngle로 덮어씀)
 */
import { Player }         from '../entities/Player.js';
import { Ball }           from '../entities/Ball.js';
import { BallMovement }   from '../movement/BallMovement.js';
import { PlayerMovement } from '../movement/PlayerMovement.js';
import { PassMovement }   from '../movement/PassMovement.js';

const CENTER_Y    = 340;
const HALF_X      = 525;
const PLAYER_A_X  = HALF_X - 400;  // 125
const PLAYER_B_X  = HALF_X - 100;  // 425

const ANGLE_A     = -90;  // 오른쪽
const ANGLE_B     =  90;  // 왼쪽

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;  // 21
const RECEIVE_DIST   = POSSESS_OFFSET + 10;                   // 31
const PASS_DELAY     = 0.4;   // 볼 보유 후 패스까지 대기 시간 (초)
const PASS_ANGLE_DEV = 5;     // 패스 각도 최대 편차 (도)
const Y_MIN          = 45;
const Y_MAX          = 635;

export function run(layer, loop, onComplete = null) {
    const playerA = new Player({
        x: PLAYER_A_X, y: CENTER_Y, team: 'home', number: 7, angle: ANGLE_A,
    }).render(layer);

    const playerB = new Player({
        x: PLAYER_B_X, y: CENTER_Y, team: 'home', number: 11, angle: ANGLE_B,
    }).render(layer);

    const ball = new Ball(PLAYER_A_X + POSSESS_OFFSET, CENTER_Y).render(layer);
    const bm   = new BallMovement(ball);

    const pmA = new PlayerMovement(playerA);
    const pmB = new PlayerMovement(playerB);

    const homeA = { x: PLAYER_A_X, y: CENTER_Y };
    const homeB = { x: PLAYER_B_X, y: CENTER_Y };

    bm.possess(playerA, POSSESS_OFFSET);
    bm.snapToFront();

    let holder     = playerA;
    let holderPm   = pmA;
    let receiver   = playerB;
    let receiverPm = pmB;

    let passTimer     = PASS_DELAY;
    let inFlight      = false;
    let reactionTimer = 0;  // 패스 직후 수신자 반응 지연

    function tick(dt) {
        pmA.update(dt);
        pmB.update(dt);

        // 방향 고정: PlayerMovement 내부 회전을 매 프레임 덮어씀
        playerA.setAngle(ANGLE_A);
        playerB.setAngle(ANGLE_B);

        if (inFlight) {
            bm.update(dt);

            const dist = Math.hypot(receiver.x - ball.x, receiver.y - ball.y);

            // 반응 지연 후 볼 도달 Y 위치로 옆으로 이동 (X 고정)
            reactionTimer -= dt;
            if (reactionTimer <= 0) {
                const pt = PassMovement.interceptPoint(bm, receiver, { yMin: Y_MIN, yMax: Y_MAX });
                receiverPm.speed = PlayerMovement.SPEEDS[2]; // 100 SVG/s
                receiverPm.moveTo(pt.x, pt.y, () => {});
            }

            // 수신 판정
            if (dist < RECEIVE_DIST) {
                bm.possess(receiver, POSSESS_OFFSET);
                bm.snapToFront();
                inFlight  = false;
                passTimer = PASS_DELAY;

                // 역할 교체
                [holder, holderPm, receiver, receiverPm] =
                [receiver, receiverPm, holder, holderPm];

                // 새 holder가 홈 위치로 복귀하며 패스 대기
                const home = (holder === playerA) ? homeA : homeB;
                holderPm.speed = PlayerMovement.SPEEDS[2]; // 100
                holderPm.moveTo(home.x, home.y, () => {});
            }

        } else {
            bm.update(dt);
            passTimer -= dt;
            if (passTimer <= 0) {
                PassMovement.shortPass(bm, receiver.x, receiver.y, {
                    angleDevDeg: PASS_ANGLE_DEV,
                });
                inFlight      = true;
                reactionTimer = PassMovement.REACTION_DELAY;
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
