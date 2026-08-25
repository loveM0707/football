/**
 * OneVsOne - 1:1 대결 시나리오
 *
 * 배치:
 *   공격수(빨강, 9번) – 하프라인 가운데 (525, 340), 볼 소유
 *   수비수(파랑, 4번) – 오른쪽 30m (825, 340)
 *   골키퍼(파랑, 1번) – 오른쪽 골대 (1030, 340)
 *
 * 흐름:
 *   1. 공격수가 수비수를 제치며 드리블 → 슈팅 가능 지점 도달 시 슛
 *   2. 수비수는 볼을 가로채려 함 (CooperativeDefenseAI 프레스)
 *   3. 수비수가 가로채면 입장이 바뀜 → 수비수가 드리블로 하프라인 쪽 복귀
 *      공격수는 볼을 빼앗으러 추격
 *
 * 종료 조건:
 *   - 골 (ShotMovement 'goal')
 *   - 골라인·엔드라인 밖으로 나감 ('out')
 *   - 수비수가 하프라인까지 드리블해 소유 ('defend')
 *   - 골키퍼 세이브 ('save')
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { CollisionSystem }   from '../movement/CollisionSystem.js';
import { BodyCollision }     from '../movement/BodyCollision.js';
import { DribbleBehaviors }  from '../movement/DribbleBehaviors.js';
import { AttackerDuelAI }    from '../movement/AttackerDuelAI.js';
import { CooperativeDefenseAI } from '../movement/CooperativeDefenseAI.js';
import { PossessionContest } from '../movement/PossessionContest.js';
import { ShotMovement }      from '../movement/ShotMovement.js';
import { GoalkeeperMovement } from '../movement/GoalkeeperMovement.js';
import { GoalkeeperSave, SAVE_RESULT } from '../movement/GoalkeeperSave.js';
import { angleTo, forwardVector } from '../movement/Direction.js';

const CENTER_X         = 525;
const CENTER_Y         = 340;
const GOAL_X           = 1050;
const GOAL_TOP_Y       = 303.4;
const GOAL_BOTTOM_Y    = 376.6;
const DEFENDER_START_X = 525 + 300;  // 825 (오른쪽 30m)
const DEFENDER_START_Y = CENTER_Y;
const SHOOT_MIN_X      = GOAL_X - 30 * 10;    // 750
const SHOOT_MAX_X      = GOAL_X - 16.5 * 10;  // 885
const HALF_LINE_X      = 525;
const Y_MIN            = 45;
const Y_MAX            = 635;
const AVOID_DIST       = 80;
const POSSESS_OFFSET   = Player.BODY_RADIUS + Ball.RADIUS + 4;

const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;
const GK_POSITION_SPEED = 350;
const GK_DIVE_SPEED = 500;
const GK_REACTION_TIME = 0.1;

const SPEEDS = PlayerMovement.SPEEDS;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function randomSpeed()     { return SPEEDS[Math.floor(Math.random() * SPEEDS.length)]; }
function randomSpeedDist() { return 50  + Math.random() * 50; }
function randomDirDist()   { return 100 + Math.random() * 50; }

function generateAttackWaypoints(startX, startY) {
    const wps       = [];
    const avoidSign = Math.random() < 0.5 ? -1 : 1;
    const shootX    = clamp(SHOOT_MIN_X + 90 + Math.random() * (SHOOT_MAX_X - SHOOT_MIN_X - 100), SHOOT_MIN_X + 40, SHOOT_MAX_X);
    let x = startX, y = startY;
    let dir = -90, speed = randomSpeed();
    let dirLeft = randomDirDist(), speedLeft = randomSpeedDist();
    let avoided = false;

    while (x < shootX) {
        const progress = (x - startX) / (shootX - startX);
        const step = Math.min(dirLeft, speedLeft);
        const fwd = forwardVector(dir);
        let cx = Math.min(x + fwd.x * step, GOAL_X - 40);
        let cy = clamp(y + fwd.y * step, Y_MIN, Y_MAX);

        if (!avoided && x < DEFENDER_START_X - 20 && cx >= DEFENDER_START_X - 20) {
            avoided = true;
            const safeY = clamp(DEFENDER_START_Y + avoidSign * (AVOID_DIST + 10), Y_MIN, Y_MAX);
            wps.push({ x: DEFENDER_START_X - 20, y: safeY, speed });
            x = DEFENDER_START_X - 20; y = safeY;
            dirLeft = randomDirDist(); speedLeft = randomSpeedDist();
            continue;
        }

        wps.push({ x: cx, y: cy, speed });
        x = cx; y = cy;
        dirLeft -= step; speedLeft -= step;

        if (dirLeft <= 0.5) {
            const maxDev  = 42 * (1 - progress * 0.57);
            const yOffset = y - CENTER_Y;
            const pull    = 0.25 + progress * 0.55;
            const proximity = (!avoided && x < DEFENDER_START_X)
                ? Math.max(0, 1 - (DEFENDER_START_X - x) / 300) : 0;
            const bias = -yOffset * pull * 0.38 + avoidSign * maxDev * proximity * 0.5;
            const deviation = clamp((Math.random() * 2 - 1) * maxDev + bias, -maxDev, maxDev);
            dir = -90 + deviation; dirLeft = randomDirDist();
        }
        if (speedLeft <= 0.5) { speed = randomSpeed(); speedLeft = randomSpeedDist(); }
    }

    wps.push({ x: shootX, y: CENTER_Y, speed: randomSpeed() });
    return wps;
}

function randomAimY() {
    const aim = Math.random();
    if (aim < 0.04) return GOAL_TOP_Y - 1 + Math.random() * 3;
    if (aim < 0.08) return GOAL_BOTTOM_Y - 1 + Math.random() * 3;
    if (aim < 0.18) return GOAL_TOP_Y - 11 + Math.random() * 3;
    if (aim < 0.28) return GOAL_BOTTOM_Y + 8 + Math.random() * 3;
    const safeTop = GOAL_TOP_Y + 9;
    const safeBottom = GOAL_BOTTOM_Y - 9;
    return safeTop + Math.random() * (safeBottom - safeTop);
}

function randomShotHeight() {
    const roll = Math.random();
    if (roll < 0.32) return { targetHeight: 0.06, arcHeight: 0.08 };
    if (roll < 0.78) return { targetHeight: 0.35 + Math.random() * 1.35, arcHeight: 0.15 + Math.random() * 0.2 };
    if (roll < 0.82) return { targetHeight: 2.32 + Math.random() * 0.1, arcHeight: 0.06 };
    return { targetHeight: 2.65 + Math.random() * 0.35, arcHeight: 0.08, overBar: true };
}

export function run(layer, loop, onComplete = null) {
    const attacker = new Player({
        x: CENTER_X, y: CENTER_Y, team: 'home', number: 9, angle: -90,
    }).render(layer);
    const defender = new Player({
        x: DEFENDER_START_X, y: CENTER_Y, team: 'away', number: 4, angle: 90,
    }).render(layer);
    const goalkeeper = new Player({
        x: GK_START_X, y: GK_START_Y, team: 'away', number: 1, angle: 90,
    }).render(layer);
    const ball = new Ball(attacker.x, attacker.y).render(layer);

    const attPM = new PlayerMovement(attacker, { driftScale: 0 });
    const defPM = new PlayerMovement(defender, { driftScale: 0 });
    const bm = new BallMovement(ball);
    const attDC = new DribbleController(attPM, bm);
    const defDC = new DribbleController(defPM, bm);
    const shot = new ShotMovement({ goalX: GOAL_X });

    const gkMovement = new GoalkeeperMovement({
        goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y,
    });
    const gkSave = new GoalkeeperSave({
        goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y,
        skill: 0.7, diveSpeed: GK_DIVE_SPEED,
    });

    const defenseAI = new CooperativeDefenseAI(
        [{ player: defender, movement: defPM }],
        { assignmentInterval: 0.25, retargetInterval: 0.15, pressHolder: true },
    );

    // 태클 → 루즈볼 공방 (수비수/공격수 입장 교대의 핵심)
    const contest = new PossessionContest(attacker, attPM, defender, defPM, bm, {
        pokeSpeed: 220,
        catchDistance: 16,
    });

    // 상태 머신
    const PHASE = { ATTACK: 'attack', RETURN: 'return', LOOSE: 'loose', SHOOT: 'shoot' };
    let phase = PHASE.ATTACK;
    let complete = false;
    let shootReady = false;
    let shooting = false;
    let planIndex = 0;
    let waypoints = [];
    let gkDiving = false;
    let gkReactionTimer = 0;
    let gkDiveTargetX = 0;
    let gkDiveTargetY = 0;
    let saveInfo = null;
    let saveTimer = 0;
    let gkTarget = { x: GK_START_X, y: GK_START_Y, facingAngle: 90 };

    function finish(result = null) {
        if (complete) return;
        complete = true;
        attDC.stop(); defDC.stop(); defenseAI.stop(); contest.stop();
        attPM.stop(); defPM.stop();
        if (onComplete) onComplete(result);
    }

    // 공격수(홈) 드리블 공격 재개
    function startAttack() {
        defDC.stop();
        attPM.stop();
        bm.possess(attacker, POSSESS_OFFSET);
        bm.snapToFront();
        attDC.start();
        defenseAI.start();
        duelAI.start();
        phase = PHASE.ATTACK;
        planIndex = 0;
        waypoints = generateAttackWaypoints(attacker.x, attacker.y);
        shootReady = false;
        nextDribble();
    }

    // 수비수(원정) 볼 소유 → 하프라인 복귀
    function startReturn() {
        attDC.stop();
        defenseAI.stop();
        attPM.stop();
        bm.possess(defender, POSSESS_OFFSET);
        bm.snapToFront();
        defDC.start();
        defPM.speed = SPEEDS[3];
        phase = PHASE.RETURN;
    }

    // 루즈볼 공방 시작 (tackler가 볼을 쳐냄)
    function startLoose(tackler) {
        attDC.stop(); defDC.stop(); defenseAI.stop();
        attPM.stop(); defPM.stop();
        contest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                if (winner === attacker) startAttack();
                else startReturn();
            },
        });
        phase = PHASE.LOOSE;
    }

    function handleTackle() {
        // 수비수가 볼을 쳐냄 → 루즈볼 공방
        duelAI.stop();
        startLoose(defender);
    }

    // 공격수 드리블 시퀀스
    function nextDribble() {
        if (phase !== PHASE.ATTACK || complete) return;
        if (planIndex >= waypoints.length) { shootReady = true; attPM.stop(); return; }
        const wp = waypoints[planIndex++];
        const dist = Math.hypot(attacker.x - defender.x, attacker.y - defender.y);
        const spd = dist < 100 ? SPEEDS[4]
                  : dist < 160 ? Math.max(wp.speed, SPEEDS[3])
                  : wp.speed;
        attDC.setSpeed(spd);
        attPM.clearFacingTarget();
        attPM.moveTo(wp.x, wp.y, nextDribble);
    }

    function fireShot() {
        if (!shootReady || !attDC.ballAttached) return false;
        const targetY = randomAimY();
        const height = randomShotHeight();
        const isSideAim = targetY < GOAL_TOP_Y || targetY > GOAL_BOTTOM_Y;
        const shotTargetY = height.overBar && !isSideAim ? GOAL_TOP_Y + 20 : targetY;
        const targetAngle = angleTo(attacker.x, attacker.y, GOAL_X, shotTargetY);
        const shotSpeed = 520 + Math.random() * 80;

        attPM.stop();
        attPM.resetTurn(targetAngle);
        attPM.setFacingTarget(targetAngle);
        attDC.stop();
        defenseAI.stop();

        const fired = shot.shoot(bm, {
            targetY: shotTargetY, targetHeight: height.targetHeight,
            arcHeight: height.arcHeight, speed: shotSpeed,
        });
        if (!fired) return false;

        const isOnTarget = shotTargetY >= GOAL_TOP_Y && shotTargetY <= GOAL_BOTTOM_Y;
        if (isOnTarget) {
            const shotTrajectory = {
                startX: ball.x, startY: ball.y, targetX: GOAL_X, targetY: shotTargetY,
                speed: shotSpeed, startHeight: height.targetHeight * 0.1,
                targetHeight: height.targetHeight, arcHeight: height.arcHeight,
            };
            const evaluation = gkSave.evaluateSave(shotTrajectory, goalkeeper);
            const cappedSavePointX = Math.min(evaluation.savePointX, GOAL_X - 15);
            saveInfo = {
                shotTrajectory, savePointX: cappedSavePointX,
                savePointY: evaluation.savePointY, canSave: evaluation.canSave,
                decidedResult: evaluation.result,
            };
            gkReactionTimer = GK_REACTION_TIME;
            gkDiving = true;
            gkDiveTargetX = cappedSavePointX;
            gkDiveTargetY = evaluation.savePointY;
        } else {
            saveInfo = null; gkDiving = false;
        }
        phase = PHASE.SHOOT;
        shooting = true;
        return true;
    }

    const duelAI = new AttackerDuelAI(attacker, defender, {
        onBeaten: () => {
            DribbleBehaviors.sprintHomed(attPM, attDC, attacker,
                clamp(SHOOT_MAX_X - 10, SHOOT_MIN_X, SHOOT_MAX_X), CENTER_Y,
                () => { if (phase === PHASE.ATTACK) { shootReady = true; attPM.stop(); } },
            );
        },
        onDuelA: () => {
            const maxX = GOAL_X - POSSESS_OFFSET - 5;
            (function keepStep() {
                if (duelAI.state !== 'DUEL_A' || phase !== PHASE.ATTACK || complete) return;
                DribbleBehaviors.slowKeepStep(attPM, attDC, attacker, maxX, keepStep);
            })();
        },
        onDuelBurst: (sign) => {
            DribbleBehaviors.lateralBurst(attPM, attDC, attacker, sign,
                () => { if (phase === PHASE.ATTACK && !complete) {
                    DribbleBehaviors.sprintHomed(attPM, attDC, attacker,
                        clamp(SHOOT_MAX_X - 10, SHOOT_MIN_X, SHOOT_MAX_X), CENTER_Y,
                        () => { if (phase === PHASE.ATTACK) { shootReady = true; attPM.stop(); } },
                    );
                } },
                { maxX: GOAL_X - 50, yMin: Y_MIN, yMax: Y_MAX },
            );
        },
    });

    bm.possess(attacker, POSSESS_OFFSET);
    bm.snapToFront();
    attDC.start();
    defenseAI.start();
    duelAI.start();
    waypoints = generateAttackWaypoints(CENTER_X, CENTER_Y);
    nextDribble();

    function tick(dt) {
        if (complete) return;

        // 골키퍼 위치 (드리블 중)
        if (phase !== PHASE.SHOOT) {
            gkTarget = gkMovement.update(
                { x: ball.x, y: ball.y, vx: bm.vx, vy: bm.vy }, goalkeeper,
            );
            const dx = gkTarget.x - goalkeeper.x;
            const dy = gkTarget.y - goalkeeper.y;
            const d = Math.hypot(dx, dy);
            if (d > 1) {
                const s = Math.min(GK_POSITION_SPEED * dt, d);
                goalkeeper.setPosition(goalkeeper.x + (dx / d) * s, goalkeeper.y + (dy / d) * s);
            }
            goalkeeper.setAngle(gkTarget.facingAngle);
        }

        if (saveTimer > 0) {
            saveTimer -= dt; bm.update(dt);
            if (saveTimer <= 0) finish('save');
            return;
        }

        // ── 슈팅 비행 ────────────────────────────────
        if (phase === PHASE.SHOOT) {
            if (gkReactionTimer > 0) gkReactionTimer -= dt;
            if (gkDiving && gkReactionTimer <= 0) {
                const dx = gkDiveTargetX - goalkeeper.x;
                const dy = gkDiveTargetY - goalkeeper.y;
                const d = Math.hypot(dx, dy);
                if (d > 1) {
                    const s = Math.min(GK_DIVE_SPEED * dt, d);
                    goalkeeper.setPosition(goalkeeper.x + (dx / d) * s, goalkeeper.y + (dy / d) * s);
                }
                goalkeeper.setAngle(90);
            }
            if (saveInfo && !saveInfo.intercepted && ball.x >= saveInfo.savePointX - 5) {
                saveInfo.intercepted = true;
                const gd = Math.hypot(goalkeeper.x - saveInfo.savePointX, goalkeeper.y - saveInfo.savePointY);
                if (gd < gkSave.reachRadius) {
                    const st = gkSave.determineSaveType(saveInfo.shotTrajectory, goalkeeper,
                        { x: saveInfo.savePointX, y: saveInfo.savePointY });
                    if (st !== SAVE_RESULT.GOAL) {
                        if (st === SAVE_RESULT.CATCH) {
                            ball.setPosition(saveInfo.savePointX - 12, saveInfo.savePointY);
                            ball.setHeight(0);
                        } else {
                            const df = gkSave.calculateDeflection(st,
                                { x: saveInfo.savePointX, y: saveInfo.savePointY }, saveInfo.shotTrajectory);
                            ball.setPosition(saveInfo.savePointX - 8, saveInfo.savePointY);
                            bm.release(df.vx, df.vy);
                        }
                        saveTimer = 1.0; return;
                    }
                }
                saveInfo = null;
            }
            shot.update(dt);
            if (shot.result !== null) {
                const r = shot.result === 'post-rebound'
                    ? (saveInfo ? saveInfo.decidedResult : 'post') : shot.result;
                finish(r);
            }
            return;
        }

        // ── 수비수 복귀 (입장 교대 후) ────────────────
        if (phase === PHASE.RETURN) {
            defPM.update(dt);
            defDC.update(dt);
            bm.update(dt);
            bm.snapToFront();

            // 공격수(원래)가 수비수(볼 소유)를 추격
            attPM.speed = SPEEDS[4];
            attPM.moveTo(ball.x, ball.y);
            attPM.update(dt);

            // 몸통 충돌 분리 — 관통 방지 (최대 50% 겹침 허용)
            BodyCollision.separate(attacker, defender);

            // 수비수가 하프라인 도달 → 종료
            if (defender.x <= HALF_LINE_X && bm.owner === defender) { finish('defend'); return; }

            // 공격수가 수비수를 태클 → 루즈볼 공방
            if (bm.owner === defender && CollisionSystem.isTackle(attacker, ball)) {
                duelAI.stop();
                startLoose(attacker);
                return;
            }

            // 골라인·엔드라인 밖
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > 680) { finish('out'); return; }
            return;
        }

        // ── 루즈볼 공방 ──────────────────────────────
        if (phase === PHASE.LOOSE) {
            contest.update(dt);
            // 루즈볼 추적 중 몸통 충돌 분리
            BodyCollision.separate(attacker, defender);
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > 680) { finish('out'); return; }
            return;
        }

        // ── 공격 드리블 ──────────────────────────────
        attPM.update(dt);
        attDC.update(dt);
        bm.update(dt);
        defenseAI.update(dt, {
            ball, ballVelocity: { x: bm.vx, y: bm.vy },
            attackers: [attacker], holder: attacker, inFlight: false,
        });
        duelAI.update(dt);

        // 몸통 충돌 분리 — 관통 방지 (최대 50% 겹침 허용)
        BodyCollision.separate(attacker, defender);

        // 수비수가 볼 가로챔
        if (bm.owner === attacker && CollisionSystem.isTackle(defender, ball)) {
            handleTackle(); return;
        }

        // 골라인·엔드라인 밖
        if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > 680) { finish('out'); return; }

        if (shootReady && attDC.ballAttached) {
            shooting = fireShot();
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        attDC.stop(); defDC.stop(); defenseAI.stop();
        attPM.stop(); defPM.stop();
    };
}
