/**
 * TwoVsTwo - 2:2 대결 시나리오
 *
 * 모듈 조립 방식: 시나리오는 엔티티 생성과 모듈 연결만 담당한다.
 *
 * 배치:
 *   공격수A(빨강, 9번)  – 하프라인 중앙 (525, 340), 볼 소유
 *   공격수B(빨강, 10번) – 왼쪽 아래 (325, 460)
 *   수비수1(파랑, 4번)  – 오른쪽 30m (825, 280)
 *   수비수2(파랑, 5번)  – 오른쪽 30m 아래 (825, 400)
 *   골키퍼(파랑, 1번)   – 오른쪽 골대 (1030, 340)
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

const SHOOT_MIN_X = GOAL_X - 300;
const SHOOT_MAX_X = GOAL_X - 165;

const GK_START_X = GOAL_X - 20;
const GK_START_Y = CENTER_Y;
const GK_POSITION_SPEED = 350;
const GK_DIVE_SPEED = 500;
const GK_REACTION_TIME = 0.1;

const SPEEDS = PlayerMovement.SPEEDS;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function randomAimY() {
    const r = Math.random();
    if (r < 0.04) return GOAL_TOP_Y - 1 + Math.random() * 3;
    if (r < 0.08) return GOAL_BOTTOM_Y - 1 + Math.random() * 3;
    if (r < 0.18) return GOAL_TOP_Y - 11 + Math.random() * 3;
    if (r < 0.28) return GOAL_BOTTOM_Y + 8 + Math.random() * 3;
    return GOAL_TOP_Y + 9 + Math.random() * (GOAL_BOTTOM_Y - GOAL_TOP_Y - 18);
}

function randomShotHeight() {
    const r = Math.random();
    if (r < 0.32) return { targetHeight: 0.06, arcHeight: 0.08 };
    if (r < 0.78) return { targetHeight: 0.35 + Math.random() * 1.35, arcHeight: 0.15 + Math.random() * 0.2 };
    if (r < 0.82) return { targetHeight: 2.32 + Math.random() * 0.1, arcHeight: 0.06 };
    return { targetHeight: 2.65 + Math.random() * 0.35, arcHeight: 0.08, overBar: true };
}

// ── 시나리오 ──────────────────────────────────────────
export function run(layer, loop, onComplete = null) {

    // 1. 엔티티 생성
    const atkA = new Player({ x: CENTER_X, y: CENTER_Y, team: 'home', number: 9,  angle: -90 }).render(layer);
    const atkB = new Player({ x: CENTER_X - 200, y: CENTER_Y + 120, team: 'home', number: 10, angle: -90 }).render(layer);
    atkA.idx = 0; atkB.idx = 1;

    const def1 = new Player({ x: 825, y: 280, team: 'away', number: 4, angle: 90 }).render(layer);
    const def2 = new Player({ x: 825, y: 400, team: 'away', number: 5, angle: 90 }).render(layer);
    def1.idx = 0; def2.idx = 1;

    const goalkeeper = new Player({ x: GK_START_X, y: GK_START_Y, team: 'away', number: 1, angle: 90 }).render(layer);
    const ball = new Ball(atkA.x, atkA.y).render(layer);

    // 2. 모듈 생성
    const attPM = [new PlayerMovement(atkA, { driftScale: 0 }), new PlayerMovement(atkB, { driftScale: 0 })];
    const defPM = [new PlayerMovement(def1, { driftScale: 0 }), new PlayerMovement(def2, { driftScale: 0 })];
    const bm = new BallMovement(ball);
    const attDC = [new DribbleController(attPM[0], bm), new DribbleController(attPM[1], bm)];
    const defDC = [new DribbleController(defPM[0], bm), new DribbleController(defPM[1], bm)];
    const shot = new ShotMovement({ goalX: GOAL_X });
    const gkMovement = new GoalkeeperMovement({ goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y });
    const gkSave = new GoalkeeperSave({ goalX: GOAL_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOTTOM_Y, skill: 0.7, diveSpeed: GK_DIVE_SPEED });

    // 수비 AI (협력 수비: 맨마킹 + 패스 차단)
    const defenseAI = new CooperativeDefenseAI(
        [{ player: def1, movement: defPM[0] }, { player: def2, movement: defPM[1] }],
        { assignmentInterval: 0.25, retargetInterval: 0.15, pressHolder: true },
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

    // GK 상태
    let gkTarget = { x: GK_START_X, y: GK_START_Y, facingAngle: 90 };
    let shooting = false;
    let gkDiving = false, gkReactionTimer = 0, gkDiveTargetX = 0, gkDiveTargetY = 0;
    let saveInfo = null, saveTimer = 0;

    // 4. 공통 함수
    function finish(result = null) {
        if (complete) return;
        complete = true;
        attDC.forEach(d => d.stop()); defDC.forEach(d => d.stop());
        attPM.forEach(p => p.stop()); defPM.forEach(p => p.stop());
        defenseAI.stop(); attackAI.stop();
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

    // 5. 공격 시작
    function startAttack() {
        attDC.forEach(d => d.stop()); defDC.forEach(d => d.stop());
        attPM.forEach(p => p.stop()); defPM.forEach(p => p.stop());
        defenseAI.stop();
        const holder = attackAI.holder;
        bm.possess(holder, POSSESS_OFFSET); bm.snapToFront();
        attDC[attackAI.holderIdx].start();
        attackAI.start();
        defenseAI.start();
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
        phase = PHASE.RETURN;
    }

    // 7. 루즈볼 → 소유 결정
    function startLoose(tackler) {
        attDC.forEach(d => d.stop()); defDC.forEach(d => d.stop());
        attPM.forEach(p => p.stop()); defPM.forEach(p => p.stop());
        defenseAI.stop(); attackAI.stop();
        const prevOwner = bm.owner;
        if (!prevOwner) { phase = PHASE.RETURN; return; }
        const pmA = prevOwner.team === 'home' ? attPM[prevOwner.idx] : defPM[prevOwner.idx];
        const pmB = tackler.team === 'home' ? attPM[tackler.idx] : defPM[tackler.idx];
        currentContest = new PossessionContest(prevOwner, pmA, tackler, pmB, bm, { pokeSpeed: 220, catchDistance: 16 });
        currentContest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                currentContest = null;
                if (winner.team === 'home') startAttack();
                else startDefendPossession(winner);
            },
        });
        phase = PHASE.LOOSE;
    }

    // 8. 슛 실행
    function fireShot() {
        const result = attackAI.tryShoot();
        if (!result || !result.fired) return false;
        const player = result.player;
        const targetY = randomAimY();
        const height = randomShotHeight();
        const isSideAim = targetY < GOAL_TOP_Y || targetY > GOAL_BOTTOM_Y;
        const shotTargetY = height.overBar && !isSideAim ? GOAL_TOP_Y + 20 : targetY;
        const targetAngle = angleTo(player.x, player.y, GOAL_X, shotTargetY);
        const shotSpeed = 520 + Math.random() * 80;

        attPM[result.idx].stop(); attPM[result.idx].resetTurn(targetAngle); attPM[result.idx].setFacingTarget(targetAngle);
        attDC[result.idx].stop(); defenseAI.stop(); attackAI.stop();

        const fired = shot.shoot(bm, { targetY: shotTargetY, targetHeight: height.targetHeight, arcHeight: height.arcHeight, speed: shotSpeed });
        if (!fired) { phase = PHASE.ATTACK; attackAI.start(); defenseAI.start(); return false; }

        const isOnTarget = shotTargetY >= GOAL_TOP_Y && shotTargetY <= GOAL_BOTTOM_Y;
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

        if (phase !== PHASE.SHOOT) updateGK(dt);

        if (saveTimer > 0) { saveTimer -= dt; bm.update(dt); if (saveTimer <= 0) finish('save'); return; }

        // 슈팅 비행
        if (phase === PHASE.SHOOT) {
            if (handleGKSave(dt)) return;
            shot.update(dt);
            if (shot.result !== null) finish(shot.result === 'post-rebound' ? (saveInfo ? saveInfo.decidedResult : 'post') : shot.result);
            return;
        }

        // 루즈볼
        if (phase === PHASE.LOOSE) {
            if (currentContest) currentContest.update(dt);
            allSeparate();
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > 680) { finish('out'); return; }
            return;
        }

        // 복귀 (수비팀 볼 소유)
        if (phase === PHASE.RETURN) {
            attPM.forEach(p => p.update(dt)); attDC.forEach(d => d && d.update(dt));
            defPM.forEach(p => p.update(dt)); defDC.forEach(d => d && d.update(dt));
            bm.update(dt); bm.snapToFront();
            const di = defDC[0].ballAttached ? 0 : (defDC[1].ballAttached ? 1 : -1);
            if (di >= 0) {
                if (def1.x <= HALF_LINE_X + 20 || def2.x <= HALF_LINE_X + 20) { finish('defend'); return; }
                const oi = 1 - di;
                const defs = [def1, def2];
                if (defs[oi].x < defs[di].x - 30 && Math.random() < 0.02) {
                    PassMovement.shortPass(bm, defs[oi].x, defs[oi].y, { arriveSpeed: 130 });
                    defDC[di].stop();
                }
            }
            allSeparate();
            for (const atk of [atkA, atkB]) for (const def of [def1, def2])
                if (bm.owner && bm.owner.team === 'away' && CollisionSystem.isTackle(atk, ball)) { startLoose(atk); return; }
            if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > 680) { finish('out'); return; }
            return;
        }

        // 공격
        if (phase !== PHASE.ATTACK) return;
        attPM.forEach(p => p.update(dt)); attDC.forEach(d => d && d.update(dt));
        bm.update(dt);
        defenseAI.update(dt, { ball, ballVelocity: { x: bm.vx, y: bm.vy }, attackers: [atkA, atkB], holder: attackAI.holder, inFlight: false });

        const evt = attackAI.update(dt);
        if (evt && evt.action === 'pass') {
            // 패스 실행 시 홀더(패서)만 정지 — 수령은 AI 내부 BallReception이 처리
            attPM[evt.data.from].stop(); attDC[evt.data.from].stop();
        }

        allSeparate();

        // 태클 확인
        for (const def of [def1, def2]) {
            if (bm.owner && bm.owner.team === 'home' && CollisionSystem.isTackle(def, ball)) {
                startLoose(def); return;
            }
        }
        if (ball.x < 0 || ball.x > GOAL_X || ball.y < 0 || ball.y > 680) { finish('out'); return; }

        // 슈팅
        if (attackAI.ballAttached && attackAI.canShoot) fireShot();
    }

    // 10. 시작
    attackAI.start();
    bm.possess(atkA, POSSESS_OFFSET); bm.snapToFront();
    attDC[0].start();
    attPM[0].speed = SPEEDS[3]; attPM[0].moveTo(GOAL_X - 180, CENTER_Y);
    attPM[1].speed = SPEEDS[3]; attPM[1].moveTo(SHOOT_MIN_X - 50, CENTER_Y + 100);
    defenseAI.start();
    phase = PHASE.ATTACK;

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        attDC.forEach(d => d.stop()); defDC.forEach(d => d.stop());
        attPM.forEach(p => p.stop()); defPM.forEach(p => p.stop());
        defenseAI.stop(); attackAI.stop();
        if (currentContest) currentContest.stop();
    };
}
