/**
 * TwoVsTwo - 2:2 대결 시나리오
 *
 * 모듈 조립 방식: 시나리오는 엔티티 생성과 모듈 연결만 담당한다.
 *
 * 배치 (한 팀 내 상하 20m 고정):
 *   공격수A/B(빨강, 9/10번) – 하프라인 왼쪽 (X: 20~515, Y: baseY±100, 간격 200=20m), 볼은 둘 중 한 명이 소유
 *   수비수1/2(파랑, 4/5번)  – 하프라인 오른쪽 30~40m (X: 825~925, Y: baseY±100, 간격 200=20m)
 *   골키퍼(파랑, 1번)       – 오른쪽 골대 (1030, 340) 고정
 *
 * 종료 조건:
 *   - 골 ('goal')
 *   - 라인 아웃 ('out')
 *   - 수비수가 하프라인까지 볼 소유 ('defend')
 *   - 골키퍼 세이브 ('save')
 */
import { Player }            from '../entities/Player.js';
import { Ball }              from '../entities/Ball.js';
import { PlayerMovement }    from '../movement/PlayerMovement.js';
import { BallMovement }      from '../movement/BallMovement.js';
import { DribbleController } from '../movement/DribbleController.js';
import { CollisionSystem }   from '../movement/CollisionSystem.js';
import { BodyCollision }     from '../movement/BodyCollision.js';
import { PossessionContest } from '../movement/PossessionContest.js';
import { CooperativeDefenseAI } from '../movement/CooperativeDefenseAI.js';
import { AttackerTeamAI }    from '../movement/AttackerTeamAI.js';
import { PassMovement }      from '../movement/PassMovement.js';
import { ShotMovement }      from '../movement/ShotMovement.js';
import { GoalkeeperMovement } from '../movement/GoalkeeperMovement.js';
import { GoalkeeperSave, SAVE_RESULT } from '../movement/GoalkeeperSave.js';
import { angleTo } from '../movement/Direction.js';
import { PassInterceptor } from '../movement/PassInterceptor.js';
import { ShotExecution }   from '../movement/ShotExecution.js';

// ── 상수 ──────────────────────────────────────────────
const CENTER_X       = 525;
const CENTER_Y       = 340;
const GOAL_X         = 1050;
const GOAL_TOP_Y     = 303.4;
const GOAL_BOTTOM_Y  = 376.6;
const HALF_LINE_X    = 525;
const Y_MIN          = 45;
const Y_MAX          = 635;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;

// 슈팅 허용 구간 — 골대 전방 19m~6m (너무 먼 슈팅 방지, 박스 안쪽에서 마무리)
const SHOOT_MIN_X = GOAL_X - 190;
const SHOOT_MAX_X = GOAL_X - 60;

const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;
const GK_POSITION_SPEED = 350;
const GK_DIVE_SPEED = 500;
const GK_REACTION_TIME = 0.1;

const SPEEDS = PlayerMovement.SPEEDS;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function rand(min, max) { return min + Math.random() * (max - min); }
function randTeamPair(minX, maxX) {
    // 한 팀 내 상하 간격 20m(=200 SVG) 고정: 같은 X 근처, Y는 baseY±100
    const baseX = rand(minX, maxX);
    const baseY = rand(Y_MIN + 110, Y_MAX - 110); // 155~525 → Y±100 모두 필드 안
    return [
        { x: clamp(baseX + rand(-12, 12), minX, maxX), y: baseY - 100 },
        { x: clamp(baseX + rand(-12, 12), minX, maxX), y: baseY + 100 },
    ];
}



// ── 시나리오 ──────────────────────────────────────────
export function run(layer, loop, onComplete = null) {

    // 1. 엔티티 생성 — 한 팀 내 상하 20m(=200 SVG) 간격 고정
    const [atkPosA, atkPosB] = randTeamPair(20, HALF_LINE_X - 10);
    const atkA = new Player({ x: atkPosA.x, y: atkPosA.y, team: 'home', number: 9,  angle: -90 }).render(layer);
    const atkB = new Player({ x: atkPosB.x, y: atkPosB.y, team: 'home', number: 10, angle: -90 }).render(layer);
    atkA.idx = 0; atkB.idx = 1;

    const [defPos1, defPos2] = randTeamPair(HALF_LINE_X + 300, HALF_LINE_X + 400);
    const def1 = new Player({ x: defPos1.x, y: defPos1.y, team: 'away', number: 4, angle: 90 }).render(layer);
    const def2 = new Player({ x: defPos2.x, y: defPos2.y, team: 'away', number: 5, angle: 90 }).render(layer);
    def1.idx = 0; def2.idx = 1;

    const goalkeeper = new Player({ x: GK_START_X, y: GK_START_Y, team: 'away', number: 1, angle: 90 }).render(layer);
    // 볼은 공격수 중 랜덤한 한 명이 소유한 상태에서 시작 — 위치는 Holder 앞(posess offset)으로 snap
    const initialHolderIdx = Math.random() < 0.5 ? 0 : 1;
    const initialHolder = initialHolderIdx === 0 ? atkA : atkB;
    const ball = new Ball(initialHolder.x, initialHolder.y).render(layer);

    // 2. 모듈 생성
    const attPM = [new PlayerMovement(atkA, { driftScale: 0 }), new PlayerMovement(atkB, { driftScale: 0 })];
    const defPM = [new PlayerMovement(def1, { driftScale: 0 }), new PlayerMovement(def2, { driftScale: 0 })];
    const bm = new BallMovement(ball);
    const attDC = [new DribbleController(attPM[0], bm), new DribbleController(attPM[1], bm)];
    const defDC = [new DribbleController(defPM[0], bm), new DribbleController(defPM[1], bm)];
    const shot = new ShotMovement({ goalX: GOAL_X });
    // 슛 실행 공통 모듈 — 모든 슈팅 시나리오가 동일한 조준·오차·힘 모델을 쓴다
    const shotExec = new ShotExecution({ goalTopY: GOAL_TOP_Y, goalBotY: GOAL_BOTTOM_Y });
    const gkMovement = new GoalkeeperMovement({ goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y });
    const gkSave = new GoalkeeperSave({ goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y, skill: 0.7, diveSpeed: GK_DIVE_SPEED });

    // 수비 AI (협력 수비: 맨마킹 + 패스 차단) — 마킹은 골대-공격수 직선 골사이드
    const defenseAI = new CooperativeDefenseAI(
        [{ player: def1, movement: defPM[0] }, { player: def2, movement: defPM[1] }],
        { assignmentInterval: 0.25, retargetInterval: 0.15, pressHolder: true, goalX: GOAL_X, goalY: CENTER_Y },
    );

    // 공격 AI (패스·슈팅·드리블 협력 — 수비수 정보 전달)
    const attackAI = new AttackerTeamAI({
        players: [atkA, atkB],
        movements: attPM,
        dribbles: attDC,
        ballMovement: bm,
        defenders: [def1, def2],
        goalX: GOAL_X, centerY: CENTER_Y,
        shootMinX: SHOOT_MIN_X, shootMaxX: SHOOT_MAX_X,
        possessOffset: POSSESS_OFFSET,
        yMin: Y_MIN, yMax: Y_MAX,
    });

    // 3. 상태
    const PHASE = { ATTACK: 'attack', RETURN: 'return', LOOSE: 'loose', SHOOT: 'shoot' };
    let phase = PHASE.ATTACK;
    let complete = false;
    let currentContest = null;
    // 소유 전환 직후 태클 금지 시간 — 피탈자 스탠(모듈 0.2s)과 함께 재압박 ping-pong 방지
    let tackleCooldown = 0;

    // RETURN 템포 변수 — 수비 복귀 드리블·압박의 "일정 속도" 해소용
    let returnClock = 0;
    let carrierPause = 0, carrierPauseIn = rand(1.2, 2.6);
    let carrierRetarget = 0;
    let atkCoverRetarget = 0;
    let defCoverRetarget = 0;
    const carrierWeave = rand(-Math.PI, Math.PI);
    const pressWander = [rand(0, Math.PI * 2), rand(0, Math.PI * 2)];

    // GK 상태
    let gkTarget = { x: GK_START_X, y: GK_START_Y, facingAngle: 90 };
    let shooting = false;
    let gkDiving = false, gkReactionTimer = 0, gkDiveTargetX = 0, gkDiveTargetY = 0;
    let saveInfo = null, saveTimer = 0;

    // 지상 패스 차단·몸블록 (공용 모듈) — 수신자는 제외하고 모든 필드 선수에 적용
    const passInterceptor = new PassInterceptor(
        [atkA, atkB, def1, def2],
        [...attPM, ...defPM],
        bm,
        {
            controlSpeed: 160,
            onControl: (p) => {
                if (complete) return;
                // 가로채기 성공 → 기존 위상 전환 흐름 재사용 (모듈 조립)
                if (p.team === 'home') startAttack(p);
                else startDefendPossession(p);
            },
        },
    );

    // 4. 공통 함수
    function finish(result = null) {
        if (complete) return;
        complete = true;
        attDC.forEach(d => d.stop()); defDC.forEach(d => d.stop());
        attPM.forEach(p => p.stop()); defPM.forEach(p => p.stop());
        defenseAI.stop(); attackAI.stop(); passInterceptor.stop();
        if (currentContest) { currentContest.stop(); currentContest = null; }
        if (onComplete) onComplete(result);
    }

    function allSeparate() {
        const all = [atkA, atkB, def1, def2];
        for (let i = 0; i < all.length; i++)
            for (let j = i + 1; j < all.length; j++)
                BodyCollision.separate(all[i], all[j]);
    }

    function updateGK(dt) {
        gkTarget = gkMovement.update({ x: ball.x, y: ball.y, vx: bm.vx, vy: bm.vy }, goalkeeper);
        const dx = gkTarget.x - goalkeeper.x, dy = gkTarget.y - goalkeeper.y, d = Math.hypot(dx, dy);
        if (d > 1) { const s = Math.min(GK_POSITION_SPEED * dt, d); goalkeeper.setPosition(goalkeeper.x + (dx / d) * s, goalkeeper.y + (dy / d) * s); }
        goalkeeper.setAngle(gkTarget.facingAngle);
    }

    function handleGKSave(dt) {
        if (gkReactionTimer > 0) gkReactionTimer -= dt;
        if (gkDiving && gkReactionTimer <= 0) {
            const dx = gkDiveTargetX - goalkeeper.x, dy = gkDiveTargetY - goalkeeper.y, d = Math.hypot(dx, dy);
            if (d > 1) { const s = Math.min(GK_DIVE_SPEED * dt, d); goalkeeper.setPosition(goalkeeper.x + (dx / d) * s, goalkeeper.y + (dy / d) * s); }
            goalkeeper.setAngle(90);
        }
        if (saveInfo && !saveInfo.intercepted && ball.x >= saveInfo.savePointX - 5) {
            saveInfo.intercepted = true;
            const gd = Math.hypot(goalkeeper.x - saveInfo.savePointX, goalkeeper.y - saveInfo.savePointY);
            if (gd < gkSave.reachRadius) {
                const st = gkSave.determineSaveType(saveInfo.shotTrajectory, goalkeeper, { x: saveInfo.savePointX, y: saveInfo.savePointY });
                if (st !== SAVE_RESULT.GOAL) {
                    if (st === SAVE_RESULT.CATCH) { ball.setPosition(saveInfo.savePointX - 12, saveInfo.savePointY); ball.setHeight(0); }
                    else { const df = gkSave.calculateDeflection(st, { x: saveInfo.savePointX, y: saveInfo.savePointY }, saveInfo.shotTrajectory); ball.setPosition(saveInfo.savePointX - 8, saveInfo.savePointY); bm.release(df.vx, df.vy); }
                    saveTimer = 1.0; return true;
                }
            }
            saveInfo = null;
        }
        return false;
    }

    // 5. 공격 시작 (모듈 기반: possession 안정화 및 holder 일치)
    function startAttack(winner = null) {
        attDC.forEach(d => d.stop()); defDC.forEach(d => d.stop());
        attPM.forEach(p => p.stop()); defPM.forEach(p => p.stop());
        defenseAI.stop(); attackAI.stop();
        attackAI.start();
        // 루즈볼 경합 승리자가 홈팀이면 그 승리자를 홀더로 지정 (모듈의 setHolder로 일관 유지)
        if (winner && winner.team === 'home' && typeof winner.idx === 'number') {
            if (winner.idx !== attackAI.holderIdx) attackAI.setHolder(winner.idx);
        }
        const holder = attackAI.holder;
        bm.possess(holder, POSSESS_OFFSET); bm.snapToFront();
        attDC[attackAI.holderIdx].start();
        defenseAI.start();
        tackleCooldown = 0.45;
        phase = PHASE.ATTACK;
    }

    // 6. 수비수 볼 소유 → 복귀
    function startDefendPossession(winner) {
        attDC.forEach(d => d.stop()); defDC.forEach(d => d.stop());
        attPM.forEach(p => p.stop()); defPM.forEach(p => p.stop());
        defenseAI.stop(); attackAI.stop();
        const wi = winner.idx;
        bm.possess(winner, POSSESS_OFFSET); bm.snapToFront();
        defDC[wi].start(); defPM[wi].speed = SPEEDS[3];
        defPM[wi].moveTo(HALF_LINE_X, winner.y);
        const otherDef = defPM[1 - wi];
        otherDef.moveTo(winner.x - 60, clamp(winner.y + (Math.random() - 0.5) * 100, Y_MIN + 20, Y_MAX - 20));
        attPM.forEach(p => { p.speed = SPEEDS[2]; p.moveTo(bm.ball.x, bm.ball.y); });
        tackleCooldown = 0.45;
        phase = PHASE.RETURN;
    }

    // 7. 태클 → 포크(루즈볼 공방) 또는 스틸(수비 즉시 소유) — 모듈(PossessionContest)이 결정
    function startLoose(tackler) {
        attDC.forEach(d => d.stop()); defDC.forEach(d => d.stop());
        attPM.forEach(p => p.stop()); defPM.forEach(p => p.stop());
        defenseAI.stop(); attackAI.stop();
        const prevOwner = bm.owner;
        if (!prevOwner) { phase = PHASE.RETURN; return; }
        const pmA = prevOwner.team === 'home' ? attPM[prevOwner.idx] : defPM[prevOwner.idx];
        const pmB = tackler.team === 'home' ? attPM[tackler.idx] : defPM[tackler.idx];
        currentContest = new PossessionContest(prevOwner, pmA, tackler, pmB, bm, {
            pokeSpeed: 220, catchDistance: 16,
            stunDuration: 0.2, stealChance: 0.45,
        });
        // 스틸 시 모듈이 start() 안에서 동기적으로 onPossession을 부를 수 있으므로
        // phase는 콜백보다 먼저 LOOSE로 두고, 콜백이 위상을 덮어쓰도록 한다.
        phase = PHASE.LOOSE;
        currentContest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                currentContest = null;
                if (winner.team === 'home') startAttack(winner);
                else startDefendPossession(winner);
            },
        });
    }

    // 8. 슛 실행
    function fireShot() {
        const result = attackAI.tryShoot();
        if (!result || !result.fired) return false;
        const player = result.player;
        // 조준·오차·높이·힘은 ShotExecution 공통 모듈이 결정한다
        const plan = shotExec.plan({ ball, goalX: GOAL_X, shooter: player, defenders: [def1, def2] });
        const shotTargetY = plan.targetY;
        const height = plan;
        const targetAngle = angleTo(player.x, player.y, GOAL_X, shotTargetY);
        const shotSpeed = plan.speed;

        attPM[result.idx].stop(); attPM[result.idx].resetTurn(targetAngle); attPM[result.idx].setFacingTarget(targetAngle);
        attDC[result.idx].stop(); defenseAI.stop(); attackAI.stop();

        const fired = shot.shoot(bm, ShotExecution.toShootOptions(plan));
        if (!fired) { phase = PHASE.ATTACK; attackAI.start(); defenseAI.start(); return false; }

        const isOnTarget = plan.onTarget;
        if (isOnTarget) {
            const trajectory = { startX: ball.x, startY: ball.y, targetX: GOAL_X, targetY: shotTargetY, speed: shotSpeed, startHeight: height.targetHeight * 0.1, targetHeight: height.targetHeight, arcHeight: height.arcHeight };
            const ev = gkSave.evaluateSave(trajectory, goalkeeper);
            saveInfo = { shotTrajectory: trajectory, savePointX: Math.min(ev.savePointX, GOAL_X - 15), savePointY: ev.savePointY, canSave: ev.canSave, decidedResult: ev.result };
            gkReactionTimer = GK_REACTION_TIME; gkDiving = true;
            gkDiveTargetX = saveInfo.savePointX; gkDiveTargetY = ev.savePointY;
        } else { saveInfo = null; gkDiving = false; }
        phase = PHASE.SHOOT; shooting = true;
        return true;
    }

    // 9. 메인 루프
    function tick(dt) {
        if (complete) return;
        if (tackleCooldown > 0) tackleCooldown -= dt;

        if (phase !== PHASE.SHOOT) updateGK(dt);

        if (saveTimer > 0) { saveTimer -= dt; bm.update(dt); if (saveTimer <= 0) finish('save'); return; }

        // 슈팅 비행
        if (phase === PHASE.SHOOT) {
            if (handleGKSave(dt)) return;
            shot.update(dt);
            if (shot.result !== null) finish(shot.result === 'post-rebound' ? (saveInfo ? saveInfo.decidedResult : 'post') : shot.result);
            return;
        }

        // 루즈볼 — 공방 2인은 모듈(PossessionContest)이, 나머지 2인은 볼 추격으로 계속 움직임
        if (phase === PHASE.LOOSE) {
            if (currentContest) currentContest.update(dt);
            // 나머지 선수(공방 제외)도 서 있지 않게 볼 방향으로 이동
            const bystanders = [atkA, atkB, def1, def2].filter(p =>
                !(currentContest && (p === currentContest._a || p === currentContest._b)));
            for (const p of bystanders) {
                const pm = p.team === 'home' ? attPM[p.idx] : defPM[p.idx];
                pm.clearFacingTarget();
                pm.speed = SPEEDS[2];
                if (!pm.moving || Math.hypot(pm.player.x - ball.x, pm.player.y - ball.y) > 30) {
                    pm.moveTo(
                        clamp(ball.x + (Math.random() - 0.5) * 40, 0, GOAL_X),
                        clamp(ball.y + (Math.random() - 0.5) * 60, Y_MIN + 15, Y_MAX - 15)
                    );
                }
                pm.update(dt);
            }
            allSeparate();
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > 680) { finish('out'); return; }
            return;
        }

        // 복귀 (수비팀 볼 소유) — 일정 속도 문제 수정: 역할 분담 + 거리별 완급
        if (phase === PHASE.RETURN) {
            returnClock += dt;

            // 피탈 팀(홈) 수비 — 기존 SPEEDS[2] 일정 추격을 역할 기반으로 교체:
            //   가까운 선수 = 프레서 (멀면 스프린트, 근접하면 컨테인으로 감속)
            //   먼 선수     = 커버   (볼-자책골 사이 중앙 차단선을 조깅하며 구축)
            const press = Math.hypot(atkA.x - ball.x, atkA.y - ball.y)
                        <= Math.hypot(atkB.x - ball.x, atkB.y - ball.y) ? atkA : atkB;
            const coverAtk = press.idx === 0 ? atkB : atkA;
            const pressPM = attPM[press.idx], coverAPM = attPM[coverAtk.idx];

            const pd = Math.hypot(press.x - ball.x, press.y - ball.y);
            if (pd > 92) {
                // 인터셉트 지점 예측 추격 (마찰 감속 반영)
                const bs = Math.hypot(bm.vx, bm.vy);
                const tLead = Math.min(pd / 150, bs > 1 ? bs / 380 : 0, 0.55);
                pressPM.clearFacingTarget();
                pressPM.speed = pd > 220 ? SPEEDS[4] : SPEEDS[3];
                pressPM.moveTo(
                    clamp(ball.x + bm.vx * tLead * 0.65, 15, GOAL_X - 20),
                    clamp(ball.y + bm.vy * tLead * 0.65, Y_MIN + 12, Y_MAX - 12)
                );
            } else {
                // 모듈 개선: 볼 돌입 — 이전 호버링(볼-24 유지)은 태클 판정 반경(19)에
                // 영원히 못 들어가 패시브 수비처럼 보였다. 접근 구간부터 볼 중심 직행으로
                // 실제 태클(isTackle)을 성사시키고, 초근접에서는 속도를 낮춰 정확히 붙는다.
                pressPM.clearFacingTarget();
                pressPM.speed = pd < 38 ? SPEEDS[3] : SPEEDS[4];
                pressPM.moveTo(
                    clamp(ball.x - Math.min(pd * 0.25, 10), 15, GOAL_X - 10),
                    clamp(ball.y + Math.sin(returnClock * 3.1 + pressWander[press.idx]) * 6, Y_MIN + 15, Y_MAX - 15)
                );
            }

            atkCoverRetarget -= dt;
            if (!coverAPM.moving || atkCoverRetarget <= 0) {
                atkCoverRetarget = 0.45;
                const cx = clamp(ball.x - 135, 30, GOAL_X - 200);
                const cy = clamp(
                    CENTER_Y * 0.55 + ball.y * 0.45 + Math.sin(returnClock * 1.4 + pressWander[coverAtk.idx]) * 38,
                    Y_MIN + 30, Y_MAX - 30
                );
                coverAPM.clearFacingTarget();
                const cd = Math.hypot(coverAtk.x - cx, coverAtk.y - cy);
                coverAPM.speed = cd > 190 ? SPEEDS[3] : SPEEDS[2];
                coverAPM.moveTo(cx, cy);
            }

            // 루즈볼(수비끼리 패스 포함) — 두 수비수도 볼로 직행해 방치 없음
            if (!bm.owner && !bm.isAerial && !bm.isBouncing) {
                [def1, def2].forEach((d, i) => {
                    const pm = defPM[i];
                    const dd = Math.hypot(d.x - ball.x, d.y - ball.y);
                    pm.clearFacingTarget();
                    pm.speed = dd > 160 ? SPEEDS[4] : dd > 70 ? SPEEDS[3] : SPEEDS[2];
                    pm.moveTo(
                        clamp(ball.x + bm.vx * 0.2, 0, GOAL_X),
                        clamp(ball.y + bm.vy * 0.2, Y_MIN + 12, Y_MAX - 12)
                    );
                });
            }

            attPM.forEach(p => p.update(dt)); attDC.forEach(d => d && d.update(dt));
            defPM.forEach(p => p.update(dt)); defDC.forEach(d => d && d.update(dt));
            bm.update(dt); bm.snapToFront();
            // 지상 패스 차단·몸블록 — 수비 투톱 패스도 공격수가 컷인 가능
            passInterceptor.exclude = null;
            if (passInterceptor.update(dt)) { allSeparate(); return; }
            const di = defDC[0].ballAttached ? 0 : (defDC[1].ballAttached ? 1 : -1);
            if (di >= 0) {
                if (def1.x <= HALF_LINE_X + 20 || def2.x <= HALF_LINE_X + 20) { finish('defend'); return; }
                const oi = 1 - di;
                const defs = [def1, def2];
                if (defs[oi].x < defs[di].x - 30 && Math.random() < 0.02) {
                    PassMovement.shortPass(bm, defs[oi].x, defs[oi].y, { arriveSpeed: 130 });
                    defDC[di].stop();
                }
                // ── 캐리어 완급 조절: 기존 SPEEDS[3] 고정 → 압박·사인 파동·순간 정지 ──
                const holderDef = defs[di];
                const carrierPM = defPM[di];
                let nearAtkD = Infinity;
                for (const atk of [atkA, atkB]) {
                    nearAtkD = Math.min(nearAtkD, Math.hypot(atk.x - holderDef.x, atk.y - holderDef.y));
                }
                carrierPauseIn -= dt;
                if (carrierPauseIn <= 0) { carrierPause = rand(0.15, 0.35); carrierPauseIn = rand(1.3, 2.7); }
                if (carrierPause > 0) {
                    // 템포 끊기 — 발밑 공 잠깐 조질
                    carrierPause -= dt;
                    carrierPM.speed = SPEEDS[0];
                    carrierPM.moveTo(Math.max(HALF_LINE_X, holderDef.x - 10), holderDef.y);
                } else {
                    carrierRetarget -= dt;
                    if (!carrierPM.moving || carrierRetarget <= 0) {
                        carrierRetarget = 0.32;
                        // 하프라인 방향 진행 + 사인 궤적 좌우 우회
                        const wy = holderDef.y + Math.sin(returnClock * 1.8 + carrierWeave) * 30;
                        carrierPM.clearFacingTarget();
                        carrierPM.moveTo(
                            Math.max(HALF_LINE_X - 5, holderDef.x - 120),
                            clamp(wy, Y_MIN + 40, Y_MAX - 40)
                        );
                    }
                    const wave = (Math.sin(returnClock * 2.4 + carrierWeave) + 1) / 2;
                    carrierPM.speed = nearAtkD < 92 ? SPEEDS[4]
                                    : nearAtkD < 150 ? SPEEDS[3]
                                    : (wave > 0.66 ? SPEEDS[3] : SPEEDS[2]);
                }
                // 동료 수비 커버 — 볼 소유자 뒤(골 방향) 느슨한 산책 템포로 위치 구축
                const otherPM = defPM[oi];
                defCoverRetarget -= dt;
                if (!otherPM.moving || defCoverRetarget <= 0) {
                    defCoverRetarget = 0.5;
                    const lx = holderDef.x + 44 + Math.sin(returnClock * 1.2 + carrierWeave * 2) * 16;
                    const ly = holderDef.y + (Math.random() - 0.5) * 74;
                    otherPM.clearFacingTarget();
                    const lgd = Math.hypot(otherPM.player.x - lx, otherPM.player.y - ly);
                    otherPM.speed = lgd > 180 ? SPEEDS[3] : (lgd > 80 ? SPEEDS[2] : SPEEDS[1]);
                    otherPM.moveTo(clamp(lx, 0, GOAL_X), clamp(ly, Y_MIN + 25, Y_MAX - 25));
                }
            }
            allSeparate();
            // 쿨다운 경과 후에만 태클 판정 — 소유 전환 직후 재압박 ping-pong 방지
            if (tackleCooldown <= 0) {
                for (const atk of [atkA, atkB]) for (const def of [def1, def2])
                    if (bm.owner && bm.owner.team === 'away' && CollisionSystem.isTackle(atk, ball)) { startLoose(atk); return; }
            }
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > 680) { finish('out'); return; }
            return;
        }

        // 공격
        if (phase !== PHASE.ATTACK) return;
        attPM.forEach(p => p.update(dt)); attDC.forEach(d => d && d.update(dt));
        bm.update(dt);
        // 지상 패스 차단·몸블록 — 지정 수신자 제외, 나머지 전원 판정
        const rIdx = attackAI.receivingIdx;
        passInterceptor.exclude = rIdx >= 0 ? [atkA, atkB][rIdx] : null;
        if (passInterceptor.update(dt)) { allSeparate(); return; }
        defenseAI.update(dt, {
            ball,
            ballVelocity: { x: bm.vx, y: bm.vy },
            attackers: [atkA, atkB],
            attackerMovements: attPM,
            holder: attackAI.holder,
            receiver: attackAI.state === 'passing' ? attackAI.support : null,
            inFlight: bm.isAerial || bm.isBouncing,
            goal: { x: GOAL_X, y: CENTER_Y },
        });

        const evt = attackAI.update(dt);
        if (evt && evt.action === 'pass') {
            // 패스 실행 시 홀더(패서)만 정지 — 수령은 AI 내부 BallReception이 처리
            attPM[evt.data.from].stop(); attDC[evt.data.from].stop();
        }

        allSeparate();

        // 태클 확인 — 쿨다운 경과 후에만 (소유 전환 직후 즉시 재태클 방지)
        if (tackleCooldown <= 0) {
            for (const def of [def1, def2]) {
                if (bm.owner && bm.owner.team === 'home' && CollisionSystem.isTackle(def, ball)) {
                    startLoose(def); return;
                }
            }
        }
        if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > 680) { finish('out'); return; }

        // 슈팅
        if (attackAI.ballAttached && attackAI.canShoot) fireShot();
    }

    // 10. 시작 (랜덤 홀더가 볼 소유)
    attackAI.start();
    if (initialHolderIdx !== 0) attackAI.setHolder(initialHolderIdx);
    bm.possess(initialHolder, POSSESS_OFFSET); bm.snapToFront();
    attDC[initialHolderIdx].start();
    defenseAI.start();
    passInterceptor.start();
    phase = PHASE.ATTACK;

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        attDC.forEach(d => d.stop()); defDC.forEach(d => d.stop());
        attPM.forEach(p => p.stop()); defPM.forEach(p => p.stop());
        defenseAI.stop(); attackAI.stop(); passInterceptor.stop();
        if (currentContest) currentContest.stop();
    };
}
