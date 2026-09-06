/**
 * OneVsTwo - 1:2 수적 열세 검증 메뉴
 *
 * 공격수 1명(빨강 9번)과 수비수 2명(파랑 4·5번)이 협력 수비를
 * 제대로 수행하는지 검증한다. 검증 대상: 1차 압박, 2차 커버,
 * 패스 라인 차단(모듈 NvM — 2명 이상 공격수에서 배정), 공격수의
 * 탈압박·방향 전환·돌파 가능성, 수비수 간 거리·역할 분담.
 *
 * 1v2 전용 판단 코드 없음. 역할 분담은 전부 공통 모듈:
 *   - 역할 결정 = DefensiveDecision (NvM 범용: 2v2·3v3·11v11 재사용)
 *     · 공격수 1명 → press + cover (위협이 없으므로 lane-block/mark 미배정)
 *     · 누가 press인지는 매 틱 위치로 재결정 — A/B 강제 지정 없음.
 *       공격수가 압박을 벗기면 커버가 자동으로 1차 압박으로 전환된다.
 *   - 공격 이동 = DribbleDecision / 볼 소유 = DribbleController
 *   - 태클 해소 = PossessionContest / 슛·GK = ShotDecision + ShotAttempt +
 *     GoalkeeperController (1:1 듀얼과 동일 조립)
 *
 * 시나리오가 하는 일은 메뉴 특유 강제뿐: 초기 배치, 태클 성립 판정
 * (PRESS 역할의 TackleDecision 커밋 + 접촉 — 1:1 듀얼의 tackleIntent에 해당하는 배관),
 * 국면 전환(듀얼·공방·슛), 종료 조건(골/세이브/빗나감/아웃/탈취).
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
import { DefensiveDecision } from '../movement/DefensiveDecision.js';
import { DEFENSE_ROLE }      from '../movement/CooperativeDefenseAI.js';
import { TackleDecision }    from '../movement/TackleDecision.js';
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

const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;

// 태클 커밋 타이밍은 TackleDecision이 소유 (킥 국면·거리·정면·쿨다운).
// 누가 PRESS인지는 DefensiveDecision이 정하므로 시나리오는 수비수를 지정하지 않는다.

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function run(layer, loop, onComplete = null, events = null) {
    // ── 초기 배치만 랜덤 (행동 판단은 모듈 몫) ──
    // 두 수비수는 깊이를 달리해 배치하되 범위(+90~170 / +150~250)가 겹치므로
    // 인덱스가 역할을 정하지 않는다 — 첫 틱부터 모듈이 거리로 배정한다.
    const atkX = rand(380, 480);
    const atkY = rand(260, 420);

    const attacker = new Player({
        x: atkX, y: atkY, team: 'home', number: 9, angle: -90,
    }).render(layer);
    const defA = new Player({
        x: clamp(atkX + rand(90, 170), FIELD_MIN_X, GOAL_X - 60),
        y: clamp(atkY + rand(-140, 140), Y_MIN + 30, Y_MAX - 30),
        team: 'away', number: 4, angle: 90,
    }).render(layer);
    const defB = new Player({
        x: clamp(atkX + rand(150, 250), FIELD_MIN_X, GOAL_X - 60),
        y: clamp(atkY + rand(-140, 140), Y_MIN + 30, Y_MAX - 30),
        team: 'away', number: 5, angle: 90,
    }).render(layer);
    const goalkeeper = new Player({
        x: GK_START_X, y: GK_START_Y, team: 'away', number: 1, angle: 90,
    }).render(layer);
    const ball = new Ball(attacker.x, attacker.y).render(layer);

    const defenders = [defA, defB];
    const defPM = defenders.map(p => new PlayerMovement(p, { driftScale: 0 }));
    const attPM = new PlayerMovement(attacker, { driftScale: 0 });
    const bm = new BallMovement(ball);
    const attDC = new DribbleController(attPM, bm);

    // 공격 두뇌 — 수비 2명을 매 프레임 보고 돌파·전진·쉴딩·페인트를 선택
    // (돌파 가능성 검증용: 막히면 돌파를 거는 비율을 높이고 재시도 간격을 좁힌다)
    const dribbleDecision = new DribbleDecision({
        dir: 1, centerY: CENTER_Y,
        yMin: Y_MIN, yMax: Y_MAX,
        fieldMinX: FIELD_MIN_X, fieldMaxX: GOAL_X - 25,
        shootRange: 185,
        beatChance: 0.7,
        beatCooldown: 1.6,
    });

    // 수비 두뇌 — 순수 판단 모듈. 역할·목표만 산출하고 실행은 아래 틱이 담당.
    // (DefenderDuelAI와 달리 이동을 직접 구동하지 않으므로 2명이 겹치지 않는다)
    const defense = new DefensiveDecision({ dir: 1, goalX: GOAL_X, goalY: CENTER_Y });
    // 태클 커밋 판단 (NvM 범용 — 킥 국면에 PRESS만 발을 뻗는다)
    const tackle = new TackleDecision({});

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

    const PHASE = { DUEL: 'duel', LOOSE: 'loose', SHOOT: 'shoot' };
    let phase = PHASE.DUEL;
    let complete = false;
    let shooting = false;
    let saveTimer = 0;
    let prevRoles = null;   // 수비 역할 유지 판단용 (모듈이 진동 방지에 사용)
    let lastRoleKey = null; // 역할 변경 감지 (검증 이벤트용)
    let currentContest = null;

    function finish(result = null) {
        if (complete) return;
        complete = true;
        attDC.stop();
        if (currentContest) currentContest.stop();
        attPM.stop(); defPM.forEach(pm => pm.stop());
        if (onComplete) onComplete(result);
    }

    // 공방 후 공격 계속 — 두뇌 상태만 초기화하고 위치는 그대로 (연출 없음)
    function resumeDuel() {
        dribbleDecision.reset();
        prevRoles = null;
        lastRoleKey = null;
        phase = PHASE.DUEL;
    }

    function startLoose(tackler, tacklerIdx) {
        attDC.stop();
        attPM.stop(); defPM.forEach(pm => pm.stop());
        currentContest = new PossessionContest(
            attacker, attPM, tackler, defPM[tacklerIdx], bm, {
                pokeSpeed: 220, catchDistance: 16, stealChance: 0.3,
            });
        currentContest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                currentContest = null;
                if (winner === attacker) {
                    bm.possess(attacker, POSSESS_OFFSET);
                    bm.snapToFront();
                    attDC.start();
                    resumeDuel();
                } else {
                    finish('defend');
                }
            },
        });
        phase = PHASE.LOOSE;
    }

    function fireShot(decision) {
        const res = shotAttempt.fire({
            shooter: attacker,
            movement: attPM,
            dribble: attDC,
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
        return true;
    }

    bm.possess(attacker, POSSESS_OFFSET);
    bm.snapToFront();
    attDC.start();

    function tick(dt) {
        if (complete) return;

        if (phase !== PHASE.SHOOT) gkc.updatePosition(dt);

        if (saveTimer > 0) {
            saveTimer -= dt; bm.update(dt);
            if (saveTimer <= 0) finish('save');
            return;
        }

        // ── 슈팅 비행 ──
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

        // ── 루즈볼 공방 (모듈이 추격·소유를 담당) ──
        if (phase === PHASE.LOOSE) {
            if (currentContest) currentContest.update(dt);
            BodyCollision.separate(attacker, defA);
            BodyCollision.separate(attacker, defB);
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                finish('out'); return;
            }
            return;
        }

        // ── 1v2 듀얼 ──
        attPM.update(dt);
        attDC.update(dt, { defenders });
        bm.update(dt);

        // 공격: 수비 2명을 보고 판단 (DribbleDecision이 PM을 직접 구동)
        dribbleDecision.update(dt, {
            carrier: attacker,
            movement: attPM,
            attackGoalX: GOAL_X,
            defenders,
            ballAttached: attDC.ballAttached,
        });

        // 수비: 역할·목표는 DefensiveDecision이 산출, 실행만 moveTo
        // (누가 press/cover인지는 위치로 정해지므로 A/B 고정이 없다)
        const intents = defense.evaluate({
            ball,
            attackers: [attacker],
            holderIdx: 0,
            defenders,
            prevRoles,
        });
        prevRoles = intents.map(it => it.role);
        intents.forEach((it) => {
            const dp = defenders[it.idx];
            const dpm = defPM[it.idx];
            // 스퀘어업 — 컨테인 후퇴 중 볼을 등진 채로는 태클이 성립하지 않는다.
            // 근접 + 킥 국면 + 쿨다운 준비면 정면을 잡고 볼로 돌진한다.
            const sq = it.role === DEFENSE_ROLE.PRESS
                ? tackle.squareUp(dt, dp, ball, attDC.ballAttached)
                : null;
            if (sq !== null) {
                dpm.speed = PlayerMovement.SPEEDS[4];
                dpm.clearFacingTarget();
                dpm.setFacingTarget(sq);
                dpm.moveTo(ball.x, ball.y);
            } else {
                dpm.speed = it.speed;
                dpm.moveTo(it.targetX, it.targetY);
            }
            dpm.update(dt);
        });

        // 역할 변경 검증 이벤트 — press/cover 분담이 실제로 일어나는지 외부 관찰용
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

        BodyCollision.separate(attacker, defA);
        BodyCollision.separate(attacker, defB);
        BodyCollision.separate(defA, defB);

        // 태클 성립 — PRESS 역할의 태클 커밋 + 접촉일 때만.
        // 커밋 타이밍은 TackleDecision이 소유한다. 누가 PRESS인지는 모듈이 정한다.
        tackle.update(dt); // 태클 쿨다운은 항상 흐른다
        const press = intents.find(it => it.role === DEFENSE_ROLE.PRESS);
        if (press && bm.owner === attacker) {
            const presser = defenders[press.idx];
            if (tackle.decide(presser, ball, attDC.ballAttached)
                && CollisionSystem.isTackle(presser, ball)) {
                startLoose(presser, press.idx);
                return;
            }
        }

        if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
            finish('out'); return;
        }

        // 돌파 후 슈팅 — 모듈이 shoot=true를 준 경우에만 발사
        if (!shooting && attDC.ballAttached) {
            const decision = shotDecision.evaluate({
                shooter: attacker,
                ball,
                attackGoalX: GOAL_X,
                dir: 1,
                defenders,
                keeper: goalkeeper,
                ballAttached: true,
            });
            if (decision.shoot) shooting = fireShot(decision);
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        attDC.stop();
        if (currentContest) currentContest.stop();
        attPM.stop(); defPM.forEach(pm => pm.stop());
    };
}
