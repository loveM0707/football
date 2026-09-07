/**
 * FourVsFourPossession - 4:4 포제션(킵어웨이) 검증 메뉴
 *
 * 4:4 포제션 + 4:4 탈압박 통합 메뉴 (포제션 기반). 공격 방향이 없다 —
 * "범위 안에서 볼을 빼앗기지 않는 플레이"를 검증한다.
 *
 * 규칙:
 *   - 전원 범위(ZONE) 안에서만 움직인다 (목표점은 전부 범위 클램프).
 *   - 연속 패스 10회 성공 시 종료 ('success'). 상대가 볼을 빼앗는
 *     순간(턴오버·수신 실패·범위 아웃) 카운트는 0으로 리셋된다.
 *   - 볼이 범위를 나가면 선수는 그대로, 볼만 나간 지점 안쪽에 두고
 *     상대팀 볼로 재개한다 (전원 순간이동 리셋 없음).
 *   - 150초 경과 ('timeup' → 시간 종료).
 *
 * 역할 분담 (중복 구현 금지 — 시나리오는 소유권·국면·종료만 담당):
 *   - 소유팀 오프볼 = KeepAwaySupport (무방향 — 느린 앵커 대형으로 공간 창출,
 *     볼을 따라달리지 않는다)
 *   - 캐리어 운반   = KeepAwayCarry (무방향 — 열린 공간으로 운반)
 *   - 패스/드리블 선택 = OverloadAssessment + AttackChoice (orientation neutral)
 *   - 수비          = DefensiveDecision (orientation neutral, 앵커 = 범위 중심)
 *                     press(볼) + lane-block(패스 루트) + mark/cover(공간 차단)
 *   - 패스 실행     = PassIntent + PassAccuracy + PassMovement
 *   - 수신          = BallReception
 *   - 탈취·공방     = PassInterceptor + PossessionContest + CollisionSystem
 *
 * 소유권이 바뀌면 역할이 그대로 뒤집힌다 (양 팀 동일 조립).
 * 방향성 움직임(OffBallDecision·DribbleDecision)과 무방향 움직임(KeepAway)은
 * 같은 intent 형태({ idx, role, targetX, targetY, speed })라 호출부 교체로
 * 재사용한다.
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
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
import { KeepAwaySupport, KeepAwayCarry } from '../movement/KeepAway.js';
import { DefensiveDecision } from '../movement/DefensiveDecision.js';
import { angleTo } from '../movement/Direction.js';
import {
    CENTER_Y, GOAL_X, Y_MIN, Y_MAX, FIELD_HEIGHT,
} from '../movement/FieldGeometry.js';

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const PASS_WATCHDOG = 4.0; // 패스 비행 해소 제한 — 초과 시 가장 가까운 동료가 소유
const DRILL_TIME = 150;    // 드릴 제한 시간 (초) — 초과 시 시간 종료
// 유지 범위 — 박스 앞 200씩 제외, 측면은 풀폭 (방향 없는 킵어웨이 구역).
// 밖으로 나가면 선수 재배치 없이 볼만 안쪽에 두고 상대 볼로 재개한다.
const ZONE_MIN_X = 200;
const ZONE_MAX_X = 850;
const ZONE_MIN_Y = Y_MIN;
const ZONE_MAX_Y = Y_MAX;
const ZONE = { minX: ZONE_MIN_X, maxX: ZONE_MAX_X, minY: ZONE_MIN_Y, maxY: ZONE_MAX_Y };
const ZONE_CX = (ZONE_MIN_X + ZONE_MAX_X) / 2;
const ZONE_CY = (ZONE_MIN_Y + ZONE_MAX_Y) / 2;
// 킵어웨이는 짧은 패스 놀이다 — 이보다 먼 동료는 패스 후보에서 제외한다.
// (장거리auto 롱패스=로빙 스루패스가 고립 지점으로 나가 "볼을 놓고 팀이
//  걸어가는" 현상의 직접 원인 — 거리를 제한하면 지상 단거리만 남는다)
const PASS_MAX_DIST = 300;
// 누적 패스 목표 — 성공 리시브 합계 (턴오버에 리셋되지 않는다)
const PASS_TARGET = 10;

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// 초기 배치 — 폭·깊이를 가진 2-2 형태 (원정은 거울, 방향성 없음)
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
    // 유지 범위 표시 — 점선 안이 플레이 구역 (엔티티보다 먼저 깔아 뒤에 둔다)
    const gridRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    gridRect.setAttribute('x', ZONE_MIN_X);
    gridRect.setAttribute('y', ZONE_MIN_Y);
    gridRect.setAttribute('width', ZONE_MAX_X - ZONE_MIN_X);
    gridRect.setAttribute('height', ZONE_MAX_Y - ZONE_MIN_Y);
    gridRect.setAttribute('fill', 'none');
    gridRect.setAttribute('stroke', '#ffd54a');
    gridRect.setAttribute('stroke-width', '2');
    gridRect.setAttribute('stroke-dasharray', '10 7');
    gridRect.setAttribute('opacity', '0.55');
    layer.appendChild(gridRect);
    const home = homeSpots().map((s, i) => new Player({
        x: s.x, y: s.y, team: 'home', number: 7 + i, angle: -90,
    }).render(layer));
    const away = awaySpots().map((s, i) => new Player({
        x: s.x, y: s.y, team: 'away', number: 4 + i, angle: 90,
    }).render(layer));
    const ball = new Ball(home[2].x, home[2].y).render(layer);
    const bm = new BallMovement(ball);
    // 진행도 HUD — 누적 패스 카운트를 매 틱 표시한다 (맨 위에 둔다).
    // 성공이 "갑자기" 뜨지 않게 조건과 현재치를 항상 보여준다.
    const hud = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    hud.setAttribute('x', 525);
    hud.setAttribute('y', -12);
    hud.setAttribute('text-anchor', 'middle');
    hud.setAttribute('font-size', '22');
    hud.setAttribute('fill', '#ffd54a');
    layer.appendChild(hud);
    const renderHud = () => {
        hud.textContent = `연속 패스 ${passesDone}/${PASS_TARGET} · 탈취·아웃 시 리셋`;
    };

    function makeSide(players) {
        const movements = players.map(p => new PlayerMovement(p, { driftScale: 0 }));
        return {
            players, movements,
            dribbles: movements.map(mv => new DribbleController(mv, bm)),
            receptions: players.map((p, i) => new BallReception(p, movements[i], bm)),
            // 무방향 평가 — 전진성·박스 가점 없이 개방도·레인만 본다
            assessment: new OverloadAssessment({ orientation: 'neutral' }),
            // 홀드 기본값(1.0s) — 압박 시에는 모듈이 pressHoldTime(0.25s)로
            // 짧게 놓는다. 시나리오 타이머로 볼키핑/패싱 성향을 강제하지
            // 않고 같은 모듈이 상황에서 정한다. 핑퐁은 태클 쿨다운+공방
            // 스턴이 막는다. 타이트한 레인도 통과시킨다 — 수신(BallReception)이
            // 감당하고, 무리한 패스는 인터셉터가 honest하게 처벌한다.
            // 홀드 0.5s — 킵어웨이는 터치-플레이가 본령. 1.0s(기본)는
            // 리시버가 4명의 수비가 좁혀드는 동안 볼을 들고 있어 태클을
            // 부른다(실측 interruption/초: 기본 2배). 핑퐁 방지 기준(0.28s)
            // 보다 1.8배 길어 논스톱 왕복은 여전히 발생하지 않는다.
            choice: new AttackChoice({ passLaneMin: 20, minHoldTime: 0.5 }),
            keepSupport: new KeepAwaySupport(),
            keepCarry: new KeepAwayCarry(),
        };
    }

    const sides = {
        home: makeSide(home),
        away: makeSide(away),
    };

    // 수비 — 무방향 위협 순위(개방도·레인) + 범위 중심 앵커.
    // press(볼 압박) + lane-block(패스 루트 차단) + mark/cover(공간 차단).
    // 역할 슬롯은 인원수대로 자동 분담되므로 시나리오는 수비수를 지정하지 않는다.
    const defense = new DefensiveDecision({
        orientation: 'neutral',
        goalX: ZONE_CX, goalY: ZONE_CY,
        centerY: CENTER_Y,
        minX: ZONE_MIN_X, maxX: ZONE_MAX_X, yMin: ZONE_MIN_Y, yMax: ZONE_MAX_Y,
    });
    const prevRoles = { home: null, away: null };

    const passIntent = new PassIntent({ longDist: PASS_MAX_DIST + 30 });
    const passAccuracy = new PassAccuracy();

    const allPlayers = [...home, ...away];
    const interceptor = new PassInterceptor(allPlayers,
        [...sides.home.movements, ...sides.away.movements], bm, {
        onControl: (p) => {
            if (complete || phase !== PHASE.PASSING) return;
            const team = p.team === 'home' ? sides.home : sides.away;
            const idx = team.players.indexOf(p);
            if (idx < 0) return;
            // 팀이 바뀔 때만 턴오버 (같은 팀 회수는 흐름 유지)
            const changed = p.team !== posKey;
            if (changed) {
                turnovers++;
                breakStreak(); // 상대가 빼앗는 순간 — 연속 카운트 리셋
                if (events && events.onTurnover) events.onTurnover({ by: p.team, idx, how: 'intercept' });
            } else {
                registerReception(); // 동료가 걷어낸 패스 회수 — 순환 유지
            }
            setPossession(p.team, idx, true, changed);
        },
    });

    const PHASE = { POSSESS: 'possess', PASSING: 'passing', LOOSE: 'loose' };
    let phase = PHASE.POSSESS;
    let complete = false;
    let posKey = 'home';
    let carrierIdx = 2;
    let clock = 0;
    let passWatchdog = 0;
    let passReceiverIdx = -1; // 비행 중 수신자 (지원 대형 제외용)
    let lastTouchKey = 'home';
    let currentContest = null;
    let contestants = []; // 공방 당사자 [prevOwner, tackler] — 관성 이동 제외용
    let passes = 0;
    let turnovers = 0;
    // 연속 패스 카운트 — 성공 리시브마다 +1, 흐름이 끊기면 0 리셋.
    // 상대가 빼앗는 순간(인터셉트·공방 탈취)과 수신 실패·범위 아웃에서
    // 순환이 끊긴 것이므로 카운트는 0으로 돌아간다.
    let passesDone = 0;
    // 소유 전환 직후 태클 금지 — 탈취자가 스크럼에서 빠져나와
    // 볼을 운반할 시간을 준다. 짧으면 공방 핑퐁에 볼이 영원히 갇힌다.
    let tackleCooldown = 2.0;
    const TACKLE_COOLDOWN = 2.0;

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

    // 수신 성공 — 연속 카운트 +1, 목표 달성 시 성공 종료
    function registerReception() {
        if (complete) return;
        passesDone++;
        if (passesDone >= PASS_TARGET) { finish('success'); return; }
    }

    // 순환 단절 — 상대 탈취·수신 실패·범위 아웃에서 카운트 리셋
    function breakStreak() {
        passesDone = 0;
    }

    // 소유권 교체 — 드리블 재개·판단 리셋만 수행 (위치 스냅 없음).
    // 태클 쿨다운은 팀이 바뀔 때만 리셋한다. 수신 때마다 리셋하면
    // 순환이 쿨다운을 영원히 갱신해 태클이 봉인된다. 턴오버 후 유예는
    // 유지해 탈취자가 스크럼에서 빠져나올 시간을 준다.
    function setPossession(teamKey, idx, alreadyOwned, resetTackle = true) {
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
        side.choice.reset();
        passReceiverIdx = -1;
        if (resetTackle) tackleCooldown = TACKLE_COOLDOWN;
        phase = PHASE.POSSESS;
    }

    // 패스 실행 — PassIntent + PassAccuracy + PassMovement 표준 조립
    // 조준점은 범위 안으로 가둔다 (수신자가 범위 밖으로 뛰지 않게)
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
            // 킵어웨이 = 지상 짧은 패스만 (auto 롱=로빙 스루패스 봉쇄)
            kind: 'short',
        });
        const aimX = clamp(intent.aimX, ZONE_MIN_X + 20, ZONE_MAX_X - 20);
        const aimY = clamp(intent.aimY, ZONE_MIN_Y + 10, ZONE_MAX_Y - 10);
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
                // 착지 = 수신 아님! 소유 판정은 BallReception(트랩 반경)에
                // 맡긴다. 여기서 바로 receivePass하면 수신자가 멀리 있어도
                // 볼이 순간이동한다.
                onLand: null,
            });
        } else {
            PassMovement.shortPass(bm, aimX, aimY, {
                arriveSpeed: rand(110, 140),
                deviationRad: acc.deviationRad,
            });
        }
        lastTouchKey = posKey;

        // 패서는 다음 틱부터 지원 대형에 자동 복귀한다 (별도 지시 없음 —
        // KeepAwaySupport가 전원을 매 틱 재배치하므로 이중 구동 금지).
        // 여기서 목표를 잡으면 지원 리타겟과 충돌하므로 킥 자세만 잡는다.
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
        registerReception();
        if (complete) return; // 목표 달성 시 종료 (소유 교체 생략)
        setPossession(posKey, mateIdx, false, false); // 수신은 유예 없음
    }

    function startLoose(tackler) {
        const side = posSide();
        const prevOwner = side.players[carrierIdx];
        const opp = oppSide();
        const pmA = side.movements[carrierIdx];
        const pmB = opp.movements[opp.players.indexOf(tackler)];
        side.dribbles.forEach(d => d.stop());
        opp.dribbles.forEach(d => d.stop());
        // 공방 당사자 2명만 정지 — 나머지는 기존 목표대로 관성 이동한다.
        // 전원 정지하면 0.3초짜리 공방 때마다 화면 전체가 멈춘 것처럼 보인다.
        pmA.stop();
        pmB.stop();
        currentContest = new PossessionContest(prevOwner, pmA, tackler, pmB, bm, {
            // 포제션 드릴: 즉각 스틸보다 루즈볼 경합을 살린다 (기본 0.45)
            pokeSpeed: 200, catchDistance: 16, stealChance: 0.25,
        });
        contestants = [prevOwner, tackler];
        phase = PHASE.LOOSE;
        currentContest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                currentContest = null;
                contestants = [];
                const winnerKey = winner.team === 'home' ? 'home' : 'away';
                const idx = sides[winnerKey].players.indexOf(winner);
                const changed = winnerKey !== posKey;
                if (changed) {
                    turnovers++;
                    breakStreak(); // 상대가 빼앗는 순간 — 연속 카운트 리셋
                    if (events && events.onTurnover) events.onTurnover({ by: winnerKey, idx, how: 'contest' });
                }
                lastTouchKey = winnerKey;
                setPossession(winnerKey, idx, true, changed);
            },
        });
    }

    // 범위 아웃 재개 — 선수는 그대로, 볼만 나간 지점 안쪽에 두고
    // 마지막에 건드리지 않은 팀(상대팀) 볼로 재개한다.
    function restartOut() {
        breakStreak(); // 범위 아웃도 순환 단절 — 상대 볼로 재개된다
        const rx = clamp(ball.x, ZONE_MIN_X + 30, ZONE_MAX_X - 30);
        const ry = clamp(ball.y, ZONE_MIN_Y + 30, ZONE_MAX_Y - 30);
        ball.setPosition(rx, ry);
        const giveTo = lastTouchKey === 'home' ? 'away' : 'home';
        const team = sides[giveTo];
        let best = 0, bd = Infinity;
        team.players.forEach((p, i) => {
            const d = Math.hypot(p.x - rx, p.y - ry);
            if (d < bd) { bd = d; best = i; }
        });
        // 재개 유예 — 받는 쪽이 자리 잡을 시간을 준다 (탈취 유예와 동일)
        setPossession(giveTo, best, false, true);
    }

    // 범위 이탈 — 볼이 점선 밖으로 나가면 재개 (선수 위치는 묻지 않음)
    function outOfZone() {
        return ball.x < ZONE_MIN_X || ball.x > ZONE_MAX_X
            || ball.y < ZONE_MIN_Y || ball.y > ZONE_MAX_Y;
    }

    // ── 시작 ──
    bm.possess(home[carrierIdx], POSSESS_OFFSET);
    bm.snapToFront();
    sides.home.dribbles[carrierIdx].start();
    interceptor.start();

    // 소유팀 지원 대형 — 수신자(비행 중)는 제외하고 시나리오가 직접 적분
    // (지원 두뇌와 수신 이동의 이중 구동 방지)
    function updateSupport(side, mates, dt) {
        const intents = side.keepSupport.evaluate({
            carrier: side.players[carrierIdx],
            mates, opponents: oppSide().players, zone: ZONE, clock,
        });
        for (const it of intents) {
            const mv = side.movements[it.idx];
            mv.speed = it.speed;
            mv.moveTo(it.targetX, it.targetY);
            mv.update(dt);
        }
    }

    // 수비 — 역할·목표는 DefensiveDecision이 산출, 실행만 moveTo
    // (누가 press/lane-block인지는 위치로 정해지므로 고정 분담이 없다)
    function updateDefense(dt) {
        const side = posSide();
        const opp = oppSide();
        const intents = defense.evaluate({
            ball,
            attackers: side.players,
            holderIdx: phase === PHASE.PASSING ? passReceiverIdx : carrierIdx,
            defenders: opp.players,
            prevRoles: prevRoles[oppKey()],
        });
        prevRoles[oppKey()] = intents.map(it => it.role);
        for (const it of intents) {
            const mv = opp.movements[it.idx];
            mv.speed = it.speed;
            mv.moveTo(it.targetX, it.targetY);
            mv.update(dt);
        }
    }

    function tick(dt) {
        if (complete) return;
        clock += dt;
        renderHud(); // 진행도 표시 (첫 틱에 초기화 포함)
        if (tackleCooldown > 0) tackleCooldown -= dt;
        if (clock > DRILL_TIME) { finish('timeup'); return; }

        const side = posSide();
        const opp = oppSide();
        const carrier = side.players[carrierIdx];
        const owner = bm.owner;

        // ── 루즈볼 공방 ──
        // 공방 당사자 2명은 공방 모듈이, 나머지 6명은 기존 목표대로 관성 이동
        // (펌프만 — 재지향 없음, 0.3초면 해소되므로 자연스러운 모멘텀).
        // 전원 정지하면 탈취 때마다 화면 전체가 멈춘 것처럼 보인다 (동결 금지).
        // 수렴 지시도 금지 — 6명이 볼로 달려들면 스크럼에 갇혀 되레 굳는다.
        if (phase === PHASE.LOOSE) {
            if (currentContest) currentContest.update(dt);
            for (const key of ['home', 'away']) {
                sides[key].movements.forEach((mv, i) => {
                    if (!contestants.includes(sides[key].players[i])) mv.update(dt);
                });
            }
            for (let i = 0; i < allPlayers.length; i++) {
                for (let j = i + 1; j < allPlayers.length; j++) {
                    BodyCollision.separate(allPlayers[i], allPlayers[j]);
                }
            }
            if (outOfZone()) {
                restartOut(); return;
            }
            return;
        }

        // ── 패스 비행 ──
        // 소유팀은 수신자를 차기 소유자로 보고 형태 유지 — 수신자는
        // 제외 규칙으로 지원 두뇌와 충돌하지 않는다. 수비는 루즈볼 추적.
        if (phase === PHASE.PASSING) {
            bm.update(dt);
            // 수신자 추적만 시나리오 적분 (지원 대형에서 제외하므로 충돌 없음)
            if (passReceiverIdx >= 0) {
                side.receptions[passReceiverIdx].update(dt);
                side.movements[passReceiverIdx].update(dt);
            }
            interceptor.update(dt);
            updateSupport(side, side.players
                .map((p, i) => ({ player: p, idx: i }))
                .filter(m => m.idx !== passReceiverIdx), dt);
            updateDefense(dt);
            for (let i = 0; i < allPlayers.length; i++) {
                for (let j = i + 1; j < allPlayers.length; j++) {
                    BodyCollision.separate(allPlayers[i], allPlayers[j]);
                }
            }
            if (outOfZone()) {
                restartOut(); return;
            }
            // 수신 완료 감시
            if (passReceiverIdx >= 0 && side.receptions[passReceiverIdx].received) {
                receivePass(passReceiverIdx);
                return;
            }
            passWatchdog -= dt;
            if (passWatchdog <= 0) {
                // 해소 실패 — 가장 가까운 동료가 소유하고 계속.
                // 수신 실패 — 순환이 끊겼으므로 카운트 리셋.
                breakStreak();
                interceptor.exclude = null;
                let best = -1, bd = Infinity;
                side.players.forEach((p, i) => {
                    const d = Math.hypot(p.x - ball.x, p.y - ball.y);
                    if (d < bd) { bd = d; best = i; }
                });
                if (best >= 0) setPossession(posKey, best, false, false);
                return;
            }
            return;
        }

        // ── 보유: 소유팀 지원 대형 + 캐리어 운반 + 수비 ──
        updateSupport(side, side.players
            .map((p, i) => ({ player: p, idx: i }))
            .filter(m => m.idx !== carrierIdx), dt);

        // 캐리어 (지원 대형은 건드리지 않음 — 시나리오 소유).
        // 운반 목표는 KeepAwayCarry가 산출, 실행만 moveTo.
        const carrierPM = side.movements[carrierIdx];
        const sug = side.keepCarry.suggest({
            carrier, opponents: opp.players, zone: ZONE,
        });
        carrierPM.speed = sug.speed;
        carrierPM.moveTo(sug.targetX, sug.targetY);
        carrierPM.update(dt);
        side.dribbles[carrierIdx].update(dt, { defenders: opp.players, clock });
        bm.update(dt);

        updateDefense(dt);

        // 태클 성립 — 쿨다운 경과 후, 상대가 볼에 닿으면 공방
        if (owner === carrier && tackleCooldown <= 0) {
            for (const o of opp.players) {
                if (CollisionSystem.isTackle(o, ball)) {
                    startLoose(o);
                    return;
                }
            }
        }

        if (outOfZone()) {
            restartOut(); return;
        }

        // 선택 중재 — 패스 vs 운반 (슛 없음: shotEval 실패 고정)
        const matePool = side.players
            .map((p, i) => ({ player: p, idx: i }))
            .filter(m => m.idx !== carrierIdx);
        // 짧은 패스만 — 롱패스 후보를 애초에 만들지 않는다. 단 전원이
        // 거리 밖이면 고립 드리블로 스쿼어에 파묻힌다(공방 학살) —
        // 최소한 가장 가까운 동료 하나는 옵션으로 남긴다.
        let mates;
        const nearPool = matePool
            .filter(m => Math.hypot(m.player.x - carrier.x, m.player.y - carrier.y) <= PASS_MAX_DIST);
        if (nearPool.length > 0) {
            mates = nearPool;
        } else {
            let nb = null, nd = Infinity;
            for (const m of matePool) {
                const d = Math.hypot(m.player.x - carrier.x, m.player.y - carrier.y);
                if (d < nd) { nd = d; nb = m; }
            }
            mates = nb ? [nb] : [];
        }
        const assess = side.assessment.assess({
            carrier, mates, opponents: opp.players, ball,
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
