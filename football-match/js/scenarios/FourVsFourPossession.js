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
 * 슛·GK 없음. 순수 킵볼 — 박스 공성전으로 흐르지 않게 포제션 그리드로
 * 구역을 제한한다. 볼이 그리드를 벗어나면 드릴 리셋(상대 볼로 재개).
 *
 * 종료 조건:
 *   - 5연속 패스 성공 ('success' → 성공) — 수신이 끊기면(턴오버·수신
 *     실패·그리드 아웃) 카운트 리셋. 실측상 60% 정도 드릴에서 달성.
 *   - 150초 경과 ('timeup' → 시간 종료).
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
const DRILL_TIME = 150;    // 드릴 제한 시간 (초) — 초과 시 시간 종료
// 패스 후 이동 지시 유효 시간 (초) — 길면 패서 전원이 볼 쪽으로
// 달려들어 대형이 뭉개진다. 돌진 버스트만 주고 대형으로 복귀시킨다.
const PASS_EVENT_TTL = 0.6;
// 포제션 그리드 — 양 박스 앞 200씩 제외, 측면은 풀폭.
// 박스에 갇히는 공성전을 구조적으로 막는다 (밖으로 나가면 드릴 리셋).
const GRID_MIN_X = 200;
const GRID_MAX_X = 850;
const GRID_MIN_Y = Y_MIN;
const GRID_MAX_Y = Y_MAX;

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
    // 포제션 그리드 표시 — 점선 안이 유지 구역 (엔티티보다 먼저 깔아 뒤에 둔다)
    const gridRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    gridRect.setAttribute('x', GRID_MIN_X);
    gridRect.setAttribute('y', GRID_MIN_Y);
    gridRect.setAttribute('width', GRID_MAX_X - GRID_MIN_X);
    gridRect.setAttribute('height', GRID_MAX_Y - GRID_MIN_Y);
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
    // 진행도 HUD — 연속 패스 카운트를 매 틱 표시한다 (맨 위에 둔다).
    // 성공이 "갑자기" 뜨지 않게 조건과 현재치를 항상 보여준다.
    const hud = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    hud.setAttribute('x', 525);
    hud.setAttribute('y', -12);
    hud.setAttribute('text-anchor', 'middle');
    hud.setAttribute('font-size', '22');
    hud.setAttribute('fill', '#ffd54a');
    layer.appendChild(hud);
    const renderHud = () => {
        hud.textContent = `연속 패스 ${streak}/${STREAK_TARGET} · 5연속 성공`;
    };

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
                // 캐리어도 그리드를 존중한다 — 밖으로 몰고 나가면 리셋만
                // 반복된다 (기존 GOAL_X-25 대신 그리드 안쪽).
                fieldMinX: GRID_MIN_X + 20, fieldMaxX: GRID_MAX_X - 20,
                shootRange: 185,
            })),
            assessment: new OverloadAssessment({ dir }),
            // 홀드 기본값(1.0s) — 압박 시에는 모듈이 pressHoldTime(0.25s)로
            // 짧게 놓는다. 시나리오 타이머로 볼키핑/패싱 성향을 강제하지
            // 않고 같은 모듈이 상황에서 정한다. 핑퐁은 태클 쿨다운+공방
            // 스턴이 막는다. 타이트한 레인도 통과시킨다 — 수신(BallReception)이
            // 감당하고, 무리한 패스는 인터셉터가 honest하게 처벌한다.
            choice: new AttackChoice({ passLaneMin: 20 }),
            support: new TeamSupport({ dir }),
        };
    }

    const sides = {
        home: makeSide(home, 1, GOAL_X, 0),
        away: makeSide(away, -1, 0, GOAL_X),
    };

    // 양 팀 전술 레이어 — 오프볼·수비·전환 소유 (캐리어는 건드리지 않음)
    // 스몰사이드 튜닝 (모듈 기본값은 11v11용 유지):
    //   - 전환 창구 5→2초: 턴오버(패스 완료 포함)가 창구를 계속 열어도
    //     빨리 안정 공격(폭·깊이 형태) / 안정 수비(블록)로 넘어간다.
    //     창구가 길면 영구 역압박 스웜 = 8명이 볼에 다닥다닥 붙는다.
    //   - 역압박 반경 220→90: 정말 붙어 있을 때만 압박, 아니면 라인 복귀
    //     (폴백 = 수비 라인 재정렬 = 자연스러운 폭·깊이).
    //   - 자진영 박스 안 역압박 금지(뒤 공간 90→160): 자기 박스에서 볼에
    //     달려들면 8명이 골문 앞에 다닥다닥 붙는다. 박스 안 상실은 라인
    //     홀드로 막는다 (무모한 돌진 방지 — 모듈 판단 기준 그대로).
    //   - 압박 인원 3→2(pressN 2 유지 → 2명 압박 + 2명 재정렬): 전원
    //     수렴이 아니라 압박+커버 분업이 보인다.
    //   - 재정렬 라인: 볼 기준 45 골사이드(박스 틀어박힘 금지) + 간격 80.
    //     골 절대선(x=120)에 서면 볼(예: x=62)을 내주고 영원 공성전이
    //     된다. 라인이 플레이를 따라다녀야 박스에서 볼이 빠져나온다.
    //   - 폭 유지 발동 170→105 + 측면 ±180·전방 0: 측면 목표가 캐리어를
    //     전방 추적하면 영원히 따라만 다닌다. 측면은 순수 측면 터치라인에
    //     둬서 측면 간격은 볼 이동과 무관하게 벌어지게 한다.
    //   - 기본 지원 측면 95→150: 평소 대형 자체를 넓힌다. 수비는 박스에서
    //     뭉칠 수밖에 없으므로(평균을 갉아먹음) 공격이 크게 벌려야 한다.
    //   - 측면 해제 55: 측면 담당은 볼이 55 안으로 들어올 때만 해제된다.
    //     주인 바뀔 때마다 거리순 재선정하면 후퇴-전진을 반복해 아무도
    //     측면에 도착하지 못한다.
    const layerTuning = {
        transitionWindow: 2.0,
        // 측면 기둥 2.5초 — 측면 목표를 고정해야 동시 점유가 생긴다.
        // 이동 1.4s < 고정 2.5s라 도착 후 약 1초간 터치라인에 선다.
        widenPostTTL: 2.5,
        decisionOptions: { counterPressDist: 90, counterPressSpace: 160 },
        // 전환 의도도 그리드 안 (역습 런·재정렬 라인이 박스로 빠지지 않게).
        // 재정렬 하한이 그리드 경계(220/830)에 걸리면 박스 캠핑도 덩달아 해소.
        intentOptions: { swarmN: 2, lineBallGap: 45, lineSpacing: 80, minX: 220, maxX: 830 },
        // 오프볼 목표도 그리드 안 (침투자가 910까지 나가지 않게).
        offBallOptions: {
            widenDist: 105, widenHalfWidth: 180, widenForward: 0,
            supportLateral: 150, widenRelease: 55,
            minX: 220, maxX: 830,
        },
    };
    const layers = {
        home: new TeamTacticalLayer({
            players: home, movements: sides.home.movements, opponents: away,
            myKey: 'A', dir: 1, attackGoalX: GOAL_X, ownGoalX: 0,
            ...layerTuning,
        }),
        away: new TeamTacticalLayer({
            players: away, movements: sides.away.movements, opponents: home,
            myKey: 'B', dir: -1, attackGoalX: 0, ownGoalX: GOAL_X,
            ...layerTuning,
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
            // 팀이 바뀔 때만 턴오버 (같은 팀 회수는 흐름 유지).
            // 태클 유예도 팀 교체 때만 (같은 팀 회수는 순환의 일부).
            const changed = p.team !== posKey;
            if (changed) {
                turnovers++;
                if (events && events.onTurnover) events.onTurnover({ by: p.team, idx, how: 'intercept' });
                breakStreak();
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
    let passEvent = null; // { passer, receiver, ttl } — 레이어에 전달
    let passReceiverIdx = -1; // 비행 중 수신자 (레이어 소유자 제외용)
    let lastTouchKey = 'home';
    let currentContest = null;
    let contestants = []; // 공방 당사자 [prevOwner, tackler] — 레이어 구동 제외용
    let passes = 0;
    let turnovers = 0;
    // 연속 패스 카운트 — 수신 성공 시 +1, 순환 단절 시 리셋.
    // STREAK_TARGET 달성 시 성공 종료 (실측 달성률 약 60%).
    let streak = 0;
    const STREAK_TARGET = 5;
    // 소유 전환 직후 태클 금지 — 탈취자가 스크럼에서 빠져나와
    // 볼을 운반할 시간을 준다. 짧으면 공방 핑퐁에 볼이 영원히 갇힌다.
    // (2v2·3v3의 0.8s와 달리 포제션 드릴은 운반이 목적이라 길게)
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
        streak++;
        if (streak >= STREAK_TARGET) { finish('success'); return; }
    }

    // 순환 단절 — 턴오버·수신 실패·그리드 아웃 시 카운트 리셋
    function breakStreak() {
        streak = 0;
    }

    // 소유권 교체 — 드리블 재개·판단 리셋만 수행 (위치 스냅 없음).
    // 태클 쿨다운은 팀이 바뀔 때만 리셋한다. 수신 때마다 리셋하면
    // 1초 순환이 쿨다운(2.0s)을 영원히 갱신해 태클이 봉인되고,
    // 무패 핑퐁(4연속이 4초 만에 끝남)이 된다. 턴오버 후 유예는 유지해
    // 탈취자가 스크럼에서 빠져나올 시간을 준다.
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
        side.decisions.forEach(d => d.reset());
        side.choice.reset();
        passEvent = null;
        passReceiverIdx = -1;
        if (resetTackle) tackleCooldown = TACKLE_COOLDOWN;
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
                // 착지 = 수신 아님! 소유 판정은 BallReception(트랩 반경)에
                // 맡긴다. 여기서 바로 receivePass하면 수신자가 멀리 있어도
                // 볼이 순간이동한다 (4v4 탈압박 동일 증상).
                onLand: null,
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
                    if (events && events.onTurnover) events.onTurnover({ by: winnerKey, idx, how: 'contest' });
                    breakStreak();
                }
                lastTouchKey = winnerKey;
                setPossession(winnerKey, idx, true, changed);
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
        contestants = [];
        breakStreak(); // 그리드 아웃 — 순환 단절
        const giveTo = lastTouchKey === 'home' ? 'away' : 'home';
        setPossession(giveTo, 2, false);
    }

    // 그리드 이탈 — 박스 방향으로 나가면 드릴 리셋 (상대 볼로 재개)
    function outOfGrid() {
        return ball.x < GRID_MIN_X || ball.x > GRID_MAX_X
            || ball.y < GRID_MIN_Y || ball.y > GRID_MAX_Y;
    }

    // ── 시작 ──
    bm.possess(home[carrierIdx], POSSESS_OFFSET);
    bm.snapToFront();
    sides.home.dribbles[carrierIdx].start();
    interceptor.start();

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
        const bv = { x: bm.vx, y: bm.vy };

        if (passEvent) {
            passEvent.ttl -= dt;
            if (passEvent.ttl <= 0) passEvent = null;
        }

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
            if (outOfGrid()) {
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
            if (outOfGrid()) {
                drillReset(); return;
            }
            // 수신 완료 감시
            if (passReceiverIdx >= 0 && side.receptions[passReceiverIdx].received) {
                receivePass(passReceiverIdx);
                return;
            }
            passWatchdog -= dt;
            if (passWatchdog <= 0) {
                // 해소 실패 — 가장 가까운 동료가 소유하고 계속.
                // 수신 실패이므로 연속 카운트는 리셋한다.
                interceptor.exclude = null;
                let best = -1, bd = Infinity;
                side.players.forEach((p, i) => {
                    const d = Math.hypot(p.x - ball.x, p.y - ball.y);
                    if (d < bd) { bd = d; best = i; }
                });
                breakStreak();
                if (best >= 0) setPossession(posKey, best, false, false);
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

        if (outOfGrid()) {
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
