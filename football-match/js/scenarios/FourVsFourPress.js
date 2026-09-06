/**
 * FourVsFourPress - 4:4 압박·탈압박 검증 메뉴
 *
 * 프레싱 트랩에서 탈출하는 드릴이다. 홈(빨강) 캐리어는 2명의 프레서에게
 * 둘러싸인 채 시작하고, 탈압박에 성공하면 카운트, 탈취당하면 함정을
 * 다시 차리고 재시도한다. 정해진 연출 없음 — 모든 행동은 공통 모듈 판단이다.
 *
 * 검증 대상:
 *   공격: 압박 회피·패스·원터치·방향 전환·공간 이동·지원(아울렛)·탈출
 *   수비: 압박·커버·레인 차단·강도 조절·무리한 돌진 방지 (PRESS 1명 구조)
 *
 * 역할 분담 (중복 구현 금지):
 *   - 캐리어 이동     = DribbleDecision (BEAT/SHIELD/FEINT 탈압박)
 *   - 패스/드리블 선택 = OverloadAssessment + AttackChoice (무조건 패스 금지)
 *   - 지원 이동       = OffBallDecision (아울렛 모드 — 압박 시 짧게 내려옴)
 *   - 원터치          = NonStopPass (수신 직후 압박 시 즉시 연결)
 *   - 패스 실행       = PassIntent + PassAccuracy + PassMovement
 *   - 수비 4명        = CooperativeDefenseAI (PRESS 1명 + 레인·마크·커버)
 *   - 탈취·공방       = PassInterceptor + PossessionContest + CollisionSystem
 *
 * 종료: 탈출 3회 ('complete') / 라인 아웃 (리셋, 미집계) / 150초 (완료).
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { DribbleDecision }   from '../movement/DribbleDecision.js';
import { BallReception }     from '../movement/BallReception.js';
import { PassIntent }        from '../movement/PassIntent.js';
import { PassAccuracy }      from '../movement/PassAccuracy.js';
import { PassDecision }      from '../movement/PassDecision.js';
import { PassMovement }      from '../movement/PassMovement.js';
import { NonStopPass }       from '../movement/NonStopPass.js';
import { OffBallDecision }   from '../movement/OffBallDecision.js';
import { OverloadAssessment } from '../movement/OverloadAssessment.js';
import { AttackChoice, ATTACK_ACTION } from '../movement/AttackChoice.js';
import { CooperativeDefenseAI } from '../movement/CooperativeDefenseAI.js';
import { PassInterceptor }   from '../movement/PassInterceptor.js';
import { PossessionContest } from '../movement/PossessionContest.js';
import { CollisionSystem }   from '../movement/CollisionSystem.js';
import { BodyCollision }     from '../movement/BodyCollision.js';
import { angleTo } from '../movement/Direction.js';
import {
    CENTER_Y, GOAL_X, Y_MIN, Y_MAX,
    FIELD_MIN_X, FIELD_BOTTOM,
} from '../movement/FieldGeometry.js';

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const SPEEDS = PlayerMovement.SPEEDS;
const PASS_WATCHDOG = 4.0;
const DRILL_TIME = 150;
const ESCAPES_NEEDED = 3;
const PRESS_LINE = 520;      // 이 라인을 넘어 점유를 유지하면 탈출 성공
const TRAP_COOLDOWN = 1.0;   // 함정 세팅 후 유예 — 즉시 접촉 태클 방지
const OUTLET_TRIGGER = 70;   // 이보다 가까이 압박받으면 아울렛 지원
const OUTLET_DIST = 60;

// 프레싱 트랩 배치 — 캐리어를 2명이 에워싸고 시작한다 (연출이 아닌 초기 조건)
// 즉시 접촉이 아니라 압박이 임박한 거리에서 시작한다 (첫 탈출 판단 여유 확보)
function trapSpots() {
    return {
        home: [
            { x: 350, y: 340 }, // 캐리어
            { x: 250, y: 220 }, { x: 250, y: 460 },
            // 전방 아울렛 — 함정 시작부터 유효한 탈출구 (지원 요청 위치 선정 검증)
            { x: 425, y: 340 },
        ],
        away: [
            { x: 480, y: 290 }, { x: 480, y: 390 }, // 프레서 2명 (다가오는 압박)
            { x: 620, y: 250 }, { x: 620, y: 430 }, // 커버 2명
        ],
    };
}

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function run(layer, loop, onComplete = null, events = null) {
    const spots = trapSpots();
    const home = spots.home.map((s, i) => new Player({
        x: s.x, y: s.y, team: 'home', number: 7 + i, angle: -90,
    }).render(layer));
    const away = spots.away.map((s, i) => new Player({
        x: s.x, y: s.y, team: 'away', number: 4 + i, angle: 90,
    }).render(layer));
    const ball = new Ball(home[0].x, home[0].y).render(layer);

    const homePM = home.map(p => new PlayerMovement(p, { driftScale: 0 }));
    const awayPM = away.map(p => new PlayerMovement(p, { driftScale: 0 }));
    const bm = new BallMovement(ball);
    const homeDC = homePM.map(pm => new DribbleController(pm, bm));
    const homeRec = home.map((p, i) => new BallReception(p, homePM[i], bm));
    const homeDec = home.map(() => new DribbleDecision({
        dir: 1, centerY: CENTER_Y,
        yMin: Y_MIN, yMax: Y_MAX,
        fieldMinX: FIELD_MIN_X, fieldMaxX: GOAL_X - 25,
        shootRange: 185,
    }));

    // 지원 판단 — 아울렛 모드 (압박 시 짧게 내려옴, 기본 꺼짐 → 명시 활성화)
    const offBall = new OffBallDecision({
        dir: 1, attackGoalX: GOAL_X,
        outletTrigger: OUTLET_TRIGGER, outletDist: OUTLET_DIST,
    });
    const assessment = new OverloadAssessment({ dir: 1 });
    // 빠른 순환 + 타이트 레인 허용 (포제션 메뉴와 동일 근거).
    // 후방 리사이클 허용 — 트랩에 갇혔을 때 뒤로 빼서 살리는 것이 정석이므로
    // 전방 패스 강제(wait-support)를 풀어준다. 빠져나간 뒤에는 전방 규칙 복귀.
    const choice = new AttackChoice({ minHoldTime: 0.3, passLaneMin: 20, passMinGain: -120 });
    const passDecision = new PassDecision();
    const passIntent = new PassIntent();
    const passAccuracy = new PassAccuracy();
    const nonStop = new NonStopPass();

    // 수비 — HIGH 강도 프레싱 (자키 간격 좁힘 + 빠른 리타겟).
    // 역할은 1명 PRESS + 레인·마크·커버로 자동 분담 (전원 돌진 방지).
    const defense = new CooperativeDefenseAI(
        away.map((p, i) => ({ player: p, movement: awayPM[i] })),
        {
            assignmentInterval: 0.25,
            retargetInterval: 0.1,
            pressHolder: true,
            jockeyGap: 22,
        },
    );
    const interceptor = new PassInterceptor(away, awayPM, bm, {
        onControl: (p) => {
            if (complete || phase !== PHASE.POSSESS && phase !== PHASE.PASSING) return;
            if (away.indexOf(p) < 0) return;
            turnover('intercept');
        },
    });

    const PHASE = { POSSESS: 'possess', PASSING: 'passing', LOOSE: 'loose' };
    let phase = PHASE.POSSESS;
    let complete = false;
    let carrierIdx = 0;
    let clock = 0;
    let prevRoles = null;
    let passWatchdog = 0;
    let arrivedByPass = false;
    let tackleCooldown = TRAP_COOLDOWN;
    let currentContest = null;
    let escapes = 0;
    let turnovers = 0;
    let passes = 0;

    function finish(result = null) {
        if (complete) return;
        complete = true;
        homeDC.forEach(d => d.stop());
        homeRec.forEach(r => r.stop());
        homePM.forEach(m => m.stop());
        awayPM.forEach(m => m.stop());
        defense.stop(); interceptor.stop();
        if (currentContest) currentContest.stop();
        if (onComplete) onComplete(result);
    }

    function setCarrier(next, alreadyOwned) {
        homeDC.forEach(d => d.stop());
        homeRec.forEach(r => r.stop());
        interceptor.exclude = null;
        carrierIdx = next;
        const carrier = home[next];
        if (!alreadyOwned) {
            bm.possess(carrier, POSSESS_OFFSET);
            bm.snapToFront();
        }
        homeDC[next].start();
        homeDec.forEach(d => d.reset());
        choice.reset();
        prevRoles = null;
        tackleCooldown = TRAP_COOLDOWN;
        phase = PHASE.POSSESS;
    }

    // 함정 리셋 — 초기 배치로 복귀 (탈출 카운트 유지)
    function respot() {
        const s = trapSpots();
        home.forEach((p, i) => { p.setPosition(s.home[i].x, s.home[i].y); p.setAngle(-90); });
        away.forEach((p, i) => { p.setPosition(s.away[i].x, s.away[i].y); p.setAngle(90); });
        homeDC.forEach(d => d.stop());
        homeRec.forEach(r => r.stop());
        homePM.forEach(m => m.stop());
        awayPM.forEach(m => m.stop());
        defense.start();
        interceptor.exclude = null;
        currentContest = null;
        arrivedByPass = false;
        setCarrier(0, false);
    }

    function escape(how) {
        escapes++;
        if (events && events.onEscape) events.onEscape({ how, escapes });
        if (escapes >= ESCAPES_NEEDED) { finish('complete'); return; }
        respot();
    }

    function turnover(how) {
        turnovers++;
        if (events && events.onTurnover) events.onTurnover({ how, turnovers });
        respot();
    }

    // 패스 실행 — PassIntent + PassAccuracy + PassMovement 표준 조립
    function executePass(mateIdx) {
        const carrier = home[carrierIdx];
        const mate = home[mateIdx];
        const carrierPM = homePM[carrierIdx];
        const matePM = homePM[mateIdx];
        homeDC[carrierIdx].stop();

        const intent = passIntent.plan({
            ball, receiver: mate,
            receiverVel: matePM.getVelocity(),
            kind: 'auto',
        });
        const aimX = clamp(intent.aimX, FIELD_MIN_X, GOAL_X - 25);
        const aimY = clamp(intent.aimY, Y_MIN + 10, Y_MAX - 10);
        const acc = passAccuracy.evaluate({
            dist: Math.hypot(mate.x - carrier.x, mate.y - carrier.y),
            nearestOpp: PassAccuracy.nearestOpponent(carrier, away),
            moving: carrierPM.moving,
        });

        carrierPM.clearFacingTarget();
        carrierPM.setFacingTarget(angleTo(carrier.x, carrier.y, aimX, aimY));
        if (intent.kind === 'long') {
            PassMovement.longPass(bm, aimX, aimY, {
                flightDuration: Math.max(0.75, Math.hypot(aimX - ball.x, aimY - ball.y) / 350),
                maxHeight: 0.9 + Math.random() * 0.2,
                deviationRad: acc.deviationRad,
                bounce: { duration: 0.35, maxHeight: 0.28, velocityScale: 0.48 },
                onLand: () => receivePass(mateIdx),
            });
        } else {
            PassMovement.shortPass(bm, aimX, aimY, {
                arriveSpeed: rand(110, 140),
                deviationRad: acc.deviationRad,
            });
        }

        // 패스 후 이동 — 전방 런 (탈압박 시야 확보)
        carrierPM.speed = SPEEDS[2];
        carrierPM.moveTo(
            clamp(carrier.x + rand(40, 70), FIELD_MIN_X, GOAL_X - 40),
            clamp(carrier.y + (Math.random() < 0.5 ? -50 : 50), Y_MIN + 15, Y_MAX - 15),
        );

        homeRec[mateIdx].start({ runTargetX: aimX, runTargetY: aimY });
        interceptor.exclude = mate;
        passWatchdog = PASS_WATCHDOG;
        phase = PHASE.PASSING;
        passes++;
        if (events && events.onPass) events.onPass({ from: carrierIdx, to: mateIdx });
    }

    function receivePass(mateIdx) {
        if (complete || phase !== PHASE.PASSING) return;
        interceptor.exclude = null;
        arrivedByPass = true;
        setCarrier(mateIdx, false);

        // 원터치 — 수신 직후 압박받으면 즉시 연결한다 (공통 모듈)
        const res = passDecision.evaluate({
            passer: home[mateIdx],
            candidates: home
                .map((p, i) => ({ player: p, idx: i }))
                .filter(m => m.idx !== mateIdx),
            opponents: away,
            dir: 1, attackGoalX: GOAL_X,
        });
        if (res.ok) {
            const done = nonStop.tryPass({
                receiver: home[mateIdx],
                target: res.player,
                movement: homePM[mateIdx],
                defenders: away,
                onPass: () => executePass(res.idx),
            });
            if (done && events && events.onOneTouch) events.onOneTouch({ by: mateIdx });
        }
    }

    function startLoose(tackler) {
        homeDC.forEach(d => d.stop());
        homePM.forEach(m => m.stop());
        awayPM.forEach(m => m.stop());
        const pmB = awayPM[away.indexOf(tackler)];
        currentContest = new PossessionContest(
            home[carrierIdx], homePM[carrierIdx], tackler, pmB, bm, {
                pokeSpeed: 200, catchDistance: 16, stealChance: 0.3,
            });
        phase = PHASE.LOOSE;
        currentContest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                currentContest = null;
                if (winner.team === 'away') { turnover('contest'); return; }
                // 소유 유지 — 드리블 재개 (no-touch limbo 방지)
                setCarrier(home.indexOf(winner), true);
            },
        });
    }

    // ── 시작 ──
    bm.possess(home[carrierIdx], POSSESS_OFFSET);
    bm.snapToFront();
    homeDC[carrierIdx].start();
    defense.start();
    interceptor.start();

    function tick(dt) {
        if (complete) return;
        clock += dt;
        if (tackleCooldown > 0) tackleCooldown -= dt;
        if (clock > DRILL_TIME) { finish('complete'); return; }

        const carrier = home[carrierIdx];

        // ── 루즈볼 공방 ──
        if (phase === PHASE.LOOSE) {
            if (currentContest) currentContest.update(dt);
            for (const p of home) for (const q of away) BodyCollision.separate(p, q);
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                respot(); return;
            }
            return;
        }

        // ── 패스 비행 ──
        if (phase === PHASE.PASSING) {
            bm.update(dt);
            homeRec.forEach((r, i) => {
                if (i === carrierIdx) return;
                r.update(dt);
                homePM[i].update(dt);
            });
            homePM[carrierIdx].update(dt);
            interceptor.update(dt);
            defense.update(dt, {
                ball,
                ballVelocity: { x: bm.vx, y: bm.vy },
                attackers: home,
                attackerMovements: homePM,
                holder: null,
                receiver: home[carrierIdx],
                inFlight: bm.owner === null,
            });
            for (const p of home) for (const q of away) BodyCollision.separate(p, q);
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                respot(); return;
            }
            for (let i = 0; i < homeRec.length; i++) {
                if (i !== carrierIdx && homeRec[i].received) {
                    receivePass(i);
                    return;
                }
            }
            passWatchdog -= dt;
            if (passWatchdog <= 0) {
                interceptor.exclude = null;
                let best = -1, bd = Infinity;
                home.forEach((p, i) => {
                    const d = Math.hypot(p.x - ball.x, p.y - ball.y);
                    if (d < bd) { bd = d; best = i; }
                });
                if (best >= 0) setCarrier(best, false);
            }
            return;
        }

        // ── 보유: 캐리어 두뇌 + 지원 + 수비 ──
        const carrierPM = homePM[carrierIdx];
        carrierPM.update(dt);
        homeDC[carrierIdx].update(dt, { defenders: away, clock });
        bm.update(dt);

        homeDec[carrierIdx].update(dt, {
            carrier, movement: carrierPM,
            attackGoalX: GOAL_X,
            defenders: away,
            ballAttached: homeDC[carrierIdx].ballAttached,
        });

        // 지원 이동 (아울렛 포함 — 역할·목표는 모듈 산출, 실행만 moveTo)
        const mates = home
            .map((p, i) => ({ player: p, idx: i }))
            .filter(m => m.idx !== carrierIdx);
        const intents = offBall.evaluate({
            carrier, mates, opponents: away, clock, prevRoles,
        });
        prevRoles = intents.map(it => it.role);
        for (const it of intents) {
            const pm = homePM[it.idx];
            pm.speed = it.speed;
            pm.clearFacingTarget();
            pm.moveTo(it.targetX, it.targetY);
            pm.update(dt);
        }

        // 수비 (PRESS 1명 + 레인·마크·커버 — 전원 돌진 없음)
        defense.update(dt, {
            ball,
            ballVelocity: { x: bm.vx, y: bm.vy },
            attackers: home,
            attackerMovements: homePM,
            holder: carrier,
            inFlight: false,
        });

        for (const p of home) for (const q of away) BodyCollision.separate(p, q);

        // 태클 성립 — 쿨다운 경과 후
        if (bm.owner === carrier && tackleCooldown <= 0) {
            for (const o of away) {
                if (CollisionSystem.isTackle(o, ball)) {
                    startLoose(o);
                    return;
                }
            }
        }

        if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
            respot(); return;
        }

        // 탈출 판정 — 프레스 라인을 넘어 점유 유지
        if (bm.owner === carrier && ball.x > PRESS_LINE) {
            escape(arrivedByPass ? 'pass' : 'carry');
            return;
        }

        // 선택 중재 — 무조건 패스 금지 (드리블·방향 전환 탈압박 포함)
        const assess = assessment.assess({
            carrier,
            mates: mates.map(m => ({ player: m.player, idx: m.idx })),
            opponents: away, ball, dir: 1, attackGoalX: GOAL_X,
        });
        const selected = choice.choose({
            assessment: assess,
            shotEval: { shoot: false, forced: false, quality: 0 },
            ballAttached: homeDC[carrierIdx].ballAttached,
            owner: carrier, dt,
        });
        if (events && events.onChoice) events.onChoice(selected);
        if (selected.action === ATTACK_ACTION.PASS && selected.mateIdx >= 0
            && home[selected.mateIdx]) {
            executePass(selected.mateIdx);
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        homeDC.forEach(d => d.stop());
        homeRec.forEach(r => r.stop());
        homePM.forEach(m => m.stop());
        awayPM.forEach(m => m.stop());
        defense.stop(); interceptor.stop();
        if (currentContest) currentContest.stop();
    };
}
