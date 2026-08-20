/**
 * TwoPlayerPass - 2인 숏패스 무한 반복
 *
 * 배치:
 *   선수A (홈, 7번) – 하프라인 왼쪽 40m (x=125), 오른쪽 방향
 *   선수B (홈, 11번) – 하프라인 왼쪽 10m (x=425), 왼쪽 방향
 *
 * 시퀀스:
 *   1. A가 볼 소유
 *   2. PASS_DELAY 후 B에게 숏패스
 *   3. 볼이 B에게 도달하면 B 소유
 *   4. PASS_DELAY 후 A에게 숏패스
 *   5. 무한 반복
 */
import { Player }       from '../entities/Player.js';
import { Ball }         from '../entities/Ball.js';
import { BallMovement } from '../movement/BallMovement.js';
import { PassMovement } from '../movement/PassMovement.js';

const CENTER_Y       = 340;
const HALF_X         = 525;
const PLAYER_A_X     = HALF_X - 400;  // 125  (40m 왼쪽)
const PLAYER_B_X     = HALF_X - 100;  // 425  (10m 왼쪽)

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;  // 21
const RECEIVE_DIST   = POSSESS_OFFSET + 25;                   // 46
const PASS_DELAY     = 0.4; // 패스 전 볼 보유 시간 (초)

export function run(layer, loop, onComplete = null) {
    // 선수 A: 오른쪽을 향함 (angle=-90)
    const playerA = new Player({
        x: PLAYER_A_X, y: CENTER_Y, team: 'home', number: 7, angle: -90,
    }).render(layer);

    // 선수 B: 왼쪽을 향함 (angle=90)
    const playerB = new Player({
        x: PLAYER_B_X, y: CENTER_Y, team: 'home', number: 11, angle: 90,
    }).render(layer);

    // 볼은 선수 A 앞에서 시작
    const ball = new Ball(PLAYER_A_X + POSSESS_OFFSET, CENTER_Y).render(layer);
    const bm   = new BallMovement(ball);

    bm.possess(playerA, POSSESS_OFFSET);
    bm.snapToFront();

    // 상태
    let holder   = playerA;
    let receiver = playerB;
    let passTimer = PASS_DELAY;
    let inFlight  = false;

    function tick(dt) {
        if (inFlight) {
            bm.update(dt);

            // 수신 판정: 볼이 receiver 근처에 도달했는지 확인
            const dist = Math.hypot(receiver.x - ball.x, receiver.y - ball.y);
            if (dist < RECEIVE_DIST) {
                bm.possess(receiver, POSSESS_OFFSET);
                bm.snapToFront();
                inFlight  = false;
                passTimer = PASS_DELAY;
                // 역할 교체
                [holder, receiver] = [receiver, holder];
            }
        } else {
            // holder가 볼을 보유하며 패스 타이머 감산
            passTimer -= dt;
            if (passTimer <= 0) {
                PassMovement.shortPass(bm, receiver.x, receiver.y);
                inFlight = true;
            }
        }
    }

    loop.add(tick);

    return function stop() {
        loop.remove(tick);
    };
}
