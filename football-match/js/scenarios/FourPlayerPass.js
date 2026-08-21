/**
 * FourPlayerPass - 4인 패스 순환
 *
 * 배치: 하프라인 중심에서 정사각형 형태 (간격 80 SVG)
 *   선수0: 왼쪽 위   선수1: 왼쪽 아래
 *   선수2: 오른쪽 위  선수3: 오른쪽 아래
 *
 * 자연스러운 움직임:
 *   - 볼 없는 선수: 홈 포지션 근처 미세 움직임 (IdleMovement)
 *   - 모든 선수: 볼 방향으로 부드럽게 고개를 돌림 (smooth angle)
 *   - 홀더: 수신 후 다음 타겟 향해 부드럽게 방향전환 → PASS_DELAY 동안 자연스럽게 준비
 *   - 수신자: 반응 후 볼을 향해 몸을 돌리고 인터셉트 위치로 이동
 */
import { Player }        from '../entities/Player.js';
import { Ball }          from '../entities/Ball.js';
import { BallMovement }  from '../movement/BallMovement.js';
import { PassMovement }  from '../movement/PassMovement.js';
import { PassReceiver }  from '../movement/PassReceiver.js';
import { IdleMovement }  from '../movement/IdleMovement.js';
import { InertiaController } from '../movement/AngleInertia.js';

const CENTER_Y   = 340;
const HALF_X     = 525;
const CENTER_X   = HALF_X;

const OFFSET = 80;

function angleTo(x, y, tx, ty) {
    return Math.atan2(x - tx, ty - y) * 180 / Math.PI;
}

const POSITIONS = [
    { x: HALF_X - OFFSET, y: CENTER_Y - OFFSET },
    { x: HALF_X - OFFSET, y: CENTER_Y + OFFSET },
    { x: HALF_X + OFFSET, y: CENTER_Y - OFFSET },
    { x: HALF_X + OFFSET, y: CENTER_Y + OFFSET },
];

const INITIAL_ANGLES = POSITIONS.map(p => angleTo(p.x, p.y, CENTER_X, CENTER_Y));

const POSSESS_OFFSET     = Player.BODY_RADIUS + Ball.RADIUS + 4;  // 19
const RECEIVE_DIST       = POSSESS_OFFSET + 3;                    // 22
const PASS_DELAY          = 0.4;
const PASSER_RETURN_DELAY = 0.2;
const PASS_ANGLE_DEG      = 5;
const LONG_PASS_CHANCE    = 0.4;
const HOME_SPEED          = 75;

const PLAYERS_COUNT = 4;

export function run(layer, loop, onComplete = null) {
    const players = [];
    for (let i = 0; i < PLAYERS_COUNT; i++) {
        const pos = POSITIONS[i];
        players.push(new Player({
            x: pos.x, y: pos.y, team: 'home', number: i + 1, angle: INITIAL_ANGLES[i],
        }).render(layer));
    }

    const ball = new Ball(players[0].x, players[0].y).render(layer);
    const bm   = new BallMovement(ball);

    const homePositions = POSITIONS.map(p => ({ x: p.x, y: p.y }));

    const passReceiver = new PassReceiver();
    const idle         = new IdleMovement(PLAYERS_COUNT);

    // 관성(원심력) — AngleInertia 공통 모듈 (메뉴/실경기 공통)
    const turn = new InertiaController(PLAYERS_COUNT);
    for (let i = 0; i < PLAYERS_COUNT; i++) turn.setTarget(i, players[i].angle);
    function setTargetAngle(idx, angle) { turn.setTarget(idx, angle); }
    function smoothAngles(dt) { turn.update(dt, players); }

    let holderIdx          = 0;
    let receiverIdx        = -1;
    let passTimer          = PASS_DELAY;
    let inFlight           = false;
    let isLongPass         = false;
    let aerialLandX        = CENTER_X;
    let aerialLandY        = CENTER_Y;
    let passerReturnTimer  = 0;
    let passerReturnSpeed  = HOME_SPEED;

    function homeOf(idx) { return homePositions[idx]; }

    function moveTowardHome(playerIdx, dt, speed = HOME_SPEED) {
        const player = players[playerIdx];
        const home   = homeOf(playerIdx);
        const dx     = home.x - player.x;
        const dy     = home.y - player.y;
        const dist   = Math.hypot(dx, dy);
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

        holderIdx   = receiverIdx;
        receiverIdx = getRandomReceiver(holderIdx);

        // 새 홀더: 다음 타겟을 향해 부드럽게 회전 (PASS_DELAY 동안 자연스럽게)
        setTargetAngle(holderIdx, angleTo(
            players[holderIdx].x, players[holderIdx].y,
            players[receiverIdx].x, players[receiverIdx].y,
        ));

        // 나머지: 볼을 향해 부드럽게 고개 돌림
        for (let i = 0; i < PLAYERS_COUNT; i++) {
            if (i !== holderIdx) {
                setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));
            }
        }
    }

    // 초기화
    receiverIdx = getRandomReceiver(holderIdx);
    setTargetAngle(holderIdx, angleTo(
        players[holderIdx].x, players[holderIdx].y,
        players[receiverIdx].x, players[receiverIdx].y,
    ));
    // 초기 스냅 (첫 프레임 회전 없이)
    players[holderIdx].setAngle(turn.targets[holderIdx]);
    for (let i = 0; i < PLAYERS_COUNT; i++) {
        if (i !== holderIdx) {
            players[i].setAngle(INITIAL_ANGLES[i]);
            turn.setTarget(i, INITIAL_ANGLES[i]);
        }
    }
    bm.possess(players[holderIdx], POSSESS_OFFSET);
    bm.snapToFront();

    function tick(dt) {
        bm.update(dt);
        smoothAngles(dt);

        if (inFlight) {
            // 패서: 짧은 정지 후 역산 속도로 홈 복귀
            passerReturnTimer -= dt;
            if (passerReturnTimer <= 0) {
                moveTowardHome(holderIdx, dt, passerReturnSpeed);
            }

            // 수신자: 볼 방향으로 고개 돌리고 인터셉트 위치로 이동
            setTargetAngle(receiverIdx, angleTo(
                players[receiverIdx].x, players[receiverIdx].y, ball.x, ball.y,
            ));
            passReceiver.update(dt, players[receiverIdx], () => {
                if (isLongPass) return { x: aerialLandX, y: aerialLandY };
                return PassMovement.interceptPoint(bm, players[receiverIdx]);
            });

            // 미참여 선수: 볼 추적 + 홈 근처 미세 움직임
            for (let i = 0; i < PLAYERS_COUNT; i++) {
                if (i !== holderIdx && i !== receiverIdx) {
                    setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));
                    idle.update(dt, players[i], i, homeOf(i).x, homeOf(i).y);
                }
            }

            // 숏패스 수신 판정
            if (!isLongPass) {
                const dist = Math.hypot(players[receiverIdx].x - ball.x, players[receiverIdx].y - ball.y);
                if (dist < RECEIVE_DIST) onReceive();
            }

        } else {
            // 소유 중: 볼 위치 유지
            bm.snapToFront();

            // 수신자(이전 패서): 홈 복귀 + 볼 방향 추적
            moveTowardHome(receiverIdx, dt);
            setTargetAngle(receiverIdx, angleTo(
                players[receiverIdx].x, players[receiverIdx].y, ball.x, ball.y,
            ));

            // 홀더: 타겟 방향으로 회전 중(setTargetAngle은 onReceive에서 설정됨)
            // 미세 체중 이동
            idle.update(dt, players[holderIdx], holderIdx, homeOf(holderIdx).x, homeOf(holderIdx).y);

            // 미참여 선수: 볼 추적 + 미세 움직임
            for (let i = 0; i < PLAYERS_COUNT; i++) {
                if (i !== holderIdx && i !== receiverIdx) {
                    setTargetAngle(i, angleTo(players[i].x, players[i].y, ball.x, ball.y));
                    idle.update(dt, players[i], i, homeOf(i).x, homeOf(i).y);
                }
            }

            passTimer -= dt;
            if (passTimer <= 0) {
                // 킥 직전 각도 확정 (발 위치 정확도)
                players[holderIdx].setAngle(turn.targets[holderIdx]);
                bm.snapToFront();

                isLongPass = Math.random() < LONG_PASS_CHANCE;

                if (isLongPass) {
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
                    aerialLandX       = result.landX;
                    aerialLandY       = result.landY;
                    passerReturnSpeed = calcPasserReturnSpeed(result.flightDuration);
                } else {
                    const receiver = players[receiverIdx];
                    const result   = PassMovement.shortPass(bm, receiver.x, receiver.y, {
                        angleDevDeg: PASS_ANGLE_DEG,
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
    };
}
