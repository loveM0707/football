/**
 * OneVsOneDuel - 1:1 개인 전술 검증 메뉴
 *
 * 공격수(빨강, 9번)와 수비수(파랑, 4번)가 서로를 인식하고 반응하는지 검증한다.
 * 검증 대상: 드리블·방향전환·가속/감속, 수비 접근·자키잉·거리 유지,
 * 돌파 방향 선택·진행 방향 차단, 태클·볼 탈취·돌파 성공/실패, 돌파 후 슈팅.
 *
 * 행동 연출 금지:
 *   - 사전 웨이포인트·시간 지정 이동·스크립트 복귀 없음
 *   - 공격수 = DribbleDecision + DribbleController (매 프레임 수비수 재평가)
 *   - 수비수 = DefenderDuelAI (APPROACH→JOCKEY→LUNGE, 공격수 속도 예측)
 *   - 슛 판단·발사 = ShotDecision + ShotAttempt, 태클 해소 = PossessionContest
 *   - 시작 지오메트리만 매회 랜덤 — 이후 모든 행동은 모듈 판단
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
    CENTER_Y, GOAL_X, GOAL_TOP_Y, GOAL_BOTTOM_Y,
    Y_MIN, Y_MAX, FIELD_MIN_X, FIELD_MAX_X, FIELD_BOTTOM,
} from '../movement/FieldGeometry.js';

const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;
const SPEEDS = PlayerMovement.SPEEDS;

const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function run(layer, loop, onComplete = null) {
    // ── 시작 지오메트리 랜덤 (행동이 아닌 초기 조건만 무작위) ──
    const atkX = rand(380, 480);
    const atkY = rand(260, 420);
    const defX = clamp(atkX + rand(170, 230), FIELD_MIN_X, GOAL_X - 60);
    const defY = clamp(atkY + rand(-130, 130), Y_MIN + 30, Y_MAX - 30);

    const attacker = new Player({
        x: atkX, y: atkY, team: 'home', number: 9, angle: -90,
    }).render(layer);
    const defender = new Player({
        x: defX, y: defY, team: 'away', number: 4, angle: 90,
    }).render(layer);
    const goalkeeper = new Player({
        x: GK_START_X, y: GK_START_Y, team: 'away', number: 1, angle: 90,
    }).render(layer);
    const ball = new Ball(attacker.x, attacker.y).render(layer);

    const attPM = new PlayerMovement(attacker, { driftScale: 0 });
    const defPM = new PlayerMovement(defender, { driftScale: 0 });
    const bm = new BallMovement(ball);
    const attDC = new DribbleController(attPM, bm);

    // 공격 두뇌 — 수비수를 매 프레임 보고 돌파·전진·쉴딩·페인트를 선택
    // (1v1 검증용: 막히면 돌파를 거는 비율을 높이고 재시도 간격을 좁힌다)
    const dribbleDecision = new DribbleDecision({
        dir: 1, centerY: CENTER_Y,
        yMin: Y_MIN, yMax: Y_MAX,
        fieldMinX: FIELD_MIN_X, fieldMaxX: GOAL_X - 25,
        shootRange: 185,
        beatChance: 0.7,
        beatCooldown: 1.6,
    });

    // 수비 두뇌 — 공격수 위치·속도를 보고 접근·자키잉·태클을 선택
    const defenderDuel = new DefenderDuelAI({
        goalX: GOAL_X, goalY: CENTER_Y, dir: 1,
    });

    // 슛 판단·실행 — 돌파 후 슈팅 연결
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

    // 태클 → 루즈볼 공방 (1v1 검증용: 즉시 스틸보다 쳐내기 공방을 유도)
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

    function finish(result = null) {
        if (complete) return;
        complete = true;
        attDC.stop(); defenderDuel.stop(); contest.stop();
        attPM.stop(); defPM.stop();
        if (onComplete) onComplete(result);
    }

    // 공방 후 공격 계속 — 두뇌 상태만 초기화하고 위치는 그대로 (연출 없음)
    function resumeDuel() {
        dribbleDecision.reset();
        defenderDuel.reset();
        phase = PHASE.DUEL;
    }

    function startLoose(tackler) {
        attDC.stop();
        attPM.stop(); defPM.stop();
        contest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
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
    defenderDuel.start();

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

        // ── 1v1 듀얼 ──
        attPM.update(dt);
        attDC.update(dt, { defenders: [defender] });
        bm.update(dt);

        // 공격: 수비수를 보고 판단 (DribbleDecision이 PM을 직접 구동)
        dribbleDecision.update(dt, {
            carrier: attacker,
            movement: attPM,
            attackGoalX: GOAL_X,
            defenders: [defender],
            ballAttached: attDC.ballAttached,
        });

        // 수비: 공격수를 보고 판단 (DefenderDuelAI가 PM을 직접 구동)
        defenderDuel.update(dt, {
            defender,
            movement: defPM,
            attacker,
            attackerMovement: attPM,
            ball,
            ballVelocity: { x: bm.vx, y: bm.vy },
            ballAttached: attDC.ballAttached,
        });

        BodyCollision.separate(attacker, defender);

        // 태클 성립 — LUNGE 커밋 중에 접촉했을 때만 (자키잉 접촉은 탈취 아님)
        if (bm.owner === attacker && defenderDuel.tackleIntent
            && CollisionSystem.isTackle(defender, ball)) {
            startLoose(defender);
            return;
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
        attDC.stop(); defenderDuel.stop();
        attPM.stop(); defPM.stop();
    };
}
