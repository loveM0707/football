/**
 * ThreeTransition - 3:3 공격↔수비 전환 검증 메뉴
 *
 * 3v3 상황에서 볼 소유권이 바뀔 때 선수들의 전환 행동을 검증한다.
 * 검증 대상 (공격→수비): 볼 상실자의 즉각 반응·주변 압박·후방 커버·
 * 수비 형태 재구성. (수비→공격): 탈취 후 전진·지원·폭 확보·침투·패스 옵션.
 *
 * 전환 전용 판단 코드 없음. 전부 공통 모듈 (11v11 Counter Attack /
 * Counterpress에 그대로 재사용):
 *   - 소유권 관찰·팀 상태 = MatchState (실제 Possession Change 기반.
 *     시나리오 타이머 연출 없음 — 시간 창구는 모듈이 소유)
 *   - 전환 의사·의도 = TransitionDecision + TransitionIntent
 *   - 전환 총괄 = TransitionController (양 팀 전환 구동 + 반응 지연 +
 *     역압박 태클 커밋)
 *   - 안정 공격 = DribbleDecision + OffBallDecision + OverloadAssessment +
 *     AttackChoice + PassIntent + PassAccuracy + PassMovement +
 *     TeamSupport.passAndGo + BallReception (2v1·3v2와 동일 조립)
 *   - 안정 수비 = DefensiveTacticalLayer (2v3과 동일)
 *   - 태클 해소 = PossessionContest / 슛 = ShotDecision + ShotAttempt +
 *     ShotMovement (GK 없음 — 슛은 골라인 판정으로 해소)
 *
 * 구동 충돌 방지 (시나리오가 보장하는 유일한 규율):
 *   - 전환 중인 팀(컨트롤러 intent 보유)은 컨트롤러만 구동한다.
 *   - 안정 ATTACK 팀은 공격 스택이, 안정 DEFENSE 팀은 수비 레이어가 구동한다.
 *     (단, 상대가 TRANSITION_ATTACK이면 내 수비도 컨트롤러가 맡는다)
 *   - 그 외 국면(패스 비행·공방·슛)에서는 컨트롤러를 호출하지 않는다.
 *
 * 시나리오가 하는 일은 메뉴 특유 강제뿐: 초기 배치, 국면 전환(오픈·비행·
 * 공방·슛), 태클 성립 판정(커밋 + 접촉), 종료 조건(골/빗나감/아웃/탈취).
 * 전술 판단은 하지 않는다.
 *
 * 종료 조건:
 *   - 골 (ShotMovement 'goal')
 *   - 빗나감·골대 ('miss-wide' 등 — GK가 없어 세이브 없음)
 *   - 라인 아웃 ('out')
 * (수비 탈취는 종료하지 않는다 — 탈취 팀의 역습으로 그대로 이어진다.
 *  듀얼 메뉴의 'defend' 종료와 다르며, 전환 검증을 위한 의도적 선택이다.)
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
import { DefensiveTacticalLayer } from '../movement/DefensiveTacticalLayer.js';
import { MatchState }        from '../movement/MatchState.js';
import { TransitionController, TEAM_STATE } from '../movement/TransitionController.js';
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
import { angleTo } from '../movement/Direction.js';
import {
    CENTER_X, CENTER_Y, GOAL_R_X, GOAL_L_X, GOAL_TOP_Y, GOAL_BOTTOM_Y,
    Y_MIN, Y_MAX, FIELD_MIN_X, FIELD_BOTTOM,
} from '../movement/FieldGeometry.js';

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const SPEEDS = PlayerMovement.SPEEDS;
const PASS_WATCHDOG = 4.0; // 패스 비행 해소 제한 — 초과 시 가장 가까운 아군 소유
// 전환 창구 (초) — MatchState 옵션 (시나리오 타이머 아님).
// 창구 안에 재탈취가 반복되면 안정 공격에 못 들어가 슛이 안 나온다 —
// 짧게 잡아 역습·역압박을 보여주고 빨리 안정 공격으로 넘긴다.
const TRANSITION_WINDOW = 2.0;
// 태클 쿨다운 (초) — 모듈 기본값(2.2)보다 길게. 시도 자체는 유지하되
// 공방 핑퐁(창구 내 연속 탈취 → 무종결 랠리)을 끊는다.
const TACKLE_COOLDOWN = 3.0;
// 공방 탈취율 — 모듈 기본값(0.45). 어중간한 쳐내기보다 확실한 탈취·역습을
// 유도해 동일팀 미니 플립 반복을 줄인다.
const CONTEST_STEAL_CHANCE = 0.45;

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function run(layer, loop, onComplete = null, events = null) {
    // ── 초기 배치만 랜덤 (이후 행동은 모듈 몫) ──
    // 홈(오른쪽 공격) 왼쪽 하프 + 원정(왼쪽 공격) 오른쪽 하프.
    const homeSpots = [
        { x: rand(380, 460), y: rand(290, 390), number: 9 },
        { x: rand(300, 380), y: rand(120, 190), number: 7 },
        { x: rand(300, 380), y: rand(490, 560), number: 11 },
    ];
    const awaySpots = [
        { x: rand(590, 670), y: rand(290, 390), number: 4 },
        { x: rand(670, 750), y: rand(120, 190), number: 6 },
        { x: rand(670, 750), y: rand(490, 560), number: 8 },
    ];

    function makeSide(spots, teamName, angle) {
        const players = spots.map(s => new Player({
            x: clamp(s.x, FIELD_MIN_X, GOAL_R_X - 25),
            y: clamp(s.y, Y_MIN + 30, Y_MAX - 30),
            team: teamName, number: s.number, angle,
        }).render(layer));
        return {
            players,
            movements: players.map(p => new PlayerMovement(p, { driftScale: 0 })),
            dribbles: [],
            receptions: [],
        };
    }

    const home = makeSide(homeSpots, 'home', -90);
    const away = makeSide(awaySpots, 'away', 90);
    const ball = new Ball(home.players[0].x, home.players[0].y).render(layer);
    const bm = new BallMovement(ball);

    for (const t of [home, away]) {
        t.movements.forEach(m => t.dribbles.push(new DribbleController(m, bm)));
        t.players.forEach((p, i) => t.receptions.push(new BallReception(p, t.movements[i], bm)));
    }

    // 팀별 안정 공격/수비 두뇌 (NvM 범용)
    function makeBrains(dir, attackGoalX, ownGoalX) {
        return {
            dir, attackGoalX,
            dribbleDecision: new DribbleDecision({
                dir, centerY: CENTER_Y,
                yMin: Y_MIN, yMax: Y_MAX,
                fieldMinX: FIELD_MIN_X, fieldMaxX: GOAL_R_X - 25,
                shootRange: 185, beatChance: 0.6, beatCooldown: 1.8,
            }),
            offBall: new OffBallDecision({ dir, attackGoalX }),
            assessment: new OverloadAssessment({ dir }),
            choice: new AttackChoice({}),
            shotDecision: new ShotDecision({
                goalTopY: GOAL_TOP_Y, goalBotY: GOAL_BOTTOM_Y, goalCenterY: CENTER_Y,
            }),
        };
    }
    home.brains = makeBrains(1, GOAL_R_X, GOAL_L_X);
    away.brains = makeBrains(-1, GOAL_L_X, GOAL_R_X);
    for (const [t, opp] of [[home, away], [away, home]]) {
        t.opp = opp;
        t.defenseLayer = new DefensiveTacticalLayer({
            players: t.players,
            movements: t.movements,
            opponents: opp.players,
            dir: t.brains.dir,
            attackGoalX: t.brains.attackGoalX,
            goalX: t.brains.dir > 0 ? GOAL_L_X : GOAL_R_X,
            goalY: CENTER_Y,
            tackleOptions: { cooldown: TACKLE_COOLDOWN },
        });
        t.carrierIdx = -1;
        t.prevAttRoles = new Map();
    }

        // 전환 총괄 — 소유권 변화를 직접 관찰한다 (시나리오가 소유권을 통지하지 않음).
        // 전환 창구·태클 쿨다운은 모듈 옵션으로 주입한다 (시나리오 타이머 아님).
    const match = new MatchState({
        teamA: { players: home.players },
        teamB: { players: away.players },
        transitionWindow: TRANSITION_WINDOW,
    });
    const controller = new TransitionController({
        ballMovement: bm,
        teamA: { players: home.players, movements: home.movements },
        teamB: { players: away.players, movements: away.movements },
        matchState: match,
        dirA: 1, dirB: -1,
        attackGoalXA: GOAL_R_X, attackGoalXB: GOAL_L_X,
        // 스몰사이드 튜닝 (모듈 기본값은 11v11용 유지).
        // 역습 공간 기준 완화 (판단은 모듈 몫) + 태클 쿨다운 연장 (공방 핑퐁 방지).
        decisionOptions: { counterMinSpace: 90 },
        tackleOptions: { cooldown: TACKLE_COOLDOWN },
    });
    const keyOf = (t) => (t === home ? 'A' : 'B');

    const passIntent = new PassIntent();
    const passAccuracy = new PassAccuracy();
    const teamSupport = new TeamSupport({ dir: 1 });
    const shotExec = new ShotExecution({ goalTopY: GOAL_TOP_Y, goalBotY: GOAL_BOTTOM_Y });
    const shotAttempt = new ShotAttempt({ shotExec });

    // 지상 패스 차단·몸블록 — 전원 대상, 수신자는 비행마다 지정 제외
    const allField = [...home.players, ...away.players];
    const allFieldPM = [...home.movements, ...away.movements];
    const interceptor = new PassInterceptor(allField, allFieldPM, bm, {
        onControl: (p) => {
            if (complete || phase !== PHASE.PASSING) return;
            // 가로챈 팀의 볼이 된다 — 소유 확정 후 오픈 플레이로 복귀
            const t = home.players.includes(p) ? home : away;
            const idx = t.players.indexOf(p);
            interceptor.stop();
            setCarrier(t, idx);
            phase = PHASE.OPEN;
            if (events && events.onIntercept) events.onIntercept({ team: keyOf(t), idx });
        },
    });

    const PHASE = { OPEN: 'open', PASSING: 'passing', LOOSE: 'loose', SHOOT: 'shoot' };
    let phase = PHASE.OPEN;
    let complete = false;
    let shooting = false;
    let clock = 0;
    let passCtx = null; // { team, passerIdx, recIdx, elapsed, aimX, aimY }
    let shotCtx = null; // { team, idx, mod }
    let currentContest = null;
    let lastCarrier = null; // 드리블 생명주기 추적용
    let lastStateKey = null;

    function finish(result = null) {
        if (complete) return;
        complete = true;
        for (const t of [home, away]) {
            t.dribbles.forEach(d => d.stop());
            t.receptions.forEach(r => r.stop());
            t.defenseLayer.stop();
            t.movements.forEach(m => m.stop());
        }
        interceptor.stop();
        if (currentContest) currentContest.stop();
        if (onComplete) onComplete(result);
    }

    function stopTeamControls(t) {
        t.dribbles.forEach(d => d.stop());
        t.receptions.forEach(r => r.stop());
        t.defenseLayer.stop();
        t.movements.forEach(m => m.stop());
    }

    // 소유 확정 — 드리블 생명주기만 갱신 (위치는 contest/수신이 정한 그대로).
    // no-touch limbo 방지: 동일 캐리어 복귀에도 드리블을 반드시 재개한다.
    function setCarrier(t, idx) {
        const already = bm.owner === t.players[idx];
        if (t.carrierIdx === idx && already) {
            t.dribbles[idx].start();
            return;
        }
        t.dribbles.forEach(d => d.stop());
        t.opp.dribbles.forEach(d => d.stop());
        t.carrierIdx = idx;
        t.opp.carrierIdx = -1;
        if (!already) {
            bm.possess(t.players[idx], POSSESS_OFFSET);
            bm.snapToFront();
        }
        t.dribbles[idx].start();
        t.brains.dribbleDecision.reset();
        t.prevAttRoles.clear();
        lastCarrier = t.players[idx];
        shooting = false;
    }

    // 소유자 드리블 생명주기 — 주인이 바뀌면 구 주인 정지·새 주인 시작
    function syncDribbles() {
        const owner = bm.owner;
        if (owner === lastCarrier) return;
        if (lastCarrier) {
            for (const t of [home, away]) {
                const i = t.players.indexOf(lastCarrier);
                if (i >= 0) t.dribbles[i].stop();
            }
        }
        lastCarrier = owner;
        if (owner) {
            for (const t of [home, away]) {
                const i = t.players.indexOf(owner);
                if (i >= 0) {
                    t.dribbles[i].start();
                    t.carrierIdx = i;
                    t.opp.carrierIdx = -1;
                }
            }
        }
    }

    function matesOf(t, excludeIdx) {
        return t.players
            .map((p, i) => ({ player: p, idx: i }))
            .filter(e => e.idx !== excludeIdx);
    }

    // 안정 공격 스택 — 캐리어 드리블 + 무볼 형태 + 슛/패스 선택 (모듈 판단)
    // @returns {boolean} 드리블 갱신(볼 물리 포함)을 수행했는지
    function updateAttack(t, dt) {
        const b = t.brains;
        const c = t.carrierIdx;
        if (c < 0 || bm.owner !== t.players[c]) return false;
        const carrier = t.players[c];
        const carrierPM = t.movements[c];
        const mates = matesOf(t, c);

        carrierPM.update(dt);
        t.dribbles[c].update(dt, { defenders: t.opp.players });
        b.dribbleDecision.update(dt, {
            carrier, movement: carrierPM,
            attackGoalX: b.attackGoalX,
            defenders: t.opp.players,
            ballAttached: t.dribbles[c].ballAttached,
        });

        const intents = b.offBall.evaluate({
            carrier,
            mates,
            opponents: t.opp.players,
            clock,
            prevRoles: mates.map(m => t.prevAttRoles.get(m.player) ?? null),
        });
        intents.forEach((it, k) => {
            t.prevAttRoles.set(mates[k].player, it.role);
            t.movements[mates[k].idx].speed = it.speed;
            t.movements[mates[k].idx].moveTo(it.targetX, it.targetY);
            t.movements[mates[k].idx].update(dt);
        });

        // 슛 > 패스 > 드리블 (확정 우선순위, 난수 없음)
        const assess = b.assessment.assess({
            carrier, mates: mates.map(m => ({ player: m.player, idx: m.idx })),
            opponents: t.opp.players, ball, dir: b.dir, attackGoalX: b.attackGoalX,
        });
        const shotEval = b.shotDecision.evaluate({
            shooter: carrier, ball, attackGoalX: b.attackGoalX, dir: b.dir,
            defenders: t.opp.players, keeper: null,
            ballAttached: t.dribbles[c].ballAttached,
        });
        const selected = b.choice.choose({
            assessment: assess, shotEval, ballAttached: t.dribbles[c].ballAttached,
            owner: carrier, dt,
        });
        if (events && events.onChoice) events.onChoice({ team: keyOf(t), ...selected });
        if (selected.action === ATTACK_ACTION.PASS
            && mates.some(m => m.idx === selected.mateIdx)) {
            executePass(t, c, selected.mateIdx);
        } else if (selected.action === ATTACK_ACTION.SHOOT && !shooting) {
            shooting = fireShot(t, c, shotEval);
        }
        return true;
    }

    // 패스 실행 — PassDecision 계열 표준 조립
    function executePass(t, c, mateIdx) {
        const carrier = t.players[c], mate = t.players[mateIdx];
        const carrierPM = t.movements[c], matePM = t.movements[mateIdx];
        t.dribbles[c].stop();

        const mateVel = matePM.getVelocity();
        const mateSpeed = Math.hypot(mateVel.x, mateVel.y);
        const intent = passIntent.plan({
            ball, receiver: mate, receiverVel: mateVel,
            kind: mateSpeed > 60 ? 'through' : 'toFeet',
        });
        const aimX = clamp(intent.aimX, FIELD_MIN_X, GOAL_R_X - 25);
        const aimY = clamp(intent.aimY, Y_MIN + 10, Y_MAX - 10);
        const acc = passAccuracy.evaluate({
            dist: Math.hypot(mate.x - carrier.x, mate.y - carrier.y),
            nearestOpp: PassAccuracy.nearestOpponent(carrier, t.opp.players),
            moving: carrierPM.moving,
        });

        carrierPM.clearFacingTarget();
        carrierPM.setFacingTarget(angleTo(carrier.x, carrier.y, aimX, aimY));
        PassMovement.shortPass(bm, aimX, aimY, {
            arriveSpeed: rand(120, 145),
            deviationRad: acc.deviationRad,
        });

        const go = teamSupport.passAndGo(carrier, mate, { dir: t.brains.dir });
        carrierPM.speed = SPEEDS[2];
        carrierPM.moveTo(go.x, go.y);

        t.receptions[mateIdx].start({ runTargetX: aimX, runTargetY: aimY });
        interceptor.exclude = mate;
        interceptor.start();
        passCtx = { team: t, passerIdx: c, recIdx: mateIdx, elapsed: 0, aimX, aimY };
        phase = PHASE.PASSING;
        if (events && events.onPass) events.onPass({ team: keyOf(t), from: c, to: mateIdx });
    }

    function startLoose(tackler, tacklerTeam, tacklerIdx, victimTeam, victimIdx) {
        stopTeamControls(home);
        stopTeamControls(away);
        currentContest = new PossessionContest(
            victimTeam.players[victimIdx], victimTeam.movements[victimIdx],
            tackler, tacklerTeam.movements[tacklerIdx], bm, {
                pokeSpeed: 220, catchDistance: 16, stealChance: CONTEST_STEAL_CHANCE,
            });
        currentContest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                currentContest = null;
                // 승자가 어느 팀이든 플레이를 계속한다 — 탈취 팀의 역습과
                // 상실 팀의 역압박이 MatchState에 의해 자동 시작된다.
                const wt = home.players.includes(winner) ? home : away;
                const wi = wt.players.indexOf(winner);
                setCarrier(wt, wi);
                wt.defenseLayer.start();
                wt.opp.defenseLayer.start();
                phase = PHASE.OPEN;
            },
        });
        phase = PHASE.LOOSE;
    }

    function fireShot(t, c, decision) {
        const shot = new ShotMovement({ goalX: t.brains.attackGoalX });
        const res = shotAttempt.fire({
            shooter: t.players[c],
            movement: t.movements[c],
            dribble: t.dribbles[c],
            ballMovement: bm,
            shot,
            goalX: t.brains.attackGoalX,
            aimY: decision.aimY,
            defenders: t.opp.players,
        });
        if (!res.fired) return false;
        shotCtx = { team: t, idx: c, mod: shot };
        phase = PHASE.SHOOT;
        shooting = true;
        if (events && events.onShot) events.onShot({ team: keyOf(t) });
        return true;
    }

    function separateAll() {
        for (let i = 0; i < allField.length; i++) {
            for (let j = i + 1; j < allField.length; j++) {
                BodyCollision.separate(allField[i], allField[j]);
            }
        }
    }

    function emitState(states, groups) {
        const key = `${states.A}|${states.B}`;
        if (key === lastStateKey) return;
        lastStateKey = key;
        if (events && events.onState) {
            events.onState({
                A: states.A, B: states.B,
                decisions: groups.map(g => ({ team: g.key, state: g.state, decision: g.decision })),
            });
        }
        if (events && events.onTurnover && match.turnover) {
            const to = match.turnover.to;
            const g = groups.find(x => x.key === to && x.state === 'transition-attack');
            if (g) events.onTurnover({ to, decision: g.decision, x: match.turnover.x, y: match.turnover.y });
        }
    }

    bm.possess(home.players[0], POSSESS_OFFSET);
    bm.snapToFront();
    home.dribbles[0].start();
    home.carrierIdx = 0;
    lastCarrier = home.players[0];
    home.defenseLayer.start();
    away.defenseLayer.start();
    controller.reset('A'); // 킥오프 소유 확정 — 전환 버스트 없이 안정 상태로 시작

    function tick(dt) {
        if (complete) return;
        clock += dt;

        // ── 전환 총괄 (전 국면 매 틱): 실제 소유권 변화를 관찰해 팀 상태를 전이.
        // LOOSE 상태(비행·공방·슛 비행)에서는 intent가 없어 구동 충돌이 없다.
        // 국면 내 possess와 같은 틱에 OPEN으로 복귀하므로 다음 틱에 전이가 발화한다.
        syncDribbles();
        const owner = bm.owner;
        const ownerTeam = owner
            ? (home.players.includes(owner) ? home : away)
            : null;
        const ownerDc = owner && ownerTeam
            ? ownerTeam.dribbles[ownerTeam.players.indexOf(owner)]
            : null;
        const ctrl = controller.update(dt, {
            ball, clock,
            ballAttached: ownerDc ? ownerDc.ballAttached : true,
        });
        const states = ctrl.states;
        emitState(states, ctrl.intents);

        // ── 슛 비행 (GK 없음 — 골라인 판정으로 해소) ──
        if (phase === PHASE.SHOOT) {
            if (shotCtx) {
                shotCtx.mod.update(dt);
                if (shotCtx.mod.result !== null) {
                    const r = shotCtx.mod.result;
                    shotCtx = null;
                    finish(r === 'post-rebound' ? 'post' : r);
                }
            } else {
                finish('out');
            }
            return;
        }

        // ── 루즈볼 공방 (모듈이 추격·소유를 담당) ──
        if (phase === PHASE.LOOSE) {
            if (currentContest) currentContest.update(dt);
            separateAll();
            if (ball.x < 0 || ball.x > GOAL_R_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                finish('out'); return;
            }
            return;
        }

        // ── 패스 비행: 수신 + 가로채기 ──
        if (phase === PHASE.PASSING) {
            if (!passCtx) { phase = PHASE.OPEN; return; }
            const { team: t, passerIdx, recIdx } = passCtx;
            passCtx.elapsed += dt;
            bm.update(dt);
            t.receptions[recIdx].update(dt);
            t.movements[passerIdx].update(dt);
            t.movements[recIdx].update(dt);
            // 세 번째 아군은 모듈 판단으로 계속 이동한다 (정지 금지)
            const third = [0, 1, 2].find(i => i !== passerIdx && i !== recIdx);
            if (third !== undefined) {
                const mates = [{ player: t.players[third], idx: third }];
                const thirdPrev = mates.map(m => t.prevAttRoles.get(m.player) ?? null);
                const tIntents = t.brains.offBall.evaluate({
                    carrier: t.players[recIdx], mates,
                    opponents: t.opp.players, clock, prevRoles: thirdPrev,
                });
                tIntents.forEach((it, k) => {
                    t.prevAttRoles.set(mates[k].player, it.role);
                    t.movements[mates[k].idx].speed = it.speed;
                    t.movements[mates[k].idx].moveTo(it.targetX, it.targetY);
                    t.movements[mates[k].idx].update(dt);
                });
            }
            interceptor.update(dt);
            // 양 팀 수비 레이어가 비행에 대응한다 (컨트롤러는 LOOSE라 휴지)
            for (const tm of [home, away]) {
                tm.defenseLayer.update(dt, { ball, holder: null, attackers: t.players, ballAttached: false });
            }
            separateAll();
            if (ball.x < 0 || ball.x > GOAL_R_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                finish('out'); return;
            }
            if (t.receptions[recIdx].received) {
                interceptor.stop();
                setCarrier(t, recIdx);
                phase = PHASE.OPEN;
                return;
            }
            if (passCtx.elapsed > PASS_WATCHDOG) {
                interceptor.stop();
                let best = 0, bd = Infinity;
                t.players.forEach((a, i) => {
                    const d = Math.hypot(a.x - ball.x, a.y - ball.y);
                    if (d < bd) { bd = d; best = i; }
                });
                setCarrier(t, best);
                phase = PHASE.OPEN;
            }
            return;
        }

        // ── 오픈 플레이: 안정 스택 (전환 중인 팀은 위에서 컨트롤러가 구동) ──
        // 볼(드리블 킥 리듬)은 안정 공격에서 updateAttack이, 전환 중에는 여기서 갱신 —
        // 한 틱에 한 번만 (이중 갱신 금지).
        let attackRuns = false;
        for (const t of [home, away]) {
            const st = states[keyOf(t)];
            const foe = t.opp;
            const foeTransitionAttack = states[keyOf(foe)] === TEAM_STATE.TRANSITION_ATTACK;
            const iDrive = ctrl.intents.some(g => g.key === keyOf(t));
            if (iDrive) continue; // 전환 중 — 컨트롤러 소유
            if (st === TEAM_STATE.ATTACK && ownerTeam === t) {
                if (updateAttack(t, dt)) attackRuns = true;
            } else if (st === TEAM_STATE.DEFENSE && !foeTransitionAttack) {
                t.defenseLayer.update(dt, {
                    ball, holder: owner, attackers: foe.players, ballAttached: true,
                });
            }
            // LOOSE·대기 — 정지 (다음 전환이 반응 지연과 함께 시작된다)
        }
        if (ownerDc && !attackRuns) ownerDc.update(dt, { defenders: ownerTeam.opp.players });
        bm.update(dt);

        separateAll();

        // 태클 성립 — 레이어·컨트롤러의 커밋 + 접촉일 때만
        const committers = [];
        for (const t of [home, away]) {
            t.defenseLayer.getAssignments().forEach(a => {
                if (a.tackle) committers.push({ player: a.player, team: t });
            });
        }
        for (const g of ctrl.intents) {
            for (const it of g.intents) {
                if (it.tackle) {
                    const t = g.key === 'A' ? home : away;
                    committers.push({ player: it.player, team: t });
                }
            }
        }
        if (owner && ownerTeam) {
            const hit = committers.find(c =>
                c.team !== ownerTeam && CollisionSystem.isTackle(c.player, ball));
            if (hit) {
                const ti = hit.team.players.indexOf(hit.player);
                const vi = ownerTeam.players.indexOf(owner);
                startLoose(hit.player, hit.team, ti, ownerTeam, vi);
                return;
            }
        }

        if (ball.x < 0 || ball.x > GOAL_R_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
            finish('out'); return;
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        for (const t of [home, away]) {
            t.dribbles.forEach(d => d.stop());
            t.receptions.forEach(r => r.stop());
            t.defenseLayer.stop();
            t.movements.forEach(m => m.stop());
        }
        interceptor.stop();
        if (currentContest) currentContest.stop();
    };
}
