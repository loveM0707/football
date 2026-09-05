/**
 * TwoVsOne - 2:1 수적 우위 검증 메뉴
 *
 * 공격수 2명(빨강 7·9번)과 수비수 1명(파랑 4번)이 수적 우위를 인식하고
 * 행동하는지 검증한다. 검증 대상: 패스/드리블/슛 선택, 수비수 유인,
 * 패스 후 이동, 공간 침투, 패스 옵션 생성, 돌파, 슈팅.
 *
 * 2v1 전용 판단 코드 없음. 행동 선택은 전부 공통 모듈:
 *   - 상황 평가  = OverloadAssessment (NvM 범용: 3v2·4v3·11v10 재사용)
 *   - 선택 중재  = AttackChoice (슛 > 패스 > 드리블 확정 우선순위, 난수 없음)
 *   - 캐리어 이동 = DribbleDecision / 지원 이동 = OffBallDecision
 *   - 패스 실행  = PassIntent + PassAccuracy + PassMovement (3v3과 동일 조립)
 *   - 패스 후 이동 = TeamSupport.passAndGo / 수신 = BallReception
 *   - 수비       = DefenderDuelAI (복수 공격수 지연 수비) +
 *                  PassInterceptor (패스 비행 가로채기, 3v3과 동일 패턴)
 *   - 슛·GK     = ShotDecision + ShotAttempt + GoalkeeperController
 *
 * 시나리오가 하는 일은 메뉴 특유 강제뿐: 초기 배치, 국면 전환(소유·비행·슛),
 * 종료 조건(골/세이브/빗나감/아웃/탈취). 전술 판단은 하지 않는다.
 *
 * 종료 조건:
 *   - 골 (ShotMovement 'goal')
 *   - 골키퍼 세이브 ('save') / 빗나감·골대 ('miss-wide' 등)
 *   - 라인 아웃 ('out')
 *   - 수비수 탈취 후 소유 ('defend')
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { DribbleDecision }   from '../movement/DribbleDecision.js';
import { DefenderDuelAI }    from '../movement/DefenderDuelAI.js';
import { OffBallDecision }   from '../movement/OffBallDecision.js';
import { OverloadAssessment } from '../movement/OverloadAssessment.js';
import { AttackChoice, ATTACK_ACTION } from '../movement/AttackChoice.js';
import { PassIntent }        from '../movement/PassIntent.js';
import { PassAccuracy }      from '../movement/PassAccuracy.js';
import { PassMovement }      from '../movement/PassMovement.js';
import { BallReception }     from '../movement/BallReception.js';
import { PassInterceptor }   from '../movement/PassInterceptor.js';
import { TeamSupport }       from '../movement/TeamSupport.js';
import { CollisionSystem }   from '../movement/CollisionSystem.js';
import { BodyCollision }     from '../movement/BodyCollision.js';
import { PossessionContest } from '../movement/PossessionContest.js';
import { ShotMovement }      from '../movement/ShotMovement.js';
import { ShotDecision }      from '../movement/ShotDecision.js';
import { ShotExecution }     from '../movement/ShotExecution.js';
import { ShotAttempt }       from '../movement/ShotAttempt.js';
import { GoalkeeperMovement } from '../movement/GoalkeeperMovement.js';
import { GoalkeeperSave } from '../movement/GoalkeeperSave.js';
import { GoalkeeperController } from '../movement/GoalkeeperController.js';
import { angleTo } from '../movement/Direction.js';
import {
    CENTER_Y, GOAL_X, GOAL_TOP_Y, GOAL_BOTTOM_Y,
    Y_MIN, Y_MAX, FIELD_MIN_X, FIELD_BOTTOM,
} from '../movement/FieldGeometry.js';

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const SPEEDS = PlayerMovement.SPEEDS;
const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;
const PASS_WATCHDOG = 4.0; // 패스 비행 해소 제한 — 초과 시 가장 가까운 공격수 소유

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function run(layer, loop, onComplete = null, events = null) {
    // ── 초기 배치만 랜덤 (행동 판단은 모듈 몫) ──
    const aX = rand(370, 460), aY = rand(280, 400);
    const side = Math.random() < 0.5 ? -1 : 1;
    const bX = clamp(aX - rand(30, 90), FIELD_MIN_X, GOAL_X - 60);
    const bY = clamp(aY + side * rand(100, 150), Y_MIN + 30, Y_MAX - 30);

    const attA = new Player({ x: aX, y: aY, team: 'home', number: 9, angle: -90 }).render(layer);
    const attB = new Player({ x: bX, y: bY, team: 'home', number: 7, angle: -90 }).render(layer);
    const defender = new Player({
        x: clamp(aX + rand(170, 220), FIELD_MIN_X, GOAL_X - 60),
        y: clamp(aY + rand(-80, 80), Y_MIN + 30, Y_MAX - 30),
        team: 'away', number: 4, angle: 90,
    }).render(layer);
    const goalkeeper = new Player({
        x: GK_START_X, y: GK_START_Y, team: 'away', number: 1, angle: 90,
    }).render(layer);
    const ball = new Ball(attA.x, attA.y).render(layer);

    const attackers = [attA, attB];
    const pms = attackers.map(p => new PlayerMovement(p, { driftScale: 0 }));
    const defPM = new PlayerMovement(defender, { driftScale: 0 });
    const bm = new BallMovement(ball);
    const dcs = pms.map(pm => new DribbleController(pm, bm));
    const decisions = [0, 1].map(() => new DribbleDecision({
        dir: 1, centerY: CENTER_Y,
        yMin: Y_MIN, yMax: Y_MAX,
        fieldMinX: FIELD_MIN_X, fieldMaxX: GOAL_X - 25,
        shootRange: 185, beatChance: 0.7, beatCooldown: 1.6,
    }));
    const receptions = attackers.map((p, i) => new BallReception(p, pms[i], bm));

    // 지원 이동 판단 (무볼 1명용 — NvM 범용 모듈을 2v1에 호출)
    const offBall = new OffBallDecision({ dir: 1, attackGoalX: GOAL_X });
    // 수적 우위 상황 평가 + 선택 중재 (NvM 범용 — 3v2·4v3·11v10 재사용)
    const assessment = new OverloadAssessment({ dir: 1 });
    const choice = new AttackChoice({});

    // 수비 — 복수 공격수 지연 수비 + 패스 비행 가로채기
    const defenderDuel = new DefenderDuelAI({ goalX: GOAL_X, goalY: CENTER_Y, dir: 1 });
    const interceptor = new PassInterceptor([defender], [defPM], bm, {
        exclude: attackers,
        onControl: (p) => {
            if (complete || phase !== PHASE.PASSING) return;
            if (p === defender) finish('defend');
        },
    });

    const shotDecision = new ShotDecision({
        goalTopY: GOAL_TOP_Y, goalBotY: GOAL_BOTTOM_Y, goalCenterY: CENTER_Y,
    });
    const shotExec = new ShotExecution({ goalTopY: GOAL_TOP_Y, goalBotY: GOAL_BOTTOM_Y });
    const shotAttempt = new ShotAttempt({ shotExec });
    const shot = new ShotMovement({ goalX: GOAL_X });

    const gkc = new GoalkeeperController({
        goalkeeper,
        gkMovement: new GoalkeeperMovement({
            goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y,
        }),
        gkSave: new GoalkeeperSave({
            goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y,
            skill: 0.7, diveSpeed: 500,
        }),
        ballMovement: bm,
        positionSpeed: 350,
        diveSpeed: 500,
        reactionTime: 0.1,
    });

    const passIntent = new PassIntent();
    const passAccuracy = new PassAccuracy();
    const teamSupport = new TeamSupport({ dir: 1 });

    const PHASE = { DUEL: 'duel', PASSING: 'passing', LOOSE: 'loose', SHOOT: 'shoot' };
    let phase = PHASE.DUEL;
    let complete = false;
    let shooting = false;
    let saveTimer = 0;
    let carrierIdx = 0;   // 볼 소유 공격수 인덱스
    let clock = 0;
    let prevRoles = null;
    let passWatchdog = 0;
    let currentContest = null;

    function finish(result = null) {
        if (complete) return;
        complete = true;
        dcs.forEach(dc => dc.stop());
        receptions.forEach(r => r.stop());
        defenderDuel.stop(); interceptor.stop();
        if (currentContest) currentContest.stop();
        pms.forEach(pm => pm.stop()); defPM.stop();
        if (onComplete) onComplete(result);
    }

    // 소유자 교체 — 드리블 상한·두뇌 상태만 갱신
    // (이미 소유 중이면 possess·snap 생략 — 수신 트랩 위치를 덮어쓰지 않는다)
    function setCarrier(next) {
        const already = bm.owner === attackers[next];
        if (carrierIdx === next && already) return;
        dcs.forEach(dc => dc.stop());
        carrierIdx = next;
        if (!already) {
            bm.possess(attackers[next], POSSESS_OFFSET);
            bm.snapToFront();
        }
        dcs[next].start();
        decisions.forEach(d => d.reset());
        defenderDuel.reset();
        prevRoles = null;
        shooting = false;
    }

    // 패스 실행 — PassDecision 계열 표준 조립 (3v3 executePass와 동일 패턴)
    function executePass(mateIdx) {
        const c = carrierIdx;
        const carrier = attackers[c], mate = attackers[mateIdx];
        const carrierPM = pms[c], matePM = pms[mateIdx];
        dcs[c].stop();

        const mateVel = matePM.getVelocity();
        const mateSpeed = Math.hypot(mateVel.x, mateVel.y);
        const intent = passIntent.plan({
            ball, receiver: mate, receiverVel: mateVel,
            kind: mateSpeed > 60 ? 'through' : 'toFeet',
        });
        const aimX = clamp(intent.aimX, FIELD_MIN_X, GOAL_X - 25);
        const aimY = clamp(intent.aimY, Y_MIN + 10, Y_MAX - 10);
        const acc = passAccuracy.evaluate({
            dist: Math.hypot(mate.x - carrier.x, mate.y - carrier.y),
            nearestOpp: PassAccuracy.nearestOpponent(carrier, [defender]),
            moving: carrierPM.moving,
        });

        carrierPM.clearFacingTarget();
        carrierPM.setFacingTarget(angleTo(carrier.x, carrier.y, aimX, aimY));
        PassMovement.shortPass(bm, aimX, aimY, {
            arriveSpeed: rand(120, 145),
            deviationRad: acc.deviationRad,
        });

        // 패스 후 이동 — TeamSupport.passAndGo (모듈이 목표 산출)
        const go = teamSupport.passAndGo(carrier, mate, { dir: 1 });
        carrierPM.speed = SPEEDS[2];
        carrierPM.moveTo(go.x, go.y);

        receptions[mateIdx].start({ runTargetX: aimX, runTargetY: aimY });
        interceptor.start();
        passWatchdog = PASS_WATCHDOG;
        phase = PHASE.PASSING;
        if (events && events.onPass) events.onPass({ from: c, to: mateIdx });
    }

    function startLoose(tackler, victimIdx) {
        dcs.forEach(dc => dc.stop());
        pms.forEach(pm => pm.stop()); defPM.stop();
        currentContest = new PossessionContest(
            attackers[victimIdx], pms[victimIdx], defender, defPM, bm, {
                pokeSpeed: 220, catchDistance: 16, stealChance: 0.3,
            });
        currentContest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                currentContest = null;
                if (winner === defender) { finish('defend'); return; }
                setCarrier(attackers.indexOf(winner));
                phase = PHASE.DUEL;
            },
        });
        phase = PHASE.LOOSE;
    }

    function fireShot(decision) {
        const res = shotAttempt.fire({
            shooter: attackers[carrierIdx],
            movement: pms[carrierIdx],
            dribble: dcs[carrierIdx],
            ballMovement: bm,
            shot,
            goalX: GOAL_X,
            aimY: decision.aimY,
            defenders: [defender],
        });
        if (!res.fired) return false;
        if (res.plan.onTarget) gkc.watchShot(res.trajectory);
        else gkc.reset();
        phase = PHASE.SHOOT;
        shooting = true;
        if (events && events.onShot) events.onShot();
        return true;
    }

    bm.possess(attA, POSSESS_OFFSET);
    bm.snapToFront();
    dcs[0].start();
    defenderDuel.start();

    function tick(dt) {
        if (complete) return;
        clock += dt;

        if (phase !== PHASE.SHOOT) gkc.updatePosition(dt);

        if (saveTimer > 0) {
            saveTimer -= dt; bm.update(dt);
            if (saveTimer <= 0) finish('save');
            return;
        }

        if (phase === PHASE.SHOOT) {
            gkc.updateDive(dt);
            const hit = gkc.checkIntercept();
            if (hit && hit.saved) { saveTimer = 1.0; return; }
            shot.update(dt);
            if (shot.result !== null) {
                const r = shot.result === 'post-rebound'
                    ? (gkc.saveInfo ? gkc.saveInfo.decidedResult : 'post') : shot.result;
                finish(r);
            }
            return;
        }

        if (phase === PHASE.LOOSE) {
            if (currentContest) currentContest.update(dt);
            BodyCollision.separate(attA, attB);
            BodyCollision.separate(attackers[carrierIdx], defender);
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                finish('out'); return;
            }
            return;
        }

        // ── 패스 비행: 볼 물리 + 수신(BallReception) + 가로채기(PassInterceptor) ──
        if (phase === PHASE.PASSING) {
            const mateIdx = 1 - carrierIdx;
            bm.update(dt);
            receptions[mateIdx].update(dt);
            // BallReception/패스후이동은 목표만 지정하므로 여기서 적분한다
            pms[carrierIdx].update(dt);
            pms[mateIdx].update(dt);
            interceptor.update(dt);
            // 수비수는 수신자를 보고 지연 수비 계속 (모듈 판단)
            defenderDuel.update(dt, {
                defender, movement: defPM,
                attackers, attackerMovements: pms,
                ball, ballVelocity: { x: bm.vx, y: bm.vy },
                ballAttached: false,
            });
            BodyCollision.separate(attA, attB);
            BodyCollision.separate(attackers[mateIdx], defender);
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                finish('out'); return;
            }
            if (receptions[mateIdx].received) {
                interceptor.stop();
                setCarrier(mateIdx);
                phase = PHASE.DUEL;
                return;
            }
            passWatchdog -= dt;
            if (passWatchdog <= 0) {
                // 해소 실패 — 가장 가까운 공격수에게 소유를 넘기고 계속 (국면 배관)
                interceptor.stop();
                const d0 = Math.hypot(attA.x - ball.x, attA.y - ball.y);
                const d1 = Math.hypot(attB.x - ball.x, attB.y - ball.y);
                setCarrier(d1 < d0 ? 1 : 0);
                phase = PHASE.DUEL;
            }
            return;
        }

        // ── 듀얼: 소유/지원/수비 두뇌 + 선택 중재 ──
        const c = carrierIdx, m = 1 - carrierIdx;
        const carrier = attackers[c], mate = attackers[m];
        const carrierPM = pms[c], matePM = pms[m];

        carrierPM.update(dt);
        dcs[c].update(dt, { defenders: [defender] });
        bm.update(dt);

        // 캐리어 이동 (방법은 DribbleDecision이 수비수를 보고 결정)
        decisions[c].update(dt, {
            carrier, movement: carrierPM,
            attackGoalX: GOAL_X,
            defenders: [defender],
            ballAttached: dcs[c].ballAttached,
        });

        // 지원 이동 (역할·목표는 OffBallDecision이 산출, 실행만 moveTo)
        const intents = offBall.evaluate({
            carrier, mates: [{ player: mate, idx: m }],
            opponents: [defender], clock, prevRoles,
        });
        if (intents.length > 0) {
            prevRoles = intents.map(it => it.role);
            matePM.speed = intents[0].speed;
            matePM.moveTo(intents[0].targetX, intents[0].targetY);
        }
        matePM.update(dt);

        // 수비 (복수 공격수를 보고 지연 수비)
        defenderDuel.update(dt, {
            defender, movement: defPM,
            attackers, attackerMovements: pms,
            ball, ballVelocity: { x: bm.vx, y: bm.vy },
            ballAttached: dcs[c].ballAttached,
        });

        BodyCollision.separate(attA, attB);
        BodyCollision.separate(carrier, defender);

        // 태클 성립 — LUNGE 커밋 중에 접촉했을 때만
        if (bm.owner === carrier && defenderDuel.tackleIntent
            && CollisionSystem.isTackle(defender, ball)) {
            startLoose(defender, c);
            return;
        }

        if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
            finish('out'); return;
        }

        // 선택 중재 — 슛 > 패스 > 드리블 (확정 우선순위, 난수 없음)
        const assess = assessment.assess({
            carrier, mates: [{ player: mate, idx: m }],
            opponents: [defender], ball, dir: 1, attackGoalX: GOAL_X,
        });
        const shotEval = shotDecision.evaluate({
            shooter: carrier, ball, attackGoalX: GOAL_X, dir: 1,
            defenders: [defender], keeper: goalkeeper,
            ballAttached: dcs[c].ballAttached,
        });
        const selected = choice.choose({
            assessment: assess, shotEval, ballAttached: dcs[c].ballAttached,
            owner: carrier, dt,
        });
        if (events && events.onChoice) events.onChoice(selected);
        if (selected.action === ATTACK_ACTION.PASS && selected.mateIdx === m) {
            executePass(m);
        } else if (selected.action === ATTACK_ACTION.SHOOT && !shooting) {
            shooting = fireShot(shotEval);
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        dcs.forEach(dc => dc.stop());
        receptions.forEach(r => r.stop());
        defenderDuel.stop(); interceptor.stop();
        if (currentContest) currentContest.stop();
        pms.forEach(pm => pm.stop()); defPM.stop();
    };
}
