/**
 * FourVsFourPossession - 4:4 포제션 검증 메뉴
 *
 * TeamTacticalLayer의 최초 소비자다. 4v4 양 팀이 볼 순환을 유지하면서
 * 공간(폭·깊이·삼각형·지원 거리)을 만드는지 검증한다.
 *
 * 검증 대상: 폭·깊이·지원 거리·삼각형·패스 옵션·패스 후 이동·공간 이동·
 *   탈압박·볼 순환·수비 압박·수비 블록.
 *
 * 역할 분담 (중복 구현 금지 — 시나리오는 소유권·국면·종료만 담당):
 *   - 오프볼·수비·전환·형태  = TeamTacticalLayer (양 팀, N-범용)
 *   - 캐리어 이동            = DribbleDecision (팀 방향별 인스턴스)
 *   - 패스/드리블 선택       = OverloadAssessment + AttackChoice (슛 제외)
 *   - 패스 실행              = PassIntent + PassAccuracy + PassMovement
 *   - 수신                   = BallReception / 패스 후 이동 = TeamSupport.passAndGo
 *   - 탈취·공방              = PassInterceptor + PossessionContest + CollisionSystem
 *
 * 소유권이 바뀌면 역할이 그대로 뒤집힌다 (양 팀 동일 조립 — 11v11 구조).
 * 슛·GK 없음. 아웃·시간 제한은 드릴 리셋/종료로 처리한다.
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
import { PassMovement }      from '../movement/PassMovement.js';
import { PassInterceptor }   from '../movement/PassInterceptor.js';
import { PossessionContest } from '../movement/PossessionContest.js';
import { CollisionSystem }   from '../movement/CollisionSystem.js';
import { BodyCollision }     from '../movement/BodyCollision.js';
import { OverloadAssessment } from '../movement/OverloadAssessment.js';
import { AttackChoice, ATTACK_ACTION } from '../movement/AttackChoice.js';
import { TeamSupport }       from '../movement/TeamSupport.js';
import { TeamTacticalLayer } from '../movement/TeamTacticalLayer.js';
import { angleTo } from '../movement/Direction.js';
import {
    CENTER_Y, GOAL_X, Y_MIN, Y_MAX,
    FIELD_MIN_X, FIELD_BOTTOM, FIELD_HEIGHT,
} from '../movement/FieldGeometry.js';

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const PASS_WATCHDOG = 4.0; // 패스 비행 해소 제한 — 초과 시 가장 가까운 동료가 소유
const DRILL_TIME = 150;    // 드릴 제한 시간 (초) — 초과 시 완료
const PASS_EVENT_TTL = 1.2; // 패스 후 이동 지시 유효 시간 (초)

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// 초기 배치 — 폭·깊이를 가진 2-2 형태 (원정은 거울)
function homeSpots() {
    return [
        { x: 300, y: 240 }, { x: 300, y: 440 },
        { x: 460, y: 200 }, { x: 460, y: 480 },
    ];
}
function awaySpots() {
    return homeSpots().map(s => ({ x: GOAL_X - s.x, y: FIELD_HEIGHT - s.y }));
}

export function run(layer, loop, onComplete = null, events = null) {
    const home = homeSpots().map((s, i) => new Player({
        x: s.x, y: s.y, team: 'home', number: 7 + i, angle: -90,
    }).render(layer));
    const away = awaySpots().map((s, i) => new Player({
        x: s.x, y: s.y, team: 'away', number: 4 + i, angle: 90,
    }).render(layer));
    const ball = new Ball(home[2].x, home[2].y).render(layer);
    const bm = new BallMovement(ball);

    function makeSide(players, dir, attackGoalX, ownGoalX) {
        const movements = players.map(p => new PlayerMovement(p, { driftScale: 0 }));
        return {
            players, movements,
            dir, attackGoalX, ownGoalX,
            dribbles: movements.map(mv => new DribbleController(mv, bm)),
            receptions: players.map((p, i) => new BallReception(p, movements[i], bm)),
            decisions: players.map(() => new DribbleDecision({
                dir, centerY: CENTER_Y,
                yMin: Y_MIN, yMax: Y_MAX,
                fieldMinX: FIELD_MIN_X, fieldMaxX: GOAL_X - 25,
                shootRange: 185,
            })),
            assessment: new OverloadAssessment({ dir }),
            // 포제션 드릴은 빠른 순환이 목적 — 홀드 1.0s(핑퐁 방지 기본값) 대신
            // 짧게 가져간다. 핑퐁은 태클 쿨다운+공방 스턴이 이미 막는다.
            // 타이트한 레인도 통과시킨다 — 수신(BallReception)이 감당하고,
            // 무리한 패스는 인터셉터가 honest하게 처벌한다.
            choice: new AttackChoice({ minHoldTime: 0.45, passLaneMin: 20 }),
            support: new TeamSupport({ dir }),
        };
    }

    const sides = {
        home: makeSide(home, 1, GOAL_X, 0),
        away: makeSide(away, -1, 0, GOAL_X),
    };

    // 양 팀 전술 레이어 — 오프볼·수비·전환 소유 (캐리어는 건드리지 않음)
    const layers = {
        home: new TeamTacticalLayer({
            players: home, movements: sides.home.movements, opponents: away,
            myKey: 'A', dir: 1, attackGoalX: GOAL_X, ownGoalX: 0,
        }),
        away: new TeamTacticalLayer({
            players: away, movements: sides.away.movements, opponents: home,
            myKey: 'B', dir: -1, attackGoalX: 0, ownGoalX: GOAL_X,
        }),
    };

    const passIntent = new PassIntent();
    const passAccuracy = new PassAccuracy();

    const allPlayers = [...home, ...away];
    const allMovements = [...sides.home.movements, ...sides.away.movements];
    const interceptor = new PassInterceptor(allPlayers, allMovements, bm, {
        onControl: (p) => {
            if (complete || phase !== PHASE.PASSING) return;
            const team = p.team === 'home' ? sides.home : sides.away;
            const idx = team.players.indexOf(p);
            if (idx < 0) return;
            // 팀이 바뀔 때만 턴오버 (같은 팀 회수는 흐름 유지)
            if (p.team !== posKey) {
                turnovers++;
                if (events && events.onTurnover) events.onTurnover({ by: p.team, idx, how: 'intercept' });
            }
            setPossession(p.team, idx, true);
        },
    });

    const PHASE = { POSSESS: 'possess', PASSING: 'passing', LOOSE: 'loose' };
    let phase = PHASE.POSSESS;
    let complete = false;
    let posKey = 'home';
    let carrierIdx = 2;
    let clock = 0;
    let passWatchdog = 0;
    let passEvent = null; // { passer, receiver, ttl } — 레이어에 전달
    let passReceiverIdx = -1; // 비행 중 수신자 (레이어 소유자 제외용)
    let lastTouchKey = 'home';
    let currentContest = null;
    let passes = 0;
    let turnovers = 0;
    // 소유 전환 직후 태클 금지 — 재압박 ping-pong 방지 (2v2·3v3 동일 패턴)
    let tackleCooldown = 0.8;

    const posSide = () => sides[posKey];
    const oppSide = () => sides[posKey === 'home' ? 'away' : 'home'];
    const oppKey = () => (posKey === 'home' ? 'away' : 'home');

    function finish(result = null) {
        if (complete) return;
        complete = true;
        for (const key of ['home', 'away']) {
            sides[key].dribbles.forEach(d => d.stop());
            sides[key].receptions.forEach(r => r.stop());
            sides[key].movements.forEach(m => m.stop());
        }
        interceptor.stop();
        if (currentContest) currentContest.stop();
        if (onComplete) onComplete(result);
    }

    // 소유권 교체 — 드리블 재개·판단 리셋만 수행 (위치 스냅 없음)
    function setPossession(teamKey, idx, alreadyOwned) {
        for (const key of ['home', 'away']) {
            sides[key].dribbles.forEach(d => d.stop());
            sides[key].receptions.forEach(r => r.stop());
        }
        interceptor.exclude = null;
        posKey = teamKey;
        carrierIdx = idx;
        const side = sides[teamKey];
        if (!alreadyOwned) {
            bm.possess(side.players[idx], POSSESS_OFFSET);
            bm.snapToFront();
        }
        side.dribbles[idx].start();
        side.decisions.forEach(d => d.reset());
        side.choice.reset();
        passEvent = null;
        passReceiverIdx = -1;
        tackleCooldown = 0.8;
        phase = PHASE.POSSESS;
    }

    // 패스 실행 — PassIntent + PassAccuracy + PassMovement 표준 조립
    function executePass(mateIdx) {
        const side = posSide();
        const carrier = side.players[carrierIdx];
        const mate = side.players[mateIdx];
        const carrierPM = side.movements[carrierIdx];
        const matePM = side.movements[mateIdx];
        side.dribbles[carrierIdx].stop();

        const intent = passIntent.plan({
            ball, receiver: mate,
            receiverVel: matePM.getVelocity(),
            kind: 'auto',
        });
        const aimX = clamp(intent.aimX, FIELD_MIN_X, GOAL_X - 25);
        const aimY = clamp(intent.aimY, Y_MIN + 10, Y_MAX - 10);
        const acc = passAccuracy.evaluate({
            dist: Math.hypot(mate.x - carrier.x, mate.y - carrier.y),
            nearestOpp: PassAccuracy.nearestOpponent(carrier, oppSide().players),
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
        lastTouchKey = posKey;

        // 패스 후 이동은 레이어가 passEvent로 수행한다 (이중 구동 방지).
        // 여기서 목표를 잡으면 레이어 리타겟과 충돌하므로 킥 자세만 잡는다.
        passEvent = { passer: carrier, receiver: mate, ttl: PASS_EVENT_TTL };

        side.receptions[mateIdx].start({ runTargetX: aimX, runTargetY: aimY });
        interceptor.exclude = mate;
        passReceiverIdx = mateIdx;
        passWatchdog = PASS_WATCHDOG;
        phase = PHASE.PASSING;
        passes++;
        if (events && events.onPass) events.onPass({ team: posKey, from: carrierIdx, to: mateIdx });
    }

    function receivePass(mateIdx) {
        if (complete || phase !== PHASE.PASSING) return;
        interceptor.exclude = null;
        lastTouchKey = posKey;
        setPossession(posKey, mateIdx, false);
    }

    function startLoose(tackler) {
        const side = posSide();
        const prevOwner = side.players[carrierIdx];
        const opp = oppSide();
        const tackKey = oppKey();
        side.dribbles.forEach(d => d.stop());
        opp.dribbles.forEach(d => d.stop());
        side.movements.forEach(m => m.stop());
        opp.movements.forEach(m => m.stop());
        const pmA = side.movements[carrierIdx];
        const pmB = opp.movements[opp.players.indexOf(tackler)];
        currentContest = new PossessionContest(prevOwner, pmA, tackler, pmB, bm, {
            // 포제션 드릴: 즉각 스틸보다 루즈볼 경합을 살린다 (기본 0.45)
            pokeSpeed: 200, catchDistance: 16, stealChance: 0.25,
        });
        phase = PHASE.LOOSE;
        currentContest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                currentContest = null;
                const winnerKey = winner.team === 'home' ? 'home' : 'away';
                const idx = sides[winnerKey].players.indexOf(winner);
                if (winnerKey !== posKey) {
                    turnovers++;
                    if (events && events.onTurnover) events.onTurnover({ by: winnerKey, idx, how: 'contest' });
                }
                lastTouchKey = winnerKey;
                setPossession(winnerKey, idx, true);
            },
        });
    }

    // 드릴 리셋 — 초기 배치로 복귀, 아웃시킨 팀이 아닌 쪽에 소유권
    function drillReset() {
        const spots = { home: homeSpots(), away: awaySpots() };
        for (const key of ['home', 'away']) {
            sides[key].players.forEach((p, i) => {
                p.setPosition(spots[key][i].x, spots[key][i].y);
                p.setAngle(key === 'home' ? -90 : 90);
            });
            sides[key].dribbles.forEach(d => d.stop());
            sides[key].receptions.forEach(r => r.stop());
            sides[key].movements.forEach(m => m.stop());
            layers[key].reset();
        }
        interceptor.exclude = null;
        currentContest = null;
        const giveTo = lastTouchKey === 'home' ? 'away' : 'home';
        setPossession(giveTo, 2, false);
    }

    // ── 시작 ──
    bm.possess(home[carrierIdx], POSSESS_OFFSET);
    bm.snapToFront();
    sides.home.dribbles[carrierIdx].start();
    interceptor.start();

    function tick(dt) {
        if (complete) return;
        clock += dt;
        if (tackleCooldown > 0) tackleCooldown -= dt;
        if (clock > DRILL_TIME) { finish('complete'); return; }

        const side = posSide();
        const opp = oppSide();
        const carrier = side.players[carrierIdx];
        const owner = bm.owner;
        const bv = { x: bm.vx, y: bm.vy };

        if (passEvent) {
            passEvent.ttl -= dt;
            if (passEvent.ttl <= 0) passEvent = null;
        }

        // ── 루즈볼 공방 ──
        if (phase === PHASE.LOOSE) {
            if (currentContest) currentContest.update(dt);
            for (let i = 0; i < allPlayers.length; i++) {
                for (let j = i + 1; j < allPlayers.length; j++) {
                    BodyCollision.separate(allPlayers[i], allPlayers[j]);
                }
            }
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                drillReset(); return;
            }
            return;
        }

        // ── 패스 비행 ──
        // 레이어를 동결하지 않는다 (기존 동결이 "서서 플레이"의 원인).
        // 소유팀은 수신자를 차기 소유자로 보고 형태 유지 — 수신자는
        // 소유자 제외 규칙으로 레이어와 충돌하지 않는다. 수비팀은 루즈볼 추적.
        if (phase === PHASE.PASSING) {
            bm.update(dt);
            // 수신자 추적만 시나리오 적분 (레이어가 소유자를 제외하므로 충돌 없음)
            if (passReceiverIdx >= 0) {
                side.receptions[passReceiverIdx].update(dt);
                side.movements[passReceiverIdx].update(dt);
            }
            interceptor.update(dt);
            layers[posKey].update(dt, {
                ball, owner: side.players[passReceiverIdx],
                ballVelocity: bv, clock, passEvent,
            });
            layers[oppKey()].update(dt, {
                ball, owner: null, ballVelocity: bv, clock, passEvent: null,
            });
            for (let i = 0; i < allPlayers.length; i++) {
                for (let j = i + 1; j < allPlayers.length; j++) {
                    BodyCollision.separate(allPlayers[i], allPlayers[j]);
                }
            }
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                drillReset(); return;
            }
            // 수신 완료 감시
            if (passReceiverIdx >= 0 && side.receptions[passReceiverIdx].received) {
                receivePass(passReceiverIdx);
                return;
            }
            passWatchdog -= dt;
            if (passWatchdog <= 0) {
                // 해소 실패 — 가장 가까운 동료가 소유하고 계속
                interceptor.exclude = null;
                let best = -1, bd = Infinity;
                side.players.forEach((p, i) => {
                    const d = Math.hypot(p.x - ball.x, p.y - ball.y);
                    if (d < bd) { bd = d; best = i; }
                });
                if (best >= 0) setPossession(posKey, best, false);
                return;
            }
            return;
        }

        // ── 보유: 양 팀 레이어 + 캐리어 두뇌 ──
        layers.home.update(dt, { ball, owner, ballVelocity: bv, clock, passEvent });
        layers.away.update(dt, { ball, owner, ballVelocity: bv, clock, passEvent });

        // 캐리어 (레이어는 건드리지 않음 — 시나리오 소유)
        const carrierPM = side.movements[carrierIdx];
        carrierPM.update(dt);
        side.dribbles[carrierIdx].update(dt, { defenders: opp.players, clock });
        bm.update(dt);

        side.decisions[carrierIdx].update(dt, {
            carrier, movement: carrierPM,
            attackGoalX: side.attackGoalX,
            defenders: opp.players,
            ballAttached: side.dribbles[carrierIdx].ballAttached,
        });

        // 태클 성립 — 쿨다운 경과 후, 상대가 볼에 닿으면 공방
        if (owner === carrier && tackleCooldown <= 0) {
            for (const o of opp.players) {
                if (CollisionSystem.isTackle(o, ball)) {
                    startLoose(o);
                    return;
                }
            }
        }

        if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
            drillReset(); return;
        }

        // 선택 중재 — 패스 vs 드리블 (슛 없음: shotEval 실패 고정)
        const mates = side.players
            .map((p, i) => ({ player: p, idx: i }))
            .filter(m => m.idx !== carrierIdx);
        const assess = side.assessment.assess({
            carrier, mates, opponents: opp.players,
            ball, dir: side.dir, attackGoalX: side.attackGoalX,
        });
        const selected = side.choice.choose({
            assessment: assess,
            shotEval: { shoot: false, forced: false, quality: 0 },
            ballAttached: side.dribbles[carrierIdx].ballAttached,
            owner: carrier, dt,
        });
        if (events && events.onChoice) events.onChoice({ team: posKey, ...selected });
        if (selected.action === ATTACK_ACTION.PASS && selected.mateIdx >= 0
            && side.players[selected.mateIdx]) {
            executePass(selected.mateIdx);
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        for (const key of ['home', 'away']) {
            sides[key].dribbles.forEach(d => d.stop());
            sides[key].receptions.forEach(r => r.stop());
            sides[key].movements.forEach(m => m.stop());
        }
        interceptor.stop();
        if (currentContest) currentContest.stop();
    };
}
