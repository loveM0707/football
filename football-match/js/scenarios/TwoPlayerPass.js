/**
 * TwoPlayerPass - 2인 숏/롱패스 무한 반복
 *
 * 배치:
 *   선수A (홈, 7번)  – x=125, 오른쪽 방향 (angle=-90)
 *   선수B (홈, 11번) – x=425, 왼쪽 방향  (angle=90)
 *
 * 패스 종류 (매 패스마다 랜덤):
 *   - 숏패스 (60%): 지면 굴림, 수신자가 반응 후 Y축으로 이동
 *   - 롱패스 (40%): 공중 포물선, onLand 콜백으로 수신 처리
 *
 * 이동:
 *   - 선수는 항상 상대방을 바라본다 (setAngle 고정)
 *   - 홈 위치 복귀/Y축 인터셉트 모두 setPosition 직접 사용
 *     (PlayerMovement의 회전-선진 메커니즘이 강제된 각도와 충돌하므로 배제)
 */
import { Player }       from '../entities/Player.js';
import { Ball }         from '../entities/Ball.js';
import { BallMovement } from '../movement/BallMovement.js';
import { PassMovement } from '../movement/PassMovement.js';

const CENTER_Y   = 340;
const HALF_X     = 525;
const PLAYER_A_X = HALF_X - 400;  // 125
const PLAYER_B_X = HALF_X - 100;  // 425

const ANGLE_A    = -90;  // 오른쪽
const ANGLE_B    =  90;  // 왼쪽

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;  // 19
const RECEIVE_DIST   = POSSESS_OFFSET + 3;                    // 22
const PASS_DELAY     = 0.4;
const PASS_ANGLE_DEV = 5;
const LONG_PASS_CHANCE = 0.4;
const HOME_SPEED     = 75;  // SVG/s 홈 복귀 속도
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

    const homeA = { x: PLAYER_A_X, y: CENTER_Y };
    const homeB = { x: PLAYER_B_X, y: CENTER_Y };

    bm.possess(playerA, POSSESS_OFFSET);
    bm.snapToFront();

    let holder   = playerA;
    let receiver = playerB;

    let passTimer        = PASS_DELAY;
    let inFlight         = false;
    let reactionTimer    = 0;
    let reacted          = false;
    let interceptTargetY = CENTER_Y;
    let interceptSpeed   = 0;
    let isLongPass       = false;
    let aerialLandY      = CENTER_Y;

    function homeOf(p) { return p === playerA ? homeA : homeB; }

    /** 수신 처리: 소유 전환 + 상태 초기화 */
    function onReceive() {
        bm.possess(receiver, POSSESS_OFFSET);
        bm.snapToFront();
        inFlight      = false;
        reacted       = false;
        isLongPass    = false;
        passTimer     = PASS_DELAY;
        [holder, receiver] = [receiver, holder];
    }

    /** 선수를 홈 방향으로 HOME_SPEED로 한 프레임 이동 */
    function moveTowardHome(player, dt) {
        const home = homeOf(player);
        const dx = home.x - player.x;
        const dy = home.y - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return;
        const step = Math.min(HOME_SPEED * dt, dist);
        player.setPosition(
            player.x + (dx / dist) * step,
            player.y + (dy / dist) * step,
        );
    }

    function tick(dt) {
        // 각도 고정
        playerA.setAngle(ANGLE_A);
        playerB.setAngle(ANGLE_B);

        if (inFlight) {
            bm.update(dt);

            // passer는 홈으로 복귀
            moveTowardHome(holder, dt);

            // 반응 지연 → Y축 인터셉트 (숏패스/롱패스 공통)
            reactionTimer -= dt;
            if (!reacted && reactionTimer <= 0) {
                reacted = true;
                if (isLongPass) {
                    // 롱패스: 착지 Y로 이동
                    interceptTargetY = aerialLandY;
                } else {
                    // 숏패스: 볼 경로 예측
                    const pt = PassMovement.interceptPoint(bm, receiver, { yMin: Y_MIN, yMax: Y_MAX });
                    interceptTargetY = pt.y;
                }
                interceptSpeed = PassMovement.interceptSpeed(Math.abs(interceptTargetY - receiver.y));
            }

            if (reacted) {
                const dy    = interceptTargetY - receiver.y;
                const distY = Math.abs(dy);
                if (distY > 0.5) {
                    const step = Math.min(interceptSpeed * dt, distY);
                    receiver.setPosition(receiver.x, receiver.y + Math.sign(dy) * step);
                }
            }

            if (!isLongPass) {
                // 숏패스 수신 판정 (지면 볼)
                const dist = Math.hypot(receiver.x - ball.x, receiver.y - ball.y);
                if (dist < RECEIVE_DIST) {
                    onReceive();
                }
            }
            // 롱패스: onLand 콜백에서 수신 처리 (aerial 중에는 거리 판정 없음)

        } else {
            // 소유 중: 볼을 선수 앞에 붙임
            bm.update(dt);
            bm.snapToFront();

            passTimer -= dt;
            if (passTimer <= 0) {
                isLongPass = Math.random() < LONG_PASS_CHANCE;

                if (isLongPass) {
                    // 착지 목표: 수신자의 발 앞 (선수 정면 POSSESS_OFFSET 거리)
                    const rad  = receiver.angle * Math.PI / 180;
                    const fwdX = -Math.sin(rad);
                    const fwdY =  Math.cos(rad);
                    const footX = receiver.x + fwdX * POSSESS_OFFSET;
                    const footY = receiver.y + fwdY * POSSESS_OFFSET;

                    const result = PassMovement.longPass(bm, footX, footY, {
                        angleDevDeg: PASS_ANGLE_DEV,
                        onLand: onReceive,
                    });
                    aerialLandY   = result.landY;
                    reacted       = false;
                    reactionTimer = PassMovement.REACTION_DELAY;
                } else {
                    PassMovement.shortPass(bm, receiver.x, receiver.y, {
                        angleDevDeg: PASS_ANGLE_DEV,
                    });
                    reacted       = false;
                    reactionTimer = PassMovement.REACTION_DELAY;
                }

                inFlight = true;
            }
        }
    }

    loop.add(tick);

    return function stop() {
        loop.remove(tick);
    };
}
