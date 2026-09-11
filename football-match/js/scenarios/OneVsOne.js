/**
 * OneVsOne - 1:1 대결 시나리오
 *
 * 배치 (고정 — 메뉴 특유 강제):
 *   공격수(빨강, 9번) – 하프라인 가운데 (525, 340), 볼 소유
 *   수비수(파랑, 4번) – 오른쪽 30m (825, 340)
 *   골키퍼(파랑, 1번) – 오른쪽 골대 (1030, 340)
 *
 * 행동은 전부 공통 모듈이 담당한다 (1:1 듀얼과 동일한 두뇌).
 * 메뉴 고유 강제인 시작 위치·종료 조건以外에 시나리오 판단 로직 없음:
 *   - 볼 소유자 = DribbleDecision (dir만 다름: 홈 +1 / 원정 -1)
 *   - 비소유자  = DefenderDuelAI (지키는 골만 다름)
 *   - 슛 판단·발사 = ShotDecision + ShotAttempt (홈 공격 시만)
 *   - 태클 해소 = PossessionContest, 골키퍼 = GoalkeeperController
 *
 * 흐름:
 *   1. 홈이 소유 → 오른쪽 골을 향해 듀얼. 슛 판단이 서면 발사
 *   2. 원정이 태클로 빼앗으면 입장 교대 → 원정이 왼쪽으로 복귀 드리블,
 *      홈이 추격. 복귀 중 재탈취되면 다시 1로 (전부 모듈 판단, 스크립트 없음)
 *
 * 종료 조건 (메뉴 특유 강제):
 *   - 골 (ShotMovement 'goal')
 *   - 골키퍼 세이브 ('save') / 빗나감·골대 ('miss-wide' 등)
 *   - 라인 아웃 ('out')
 *   - 원정 소유로 하프라인 도달 ('defend')
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { DribbleDecision }   from '../movement/DribbleDecision.js';
import { DefenderDuelAI }    from '../movement/DefenderDuelAI.js';
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
import {
    CENTER_X, CENTER_Y, GOAL_X, GOAL_L_X, GOAL_TOP_Y, GOAL_BOTTOM_Y,
    HALF_LINE_X, Y_MIN, Y_MAX, FIELD_MIN_X, FIELD_BOTTOM,
} from '../movement/FieldGeometry.js';

// ── 메뉴 특유 강제: 고정 시작 위치·종료 조건 ──
const DEFENDER_START_X = 525 + 300;  // 825 (오른쪽 30m)
const DEFENDER_START_Y = CENTER_Y;
const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;
const POSSESS_OFFSET   = Player.BODY_RADIUS + Ball.RADIUS + 4;

export function run(layer, loop, onComplete = null) {
    const attacker = new Player({
        x: CENTER_X, y: CENTER_Y, team: 'home', number: 9, angle: -90,
    }).render(layer);
    const defender = new Player({
        x: DEFENDER_START_X, y: DEFENDER_START_Y, team: 'away', number: 4, angle: 90,
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

    // 소유자 두뇌 — 진영만 다르고 같은 모듈 (동료가 없어 드리블만 선택됨)
    const homeDecision = new DribbleDecision({
        dir: 1, centerY: CENTER_Y,
        yMin: Y_MIN, yMax: Y_MAX,
        fieldMinX: FIELD_MIN_X, fieldMaxX: GOAL_X - 25,
        shootRange: 185, beatChance: 0.7, beatCooldown: 1.6,
    });
    const awayDecision = new DribbleDecision({
        dir: -1, centerY: CENTER_Y,
        yMin: Y_MIN, yMax: Y_MAX,
        fieldMinX: FIELD_MIN_X, fieldMaxX: GOAL_X - 25,
        shootRange: 185, beatChance: 0.7, beatCooldown: 1.6,
    });

    // 추격자 두뇌 — 지키는 골만 다르고 같은 모듈
    const homeChaser = new DefenderDuelAI({ goalX: GOAL_L_X, goalY: CENTER_Y, dir: -1 });
    const awayChaser = new DefenderDuelAI({ goalX: GOAL_X, goalY: CENTER_Y, dir: 1 });

    // 슛 판단·실행 — 홈 공격 시만 사용 (원정 복귀에는 골키퍼가 없음)
    const shotDecision = new ShotDecision({
        goalTopY: GOAL_TOP_Y, goalBotY: GOAL_BOTTOM_Y, goalCenterY: CENTER_Y,
    });
    const shotExec = new ShotExecution({ goalTopY: GOAL_TOP_Y, goalBotY: GOAL_BOTTOM_Y });
    const shotAttempt = new ShotAttempt({ shotExec });
    const shot = new ShotMovement({ goalX: GOAL_X });

    // 골키퍼 — 위치·다이브·세이브 감시는 공통 모듈이 소유
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

    // 태클 → 루즈볼 공방
    const contest = new PossessionContest(attacker, attPM, defender, defPM, bm, {
        pokeSpeed: 220,
        catchDistance: 16,
        stealChance: 0.3,
    });

    const PHASE = { DUEL: 'duel', LOOSE: 'loose', SHOOT: 'shoot' };
    let phase = PHASE.DUEL;
    let complete = false;
    let shooting = false;
    let saveTimer = 0;
    let carrier = attacker; // 현재 볼 소유자 — 두뇌 배정의 유일한 기준

    function finish(result = null) {
        if (complete) return;
        complete = true;
        attDC.stop(); defDC.stop();
        homeChaser.stop(); awayChaser.stop(); contest.stop();
        attPM.stop(); defPM.stop();
        if (onComplete) onComplete(result);
    }

    // 소유자 교체 — 드리블 상한·두뇌 상태만 갱신 (위치·이동 개입 없음)
    function setCarrier(next) {
        if (carrier === next) return;
        if (carrier === attacker) attDC.stop(); else defDC.stop();
        carrier = next;
        if (carrier === attacker) {
            bm.possess(attacker, POSSESS_OFFSET);
            attDC.start();
        } else {
            bm.possess(defender, POSSESS_OFFSET);
            defDC.start();
        }
        bm.snapToFront();
        homeDecision.reset(); awayDecision.reset();
        homeChaser.reset(); awayChaser.reset();
        shooting = false;
    }

    function startLoose(tackler) {
        attDC.stop(); defDC.stop();
        attPM.stop(); defPM.stop();
        contest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                carrier = winner;
                if (carrier === attacker) attDC.start(); else defDC.start();
                homeDecision.reset(); awayDecision.reset();
                homeChaser.reset(); awayChaser.reset();
                shooting = false;
                phase = PHASE.DUEL;
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
            defenders: [defender],
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
    awayChaser.start();

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
            contest.update(dt);
            BodyCollision.separate(attacker, defender);
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
                finish('out'); return;
            }
            return;
        }

        // ── 듀얼: 소유자가 누구냐에 따라 두뇌만 배정 ──
        // 소유자 → 자기 진영 DribbleDecision / 추격자 → 자기 골 DefenderDuelAI
        const homeOwns = bm.owner === attacker;
        if (homeOwns !== (carrier === attacker)) setCarrier(homeOwns ? attacker : defender);

        const ownerDC = homeOwns ? attDC : defDC;
        const ownerDecision = homeOwns ? homeDecision : awayDecision;
        const chaserDuel = homeOwns ? awayChaser : homeChaser;
        const owner = homeOwns ? attacker : defender;
        const ownerPM = homeOwns ? attPM : defPM;
        const chaser = homeOwns ? defender : attacker;
        const chaserPM = homeOwns ? defPM : attPM;

        ownerPM.update(dt);
        ownerDC.update(dt, { defenders: [chaser] });
        bm.update(dt);

        ownerDecision.update(dt, {
            carrier: owner,
            movement: ownerPM,
            attackGoalX: homeOwns ? GOAL_X : GOAL_L_X,
            defenders: [chaser],
            ballAttached: ownerDC.ballAttached,
        });

        chaserDuel.update(dt, {
            defender: chaser,
            movement: chaserPM,
            attacker: owner,
            attackerMovement: ownerPM,
            ball,
            ballVelocity: { x: bm.vx, y: bm.vy },
            ballAttached: ownerDC.ballAttached,
        });

        BodyCollision.separate(attacker, defender);

        // 태클 성립 — LUNGE 커밋 중에 접촉했을 때만
        if (bm.owner === owner && chaserDuel.tackleIntent
            && CollisionSystem.isTackle(chaser, ball)) {
            startLoose(chaser);
            return;
        }

        if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > FIELD_BOTTOM) {
            finish('out'); return;
        }

        // 메뉴 특유 종료: 원정 소유로 하프라인 도달 → 수비 성공
        if (!homeOwns && defender.x <= HALF_LINE_X && bm.owner === defender) {
            finish('defend'); return;
        }

        // 홈 공격 시 슛 — 모듈이 shoot=true를 준 경우에만 발사
        if (homeOwns && !shooting && attDC.ballAttached) {
            const decision = shotDecision.evaluate({
                shooter: attacker,
                ball,
                attackGoalX: GOAL_X,
                dir: 1,
                defenders: [defender],
                keeper: goalkeeper,
                ballAttached: true,
            });
            if (decision.shoot) shooting = fireShot(decision);
        }
    }

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        attDC.stop(); defDC.stop();
        homeChaser.stop(); awayChaser.stop();
        attPM.stop(); defPM.stop();
    };
}
