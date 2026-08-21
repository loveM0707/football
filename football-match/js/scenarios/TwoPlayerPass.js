/**
 * TwoPlayerPass - 2인 숏패스 무한 반복
 *
 * 배치:
 *   선수A (홈, 7번) – 하프라인 왼쪽 40m (x=125), 오른쪽 방향 (angle=-90)
 *   선수B (홈, 11번) – 하프라인 왼쪽 10m (x=425), 왼쪽 방향 (angle=90)
 *
 * 수신 시퀀스:
 *   1. 패스 직후 REACTION_DELAY(0.2s) 동안 수신자 정지 (반사신경)
 *   2. 반응 후 볼 도달 Y를 한 번 예측 → 거리에 따라 5단계 속도로 옆으로 이동
 *   3. 이동은 Y축만 — setPosition 직접 호출 (PlayerMovement 회전 우회)
 *   4. 수신 후 홈 위치로 복귀, PASS_DELAY 대기 후 패스
 *
 * 선수는 항상 상대 방향을 바라본다.
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
const RECEIVE_DIST   = POSSESS_OFFSET + 3;                    // 23 — 스냅 최소화
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

    let passTimer          = PASS_DELAY;
    let inFlight           = false;
    let reactionTimer      = 0;
    let reacted            = false;
    let interceptTargetY   = CENTER_Y;
    let interceptMoveSpeed = 0;

    function tick(dt) {
        // holder의 홈 복귀 이동만 PlayerMovement로 처리 (수신자는 직접 setPosition)
        holderPm.update(dt);

        // 방향 고정: PlayerMovement 내부 회전을 매 프레임 덮어씀
        playerA.setAngle(ANGLE_A);
        playerB.setAngle(ANGLE_B);

        if (inFlight) {
            bm.update(dt);

            const dist = Math.hypot(receiver.x - ball.x, receiver.y - ball.y);

            // 반응 지연
            reactionTimer -= dt;

            if (!reacted && reactionTimer <= 0) {
                // 반응 완료: 볼 도달 Y 한 번 예측, 거리 비례 속도 결정
                reacted = true;
                const pt = PassMovement.interceptPoint(bm, receiver, { yMin: Y_MIN, yMax: Y_MAX });
                interceptTargetY   = pt.y;
                interceptMoveSpeed = PassMovement.interceptSpeed(Math.abs(interceptTargetY - receiver.y));
            }

            if (reacted) {
                // Y축 직접 이동 (PlayerMovement 회전 우회 — setAngle 고정과 충돌하지 않음)
                const dy    = interceptTargetY - receiver.y;
                const distY = Math.abs(dy);
                if (distY > 0.5) {
                    const step = Math.min(interceptMoveSpeed * dt, distY);
                    receiver.setPosition(receiver.x, receiver.y + Math.sign(dy) * step);
                }
            }

            // 수신 판정
            if (dist < RECEIVE_DIST) {
                bm.possess(receiver, POSSESS_OFFSET);
                bm.snapToFront();
                inFlight  = false;
                reacted   = false;
                passTimer = PASS_DELAY;

                // 역할 교체
                [holder, holderPm, receiver, receiverPm] =
                [receiver, receiverPm, holder, holderPm];

                // 새 holder가 홈 위치로 복귀 (PlayerMovement 사용 — 이때는 X,Y 모두 이동)
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
                reacted       = false;
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
