/**
 * ThreeVsTwo - 3:2 소규모 공격 전개 검증 메뉴
 *
 * 공격수 3명(빨강 7·9·11번)과 수비수 2명(파랑 4·5번)으로 2v1의
 * 수적 우위가 인원 증가에도 작동하는지 검증한다. 검증 대상:
 * 폭 유지·깊이 유지·지원·패스 옵션·드리블·침투·패스 후 이동·
 * 수비수 간 커버·수비 라인 유지·수적 우위 활용.
 *
 * 3v2 전용 판단 코드 없음. 행동 선택은 전부 공통 모듈:
 *   - 상황 평가  = OverloadAssessment (NvM 범용)
 *   - 선택 중재  = AttackChoice (슛 > 패스 > 드리블 확정 우선순위, 난수 없음)
 *   - 캐리어 이동 = DribbleDecision / 무볼 이동 = OffBallDecision
 *     (침투 1명 + 근거리 지원 + 원거리 폭 유지 — 뭉침 방지)
 *   - 패스 실행  = PassIntent + PassAccuracy + PassMovement (2v1과 동일 조립)
 *   - 패스 후 이동 = TeamSupport.passAndGo / 수신 = BallReception
 *   - 수비       = DefensiveDecision (NvM 범용 — 3v2에서는 press + lane-block.
 *                  누가 press인지는 매 틱 위치로 재결정, A/B 강제 지정 없음)
 *   - 태클 커밋  = TackleDecision (킥 국면에 PRESS만 발을 뻗는다)
 *   - 태클 해소  = PossessionContest
 *   - 슛·GK     = ShotDecision + ShotAttempt + GoalkeeperController
 *
 * 시나리오가 하는 일은 메뉴 특유 강제뿐: 초기 배치(폭을 벌려 시작하되
 * 이후 배치는 모듈 몫), 국면 전환(소유·비행·공방·슛), 태클 성립 판정
 * (PRESS 역할의 TackleDecision 커밋 + 접촉), 종료 조건(골/세이브/빗나감/아웃/탈취).
 * 전술 판단은 하지 않는다.
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
import { OffBallDecision }   from '../movement/OffBallDecision.js';
import { OverloadAssessment } from '../movement/OverloadAssessment.js';
import { AttackChoice, ATTACK_ACTION } from '../movement/AttackChoice.js';
import { DefensiveDecision } from '../movement/DefensiveDecision.js';
import { DEFENSE_ROLE }      from '../movement/CooperativeDefenseAI.js';
import { TackleDecision }    from '../movement/TackleDecision.js';
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

// 태클 커밋 타이밍은 TackleDecision이 소유 (킥 국면·거리·정면·쿨다운).
// 누가 PRESS인지는 DefensiveDecision이 정하므로 시나리오는 수비수를 지정하지 않는다.

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function run(layer, loop, onComplete = null, events = null) {
    // ── 초기 배치만 랜덤 (이후 배치는 모듈 몫) ──
    // 폭을 벌려 시작: 중앙 캐리어 + 좌 측면 + 우 하프스페이스.
    const cX = rand(400, 470), cY = rand(290, 390);
    const initPos = [
        { x: cX, y: cY, number: 9 },
        { x: rand(330, 400), y: rand(120, 180), number: 7 },
        { x: rand(360, 430), y: rand(490, 550), number: 11 },
    ];

    const attackers = initPos.map(s => new Player({
        x: clamp(s.x, FIELD_MIN_X, GOAL_X - 60),
        y: clamp(s.y, Y_MIN + 30, Y_MAX - 30),
        team: 'home', number: s.number, angle: -90,
    }).render(layer));
    // 수비수도 깊이를 달리해 배치하되 범위가 겹치므로 인덱스가 역할을 정하지 않는다.
    const defenders = [4, 5].map((num, k) => new Player({
        x: clamp(cX + (k === 0 ? rand(90, 170) : rand(150, 250)), FIELD_MIN_X, GOAL_X - 60),
        y: clamp(cY + rand(-140, 140), Y_MIN + 30, Y_MAX - 30),
        team: 'away', number: num, angle: 90,
    }).render(layer));
    const goalkeeper = new Player({
        x: GK_START_X, y: GK_START_Y, team: 'away', number: 1, angle: 90,
    }).render(layer);
    const ball = new Ball(attackers[0].x, attackers[0].y).render(layer);

    const pms = attackers.map(p => new PlayerMovement(p, { driftScale: 0 }));
    const defPMs = defenders.map(p => new PlayerMovement(p, { driftScale: 0 }));
    const bm = new BallMovement(ball);
    const dcs = pms.map(pm => new DribbleController(pm, bm));
    const decisions = [0, 1, 2].map(() => new DribbleDecision({
        dir: 1, centerY: CENTER_Y,
        yMin: Y_MIN, yMax: Y_MAX,
        fieldMinX: FIELD_MIN_X, fieldMaxX: GOAL_X - 25,
        shootRange: 185, beatChance: 0.7, beatCooldown: 1.6,
    }));
    const receptions = attackers.map((p, i) => new BallReception(p, pms[i], bm));

    // 무볼 이동 판단 (NvM 범용 모듈을 3v2에 호출)
    const offBall = new OffBallDecision({ dir: 1, attackGoalX: GOAL_X });
    // 수적 우위 상황 평가 + 선택 중재 (NvM 범용)
    const assessment = new OverloadAssessment({ dir: 1 });
    const choice = new AttackChoice({});
    // 수비 역할 분담 (NvM 범용 — 3v2에서는 press + lane-block)
    const defense = new DefensiveDecision({ dir: 1, goalX: GOAL_X, goalY: CENTER_Y });
    // 태클 커밋 판단 (NvM 범용 — 킥 국면에 PRESS만 발을 뻗는다)
    const tackle = new TackleDecision({});

    const interceptor = new PassInterceptor(defenders, defPMs, bm, {
        exclude: attackers,
        onControl: (p) => {
            if (complete || phase !== PHASE.PASSING) return;
            if (defenders.includes(p)) finish('defend');
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
    let passWatchdog = 0;
    let currentContest = null;
    // 캐리어가 바뀌면 무볼 mates 순서도 바뀌므로 역할 기록은 선수 기준으로 유지
    const prevAttRoles = new Map(); // player → OFFBALL_ROLE
    let prevDefRoles = null;        // defenders 순서와 같은 이전 수비 역할
    let lastRoleKey = null;         // 수비 역할 변경 감지 (검증 이벤트용)
    let lastAttRoleKey = null;      // 공격 역할 변경 감지 (검증 이벤트용)

    function finish(result = null) {
        if (complete) return;
        complete = true;
        dcs.forEach(dc => dc.stop());
        receptions.forEach(r => r.stop());
        interceptor.stop();
        if (currentContest) currentContest.stop();
        pms.forEach(pm => pm.stop()); defPMs.forEach(pm => pm.stop());
        if (onComplete) onComplete(result);
    }

    // 소유자 교체 — 드리블 상한·두뇌 상태만 갱신
    // (이미 소유 중이면 possess·snap 생략 — 수신 트랩 위치를 덮어쓰지 않는다)
    function setCarrier(next) {
        const already = bm.owner === attackers[next];
        if (carrierIdx === next && already) {
            // 공방에서 소유를 지킨 채 복귀한 경우 드리블이 정지돼 있다 — 재개한다.
            // (재개하지 않으면 ballAttached=false 고착 → no-touch limbo:
            //  볼은 멈추고 공격수는 골대 앞으로만 간다)
            dcs[next].start();
            return;
        }
        dcs.forEach(dc => dc.stop());
        carrierIdx = next;
        if (!already) {
            bm.possess(attackers[next], POSSESS_OFFSET);
            bm.snapToFront();
        }
        dcs[next].start();
        decisions.forEach(d => d.reset());
        prevAttRoles.clear();
        shooting = false;
    }

    function mateEntries(excludeIdx) {
        return attackers
            .map((p, i) => ({ player: p, idx: i }))
            .filter(e => e.idx !== excludeIdx);
    }

    function storeAttRoles(intents, mates) {
        intents.forEach((it, k) => prevAttRoles.set(mates[k].player, it.role));
    }

    // 패스 실행 — PassDecision 계열 표준 조립 (2v1 executePass와 동일 패턴)
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
            nearestOpp: PassAccuracy.nearestOpponent(carrier, defenders),
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

    function startLoose(tackler, tacklerIdx, victimIdx) {
        dcs.forEach(dc => dc.stop());
        pms.forEach(pm => pm.stop()); defPMs.forEach(pm => pm.stop());
        currentContest = new PossessionContest(
            attackers[victimIdx], pms[victimIdx], tackler, defPMs[tacklerIdx], bm, {
                pokeSpeed: 220, catchDistance: 16, stealChance: 0.3,
            });
        currentContest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                currentContest = null;
                if (defenders.includes(winner)) { finish('defend'); return; }
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
            defenders,
        });
        if (!res.fired) return false;
        if (res.plan.onTarget) gkc.watchShot(res.trajectory);
        else gkc.reset();
        phase = PHASE.SHOOT;
        shooting = true;
        if (events && events.onShot) events.onShot();
        return true;
    }

    function separateAll() {
        const all = [...attackers, ...defenders];
        for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
                BodyCollision.separate(all[i], all[j]);
            }
        }
    }

    // 수비 실행 — 역할·목표는 DefensiveDecision이 산출, 실행만 moveTo.
    // (누가 press/lane-block인지는 위치로 정해지므로 고정이 없다)
    function updateDefense() {
        const intents = defense.evaluate({
            ball,
            attackers,
            holderIdx: phase === PHASE.PASSING ? passMateIdx : carrierIdx,
            defenders,
            prevRoles: prevDefRoles,
        });
        prevDefRoles = intents.map(it => it.role);
        intents.forEach((it) => {
            defPMs[it.idx].speed = it.speed;
            defPMs[it.idx].moveTo(it.targetX, it.targetY);
            defPMs[it.idx].update(dtNow);
        });

        // 역할 변경 검증 이벤트 — 분담이 실제로 일어나는지 외부 관찰용
        const roleKey = intents.map(it => it.role).join(',');
        if (roleKey !== lastRoleKey) {
            lastRoleKey = roleKey;
            if (events && events.onRoles) {
                events.onRoles(intents.map(it => ({
                    number: defenders[it.idx].number,
                    role: it.role,
                })));
            }
        }
        return intents;
    }

    // 공격 무볼 실행 — 역할·목표는 OffBallDecision이 산출, 실행만 moveTo
    function updateOffBall(carrierRef, mates) {
        const intents = offBall.evaluate({
            carrier: carrierRef,
            mates,
            opponents: defenders,
            clock,
            prevRoles: mates.map(m => prevAttRoles.get(m.player) ?? null),
        });
        storeAttRoles(intents, mates);
        intents.forEach((it, k) => {
            pms[mates[k].idx].speed = it.speed;
            pms[mates[k].idx].moveTo(it.targetX, it.targetY);
        });

        // 공격 역할 변경 검증 이벤트 — 폭 유지 등이 실제로 일어나는지 외부 관찰용
        const roleKey = mates
            .map(m => `${m.idx}:${prevAttRoles.get(m.player)}`)
            .sort()
            .join(',');
        if (roleKey !== lastAttRoleKey) {
            lastAttRoleKey = roleKey;
            if (events && events.onAttackRoles) {
                events.onAttackRoles(mates.map(m => ({
                    number: m.player.number,
                    role: prevAttRoles.get(m.player),
                })));
            }
        }
        return intents;
    }

    let dtNow = 0;
    let passMateIdx = -1;

    bm.possess(attackers[0], POSSESS_OFFSET);
    bm.snapToFront();
    dcs[0].start();

    function tick(dt) {
        if (complete) return;
        clock += dt;
        dtNow = dt;
        tackle.update(dt); // 태클 쿨다운은 국면과 무관하게 항상 흐른다

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
            separateAll();
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                finish('out'); return;
            }
            return;
        }

        // ── 패스 비행: 볼 물리 + 수신(BallReception) + 가로채기(PassInterceptor) ──
        if (phase === PHASE.PASSING) {
            const mateIdx = passMateIdx;
            bm.update(dt);
            receptions[mateIdx].update(dt);
            // BallReception/패스후이동은 목표만 지정하므로 여기서 적분한다
            pms[carrierIdx].update(dt);
            pms[mateIdx].update(dt);
            // 세 번째 공격수도 모듈 판단으로 계속 이동한다 (정지 금지)
            const third = [0, 1, 2].find(i => i !== carrierIdx && i !== mateIdx);
            if (third !== undefined) {
                updateOffBall(attackers[mateIdx], [{ player: attackers[third], idx: third }]);
                pms[third].update(dt);
            }
            interceptor.update(dt);
            // 수비수는 비행 중에도 모듈 판단으로 대응한다
            updateDefense();
            separateAll();
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
                let best = 0, bd = Infinity;
                attackers.forEach((a, i) => {
                    const d = Math.hypot(a.x - ball.x, a.y - ball.y);
                    if (d < bd) { bd = d; best = i; }
                });
                setCarrier(best);
                phase = PHASE.DUEL;
            }
            return;
        }

        // ── 듀얼: 소유/지원/수비 두뇌 + 선택 중재 ──
        const c = carrierIdx;
        const carrier = attackers[c];
        const carrierPM = pms[c];
        const mates = mateEntries(c);

        carrierPM.update(dt);
        dcs[c].update(dt, { defenders });
        bm.update(dt);

        // 캐리어 이동 (방법은 DribbleDecision이 수비수를 보고 결정)
        decisions[c].update(dt, {
            carrier, movement: carrierPM,
            attackGoalX: GOAL_X,
            defenders,
            ballAttached: dcs[c].ballAttached,
        });

        // 무볼 이동 (역할·목표는 OffBallDecision이 산출, 실행만 moveTo)
        updateOffBall(carrier, mates);
        mates.forEach(m => pms[m.idx].update(dt));

        // 수비 (역할·목표는 DefensiveDecision이 산출, 실행만 moveTo)
        const defIntents = updateDefense();

        separateAll();

        // 태클 성립 — PRESS 역할의 태클 커밋 + 접촉일 때만.
        // 커밋 타이밍은 TackleDecision이 소유한다. 누가 PRESS인지는 모듈이 정한다.
        const press = defIntents.find(it => it.role === DEFENSE_ROLE.PRESS);
        if (press && bm.owner === carrier) {
            const presser = defenders[press.idx];
            if (tackle.decide(presser, ball, dcs[c].ballAttached)
                && CollisionSystem.isTackle(presser, ball)) {
                startLoose(presser, press.idx, c);
                return;
            }
        }

        if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
            finish('out'); return;
        }

        // 선택 중재 — 슛 > 패스 > 드리블 (확정 우선순위, 난수 없음)
        const assess = assessment.assess({
            carrier, mates: mates.map(m => ({ player: m.player, idx: m.idx })),
            opponents: defenders, ball, dir: 1, attackGoalX: GOAL_X,
        });
        const shotEval = shotDecision.evaluate({
            shooter: carrier, ball, attackGoalX: GOAL_X, dir: 1,
            defenders, keeper: goalkeeper,
            ballAttached: dcs[c].ballAttached,
        });
        const selected = choice.choose({
            assessment: assess, shotEval, ballAttached: dcs[c].ballAttached,
            owner: carrier, dt,
        });
        if (events && events.onChoice) events.onChoice(selected);
        if (selected.action === ATTACK_ACTION.PASS
            && mates.some(m => m.idx === selected.mateIdx)) {
            passMateIdx = selected.mateIdx;
            executePass(passMateIdx);
        } else if (selected.action === ATTACK_ACTION.SHOOT && !shooting) {
            shooting = fireShot(shotEval);
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        dcs.forEach(dc => dc.stop());
        receptions.forEach(r => r.stop());
        interceptor.stop();
        if (currentContest) currentContest.stop();
        pms.forEach(pm => pm.stop()); defPMs.forEach(pm => pm.stop());
    };
}
