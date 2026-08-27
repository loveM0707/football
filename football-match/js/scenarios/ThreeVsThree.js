/**
 * ThreeVsThree - 3:3 실전형 매치 시나리오
 *
 * 양 팀 모두 골키퍼를 보유한 실제 경기 형태:
 *   홈(빨강, 7/9/11번 + GK 1번) – 왼쪽 골 수비, 오른쪽 골 공격
 *   원정(파랑, 4/6/8번  + GK 1번) – 오른쪽 골 수비, 왼쪽 골 공격
 *
 * 경기 흐름:
 *   - 세이브·포스트 맞음 후에도 경기 지속 (GK 캐치 → 배급, 파리 → 루즈볼)
 *   - 종료 조건은 골('goal')과 라인 아웃('out')뿐
 *   - 레인(상/중/하) 분담으로 공간 활용 — 선수 간 뭉침 방지
 *   - 공격은 패스 중심, 압박 상황에서 롱패스,
 *     측면 침투 시 크로스 → 박스에서 헤딩슛 (공중볼 경합 포함)
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
import { PassMovement }      from '../movement/PassMovement.js';
import { PassInterceptor }   from '../movement/PassInterceptor.js';
import { ShotMovement }      from '../movement/ShotMovement.js';
import { GoalkeeperMovement } from '../movement/GoalkeeperMovement.js';
import { GoalkeeperSave, SAVE_RESULT } from '../movement/GoalkeeperSave.js';
import { BallReception }     from '../movement/BallReception.js';
import { HeadingShot }       from '../movement/HeadingShot.js';

// ── 상수 ──────────────────────────────────────────────
const GOAL_R_X      = 1050;
const GOAL_L_X      = 0;
const GOAL_TOP_Y    = 303.4;
const GOAL_BOT_Y    = 376.6;
const CENTER_X      = 525;
const CENTER_Y      = 340;
const Y_MIN         = 45;
const Y_MAX         = 635;
const FIELD_TOP     = 0;
const FIELD_BOTTOM  = 680;
const POSSESS_OFFSET = Player.BODY_RADIUS + Ball.RADIUS + 4;

// 슈팅 허용 구간 — 골 전방 6~23m
const SHOOT_RANGE = 230;

// 레인(상·중·하) y 좌표 — 팀원 간 폭 확보의 기준
const LANE_Y = [168, 340, 512];

const GK_DIVE_SPEED     = 500;
const GK_POSITION_SPEED = 350;
const GK_REACTION_TIME  = 0.1;

const SPEEDS = PlayerMovement.SPEEDS;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

function randomAimY() {
    const r = Math.random();
    if (r < 0.02) return GOAL_TOP_Y - 1 + Math.random() * 3;
    if (r < 0.04) return GOAL_BOT_Y - 1 + Math.random() * 3;
    if (r < 0.07) return GOAL_TOP_Y - 11 + Math.random() * 3;
    if (r < 0.10) return GOAL_BOT_Y + 8 + Math.random() * 3;
    return GOAL_TOP_Y + 9 + Math.random() * (GOAL_BOT_Y - GOAL_TOP_Y - 18);
}

function randomShotHeight() {
    const r = Math.random();
    if (r < 0.40) return { targetHeight: 0.06, arcHeight: 0.08 };
    if (r < 0.88) return { targetHeight: 0.35 + Math.random() * 1.3, arcHeight: 0.15 + Math.random() * 0.2 };
    if (r < 0.94) return { targetHeight: 2.32 + Math.random() * 0.1, arcHeight: 0.06 }; // 크로스바 직하
    return { targetHeight: 2.55 + Math.random() * 0.35, arcHeight: 0.08, overBar: true };
}

/** 지점-선분 최단 거리 (패스 레인 개방 판정) */
function distToSegment(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

// ── 시나리오 ──────────────────────────────────────────
export function run(layer, loop, onComplete = null) {

    // 시작 팀 코인토스
    const kickoffIdx = Math.random() < 0.5 ? 0 : 1;

    // ── 1. 볼 먼저 생성 (DribbleController 주입용) ──
    const ball = new Ball(CENTER_X, CENTER_Y).render(layer);
    const bm = new BallMovement(ball);

    // ── 2. 팀 생성: GK + 아웃필드 3인 ──
    function makeTeam(cfg) {
        const ps = cfg.spots.map((s, i) => new Player({
            x: s.x, y: s.y, team: cfg.teamName, number: cfg.numbers[i], angle: cfg.angle,
        }).render(layer));
        const gk = new Player({
            x: cfg.gkX, y: CENTER_Y, team: cfg.teamName, number: 1, angle: cfg.angle,
        }).render(layer);
        const movements = ps.map(m => new PlayerMovement(m, { driftScale: 0 }));
        const dribbles  = movements.map(m => new DribbleController(m, bm));
        const gkGoalX = cfg.dir > 0 ? GOAL_L_X : GOAL_R_X; // 자기 골라인
        return {
            name: cfg.teamName,
            dir: cfg.dir,
            attackGoalX: cfg.dir > 0 ? GOAL_R_X : GOAL_L_X,
            ownGoalX: gkGoalX,
            players: ps,
            movements,
            dribbles,
            gk,
            // 위치 모듈은 항상 오른골 기하(GOAL_R_X)로 생성 — 왼골 수비는
            // gkPositionTarget에서 거울 좌표 변환으로 대응 (모듈 내부 로직 단일화)
            gkMovement: new GoalkeeperMovement({
                goalX: GOAL_R_X, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOT_Y, goalCenterY: CENTER_Y,
            }),
            gkSave: new GoalkeeperSave({
                goalX: gkGoalX, goalTopY: GOAL_TOP_Y, goalBottomY: GOAL_BOT_Y,
                skill: 0.62, diveSpeed: 460, reachRadius: 21,
            }),
            lanes: cfg.lanes,
        };
    }

    const homeSpots = [
        { x: rand(250, 400), y: rand(140, 205) },   // 윙(상)
        { x: rand(160, 300), y: rand(300, 380) },   // 중앙(깊이)
        { x: rand(250, 400), y: rand(475, 540) },   // 윙(하)
    ];
    const awaySpots = homeSpots.map(s => ({ x: GOAL_R_X - s.x, y: FIELD_BOTTOM - s.y }));

    const home = makeTeam({ teamName: 'home', dir: 1,  angle: -90, spots: homeSpots, numbers: [7, 9, 11], lanes: [0, 1, 2], gkX: 22 });
    // awaySpots는 y 반전 미러이므로 레인도 상하 교차 ([2,1,0])
    const away = makeTeam({ teamName: 'away', dir: -1, angle: 90,  spots: awaySpots, numbers: [4, 6, 8],  lanes: [2, 1, 0], gkX: GOAL_R_X - 22 });
    const teams = [home, away];
    home.opp = away; away.opp = home;

    // 수비 AI — 팀별 3인 협력수비 (PRESS / LANE_BLOCK / MARK)
    for (const t of teams) {
        t.defenseAI = new CooperativeDefenseAI(
            t.players.map((p, i) => ({ player: p, movement: t.movements[i] })),
            {
                assignmentInterval: 0.28, retargetInterval: 0.18,
                pressHolder: false, goalX: t.ownGoalX, goalY: CENTER_Y,
                markDistance: 34,
            },
        );
        t.receptions = t.players.map((p, i) =>
            new BallReception(p, t.movements[i], bm, { maxBallSpeed: 215 }));
        t.defenseAI.start();
    }

    // 지상 패스 차단·몸블록 — GK 제외 전원
    const allField = [...home.players, ...away.players];
    const allFieldPM = [...home.movements, ...away.movements];
    const interceptor = new PassInterceptor(allField, allFieldPM, bm, {
        controlSpeed: 160,
        onControl: (p) => {
            if (complete) return;
            const u = findUnit(p);
            if (u) startOpen(u.team, u.idx);
        },
    });
    interceptor.start();

    // 슛 모듈은 발사 때마다 새 인스턴스 — 세이브로 조기 위상 탈퇴 시
    // 잔존 active 상태가 다음 슛을 평생 막는 문제(모듈 재사용 함정) 방지
    // HeadingShot은 목표 골대 X에 따라 편차 계산이 달라지므로(내부 _goalX) 전역
    // 인스턴스를 재사용하면 좌측 골 헤더가 오른골 기준으로 과대 편차
    // → 팀별로 인스턴스를 분기하거나 호출마다 생성한다.

    // ── 3. 상태 ──
    const PHASE = {
        OPEN: 'open', PASSING: 'passing', CONTEST: 'contest',
        LOOSE: 'loose', SHOT: 'shot', GKDISTRIB: 'gkd',
    };
    let phase = PHASE.OPEN;
    let complete = false;

    let posTeam = teams[kickoffIdx];
    let posIdx = 1;
    let lastTouchTeam = posTeam;

    let tackleCooldown = 0.5;
    let kickTimer = 1.0;
    let passHold = 0;
    let posElapsed = 0;              // 현재 소유 에피소드 지속 시간
    let pressTimer = 0;              // 지속 압박 누적 (긴급 탈출 트리거)
    let stallTimer = 0;              // 슛·크로스·배급 없는 정체 누적 (전역 밸브)
    let escapeStreak = 0;            // 연속 강제 탈출 패스 수 — 사다리 상향 트리거

    let passCtx = null;              // { type:'short'|'long'|'gk', team, recIdx, elapsed }
    let crossCtx = null;             // { team, headIdx, resolved }
    let shotCtx = null;              // { team, defTeam, dirSign }
    let contest = null;

    const gkState = teams.map(() => ({
        diveTargetX: null, diveTargetY: 0, diveTimer: 0, reactT: 0,
        saveInfo: null, distribT: 0,
    }));

    let clock = 0;
    const weave = [[rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)], [rand(0, 6.28), rand(0, 6.28), rand(0, 6.28)]];
    const carrierState = { retargetT: 0 };

    // ── 공통 유틸 ──
    function findUnit(p) {
        for (const t of teams) {
            const i = t.players.indexOf(p);
            if (i >= 0) return { team: t, idx: i };
        }
        return null;
    }
    const otherTeam = (t) => t.opp;

    /** 수비 AI는 stop() 후 재사용 시 반드시 start() 필요 — 위상 전환마다 보장 */
    function ensureDefense(defTeam) { defTeam.defenseAI.start(); }

    function stopAllFieldControls() {
        for (const t of teams) {
            t.dribbles.forEach(d => d.stop());
            t.receptions.forEach(r => r.stop());
            t.movements.forEach(m => m.stop());
        }
    }

    function finish(result = null) {
        if (complete) return;
        complete = true;
        for (const t of teams) {
            t.dribbles.forEach(d => d.stop());
            t.movements.forEach(m => m.stop());
            t.defenseAI.stop();
            t.receptions.forEach(r => r.stop());
        }
        interceptor.stop();
        if (contest) { contest.stop(); contest = null; }
        if (onComplete) onComplete(result);
    }

    function allSeparate() {
        const all = [...allField, home.gk, away.gk];
        for (let i = 0; i < all.length; i++)
            for (let j = i + 1; j < all.length; j++)
                BodyCollision.separate(all[i], all[j]);
    }

    function outOfBounds() {
        return ball.x < GOAL_L_X || ball.x > GOAL_R_X || ball.y < FIELD_TOP || ball.y > FIELD_BOTTOM;
    }

    function nearestOf(team, x, y) {
        let best = 0, bd = Infinity;
        for (let k = 0; k < 3; k++) {
            const d = Math.hypot(team.players[k].x - x, team.players[k].y - y);
            if (d < bd) { bd = d; best = k; }
        }
        return { idx: best, p: team.players[best] };
    }

    function nearestLane(y) {
        let bi = 0, bd = Infinity;
        for (let l = 0; l < 3; l++) {
            const d = Math.abs(LANE_Y[l] - y);
            if (d < bd) { bd = d; bi = l; }
        }
        return bi;
    }

    /** 공중볼 예상 착지점 — 공중·바운드 외에는 null */
    function landingPoint() {
        if (bm.isAerial) {
            const rem = bm._aerialDuration - bm._aerialTimer;
            if (rem <= 0.02) return null;
            return { x: ball.x + bm._aerialVx * rem, y: ball.y + bm._aerialVy * rem };
        }
        if (bm.isBouncing) {
            const bnc = bm._bounce;
            if (!bnc) return null;
            const rem = bnc.duration - bnc.timer;
            if (rem <= 0.02) return null;
            return { x: ball.x + bnc.vx * rem, y: ball.y + bnc.vy * rem };
        }
        return null;
    }

    // ── 소유 확정 → 오픈 플레이 ──
    function startOpen(team, idx) {
        stopAllFieldControls();
        passCtx = null;
        crossCtx = null;
        shotCtx = null;
        posTeam = team;
        posIdx = idx;
        lastTouchTeam = team;
        bm.possess(team.players[idx], POSSESS_OFFSET);
        bm.snapToFront();
        team.dribbles[idx].start();
        ensureDefense(otherTeam(team));
        tackleCooldown = 0.5;
        kickTimer = rand(0.85, 1.4);
        passHold = 0.45;
        posElapsed = 0;
        pressTimer = 0;
        escapeStreak = 0;
        carrierState.retargetT = 0;
        phase = PHASE.OPEN;
    }

    // ── 태클 → PossessionContest ──
    function startLooseFromTackle(tackler) {
        stopAllFieldControls();
        const prevOwner = bm.owner ?? posTeam.players[posIdx];
        const prevUnit = findUnit(prevOwner);
        const tackUnit = findUnit(tackler);
        if (!prevUnit || !tackUnit) { enterLoose(); return; }
        contest = new PossessionContest(
            prevOwner, prevUnit.team.movements[prevUnit.idx],
            tackler, tackUnit.team.movements[tackUnit.idx],
            bm, { pokeSpeed: 150, catchDistance: 16, stunDuration: 0.2, stealChance: 0.45 },
        );
        lastTouchTeam = prevUnit.team;
        phase = PHASE.CONTEST; // 동기 콜백보다 먼저 위상 확정
        contest.start(tackler, {
            onPossession: (winner) => {
                if (complete) return;
                contest = null;
                const u = findUnit(winner);
                if (u) startOpen(u.team, u.idx);
                else enterLoose();
            },
        });
    }

    // ── 자유볼 진입 ──
    function enterLoose() {
        stopAllFieldControls();
        passCtx = null;
        crossCtx = null;
        shotCtx = null;
        posTeam = null;
        phase = PHASE.LOOSE;
    }

    // ── 4. 캐리어 드리블 ──
    function carrierControl(dt) {
        const t = posTeam, i = posIdx;
        const p = t.players[i], pm = t.movements[i];
        const opp = otherTeam(t);
        const ti = teams.indexOf(t);
        const goalDist = Math.abs(t.attackGoalX - p.x);

        let presser = null, pressD = Infinity;
        for (const o of opp.players) {
            const d = Math.hypot(o.x - p.x, o.y - p.y);
            if (d < pressD) { pressD = d; presser = o; }
        }

        carrierState.retargetT -= dt;
        // 경계 방어 — 공을 몰고 라인 밖으로 나가는 자책 아웃 차단
        const EDGE = 52;
        const nearEdgeX = p.x < EDGE || p.x > GOAL_R_X - EDGE;
        const nearEdgeY = p.y < EDGE || p.y > FIELD_BOTTOM - EDGE;
        if (nearEdgeX || nearEdgeY) {
            const ix = clamp(p.x, EDGE + 14, GOAL_R_X - EDGE - 14);
            const iy = clamp(p.y, 62, FIELD_BOTTOM - 62);
            pm.clearFacingTarget();
            pm.moveTo(ix, iy);
            pm.speed = SPEEDS[3];
            return; // 이 프레임은 내부 방향 전환만
        }
        if (!pm.moving || carrierState.retargetT <= 0) {
            carrierState.retargetT = rand(0.38, 0.65);
            const fwdMax = Math.max(goalDist - 45, 40);
            const fwd = clamp(rand(70, 140), 30, fwdMax);
            let lateral = presser
                ? ((presser.y - p.y) > 0 ? -1 : 1) * rand(24, 58)
                : Math.sin(clock * 0.9 + weave[ti][i]) * 26;
            if (goalDist < 260 && Math.random() < 0.5) lateral += (CENTER_Y - p.y) * 0.25;
            const tx = clamp(p.x + t.dir * fwd, EDGE + 20, GOAL_R_X - EDGE - 20);
            const ty = clamp(p.y + lateral, 70, FIELD_BOTTOM - 70);
            pm.clearFacingTarget();
            pm.moveTo(tx, ty);
        }

        // 압박별 속도 — 기본도 러닝 이상으로 유지해야 킥앞드리블 리듬이 나온다
        // (DribbleController: kickAhead = 30×(speed/100)² → 저속은 볼이 발에 붙음)
        if (pressD < 95) pm.speed = SPEEDS[4];
        else if (pressD < 150) pm.speed = SPEEDS[3];
        else {
            const wave = (Math.sin(clock * 2.1 + weave[ti][i]) + 1) / 2;
            pm.speed = wave > 0.45 ? SPEEDS[4] : SPEEDS[3];
        }
        if ((t.dir > 0 && p.x > GOAL_R_X - 28) || (t.dir < 0 && p.x < GOAL_L_X + 28)) {
            pm.speed = SPEEDS[1]; // 엔드라인 밖 진입 방지
        }
    }

    function laneOpenness(fromP, toP, defenders) {
        let minD = Infinity;
        for (const d of defenders) {
            minD = Math.min(minD, distToSegment(d.x, d.y, fromP.x, fromP.y, toP.x, toP.y));
        }
        return minD;
    }

    // ── 패스 판단/실행 — 거리·압박 따라 숏패스 또는 롱패스 ──
    function tryPass(opts = {}) {
        const t = posTeam, i = posIdx;
        const p = t.players[i];
        const opp = otherTeam(t);
        const mates = [0, 1, 2].filter(k => k !== i);

        let best = null, bestScore = -Infinity, bestOpen = 0, bestDist = 0;
        for (const k of mates) {
            const m = t.players[k];
            const dist = Math.hypot(m.x - p.x, m.y - p.y);
            if (dist < 60 || dist > 460) continue;
            const openness = laneOpenness(p, m, opp.players);
            // relax(긴급 탈출): 레인이 닫혀도 인터셉트 리스크 감수하고 찬다
            if (!opts.relax && openness < 20) continue;
            const gain = t.dir * (m.x - p.x);
            // 슛 존(forwardOnly): 전진 큰 패스만 허용 — 골 앞 뒤파스 차단
            if (opts.forwardOnly && gain < 70) continue;
            // 일반 상황 후방 패스 억제 — 레인 넓을 때만 허용하되 큰 벌점
            let backPenalty = 0;
            if (gain < -10 && !opts.relax) {
                if (openness < 30) continue;
                backPenalty = -90;
            }
            const forwardBonus = gain > 60 ? 40 : (gain < -40 ? -50 : 0);
            const boxProxBonus = Math.abs(t.attackGoalX - m.x) < 260 ? 25 : 0;
            const score = openness * 0.55 + gain * 0.5 + forwardBonus + boxProxBonus
                        + backPenalty
                        - dist * 0.075
                        + (opts.underPress ? -dist * 0.04 + 30 : 0);
            if (score > bestScore) { bestScore = score; best = k; bestOpen = openness; bestDist = dist; }
        }
        if (best === null) return false;

        const useLong = bestDist > 250 || ((opts.underPress || opts.relax) && bestDist > 150 && bestOpen > 45);
        executePass(best, useLong);
        return true;
    }

    function executePass(recIdx, useLong) {
        const t = posTeam, i = posIdx;
        const p = t.players[i], pm = t.movements[i];
        const mate = t.players[recIdx];

        // 수신자 진행 방향 선행 지점 조준
        const mv = t.movements[recIdx];
        const vdx = mv.moving && mv._tx !== null ? mv._tx - mate.x : 0;
        const vdy = mv.moving && mv._ty !== null ? mv._ty - mate.y : 0;
        const vl = Math.hypot(vdx, vdy) || 1;
        // 긴급 탈출 패스는 수신자를 지나 골 방향으로 찌르는 스루패스 성격
        const reluxThrough = stallTimer > 13 || pressTimer > 2.2;
        const lead = useLong ? rand(30, 48)
                   : reluxThrough ? rand(42, 78)
                   : rand(14, 30);
        const goalPull = reluxThrough ? t.dir * rand(14, 40) : 0;
        const aimX = clamp(mate.x + (vdx / vl) * lead + goalPull, 25, GOAL_R_X - 25);
        const aimY = clamp(mate.y + (vdy / vl) * lead, Y_MIN + 10, Y_MAX - 10);

        pm.clearFacingTarget();
        pm.setFacingTarget(Math.atan2(aimY - ball.y, aimX - ball.x));

        if (useLong) {
            PassMovement.longPass(bm, aimX, aimY, {
                flightDuration: Math.max(0.75, Math.hypot(aimX - ball.x, aimY - ball.y) / 350),
                maxHeight: 0.9 + Math.random() * 0.2,
                deviationRad: rand(-0.03, 0.03),
                bounce: { duration: 0.35, maxHeight: 0.28, velocityScale: 0.48 },
            });
        } else {
            PassMovement.shortPass(bm, aimX, aimY, {
                arriveSpeed: rand(115, 150),
                deviationRad: rand(-0.02, 0.02),
            });
        }

        // 패서 정지 없이 지원 이동
        pm.speed = SPEEDS[2];
        pm.moveTo(clamp(p.x + t.dir * rand(50, 90), 20, GOAL_R_X - 20), p.y);

        t.dribbles[i].stop();
        t.receptions[recIdx].start({ runTargetX: aimX, runTargetY: aimY });

        passCtx = { type: useLong ? 'long' : 'short', team: t, recIdx, elapsed: 0 };
        lastTouchTeam = t;
        posTeam = null;
        ensureDefense(otherTeam(t));
        phase = PHASE.PASSING;
    }

    // ── 크로스 — 측면 침투 시 박스 상공 공중볼 ──
    // 헤더 미성립 시 바운드되도록 bounce 설정 — 지면에 멈추는 현상 방지
    function buildCross(t, i, p, head, yOff) {
        const targetX = t.attackGoalX - t.dir * rand(80, 105);
        const targetY = CENTER_Y + yOff;
        p.setAngle(Math.atan2(targetY - ball.y, targetX - ball.x));
        PassMovement.longPass(bm, targetX, targetY, {
            flightDuration: Math.max(0.75, Math.hypot(targetX - ball.x, targetY - ball.y) / 310),
            maxHeight: 0.85 + Math.random() * 0.25,
            deviationRad: rand(-0.045, 0.045),
            bounce: { duration: 0.42, maxHeight: 0.32, velocityScale: 0.55 },
        });

        // 헤더 후보 — 착지점 질주
        const hp = t.movements[head];
        hp.clearFacingTarget();
        hp.speed = SPEEDS[4];
        hp.moveTo(targetX, targetY);

        // 패서는 세컨드볼 대비 이동
        const pm = t.movements[i];
        pm.speed = SPEEDS[3];
        pm.moveTo(
            clamp(p.x + t.dir * 55, 25, GOAL_R_X - 25),
            clamp(p.y + (CENTER_Y > p.y ? 70 : -70), Y_MIN + 20, Y_MAX - 20),
        );
        t.dribbles[i].stop();

        crossCtx = { team: t, headIdx: head, resolved: false };
        lastTouchTeam = t;
        posTeam = null;
        ensureDefense(otherTeam(t));
        stallTimer = 0;
        phase = PHASE.PASSING;
        return true;
    }

    function tryCross() {
        const t = posTeam, i = posIdx;
        const p = t.players[i];
        if (Math.abs(t.attackGoalX - p.x) > 420) return false;
        if (Math.abs(p.y - CENTER_Y) <= 165) return false;

        let head = null, headScore = Infinity;
        for (const k of [0, 1, 2]) {
            if (k === i) continue;
            const m = t.players[k];
            const central = Math.abs(m.y - CENTER_Y);
            if (central > 170) continue;
            const mdx = Math.abs(t.attackGoalX - m.x);
            if (mdx > 440) continue;
            if (central + mdx * 0.4 < headScore) { headScore = central + mdx * 0.4; head = k; }
        }
        if (head === null) return false;
        return buildCross(t, i, p, head, rand(-42, 42));
    }

    // ── 슛 실행 ──
    function tryShoot(maxROverride = null) {
        const t = posTeam, i = posIdx;
        const dxGoal = Math.abs(t.attackGoalX - t.players[i].x);
        // 장기 정체 시 중거리까지 허용 — 박스 진입 실패 보완
        const maxR = maxROverride ?? (stallTimer > 10 ? 300 : SHOOT_RANGE);
        if (dxGoal > maxR || dxGoal < 40) return false;
        fireShot(t, i, false, null);
        return true;
    }

    function fireShot(team, idx, isHeader, headerResult) {
        stopAllFieldControls();
        const shooter = team.players[idx];
        const goalX = team.attackGoalX;
        const dirSign = team.dir;

        let shotTargetY, hOpt, shotSpeed;
        if (isHeader && headerResult) {
            shotTargetY = headerResult.finalTargetY;
            hOpt = { targetHeight: headerResult.maxHeight * 3, arcHeight: headerResult.maxHeight * 0.5 };
            shotSpeed = headerResult.power;
        } else {
            const aimY = randomAimY();
            const h = randomShotHeight();
            const sideMiss = aimY < GOAL_TOP_Y || aimY > GOAL_BOT_Y;
            shotTargetY = h.overBar && !sideMiss ? GOAL_TOP_Y + 20 : aimY;
            hOpt = h;
            shotSpeed = 415 + Math.random() * 55; // 가시적 비행 — 과속 방지
        }

        shooter.setAngle(Math.atan2(shotTargetY - ball.y, goalX - ball.x));
        const shotMod = new ShotMovement({ goalX: GOAL_R_X });
        const fired = shotMod.shoot(bm, {
            goalX,
            targetY: shotTargetY,
            targetHeight: hOpt.targetHeight,
            arcHeight: hOpt.arcHeight,
            speed: shotSpeed,
        });
        if (!fired) { startOpen(team, idx); return; }

        // 수비 측 GK 세이브 사전 판정
        const defT = otherTeam(team);
        const onTarget = shotTargetY >= GOAL_TOP_Y && shotTargetY <= GOAL_BOT_Y
                        && hOpt.targetHeight <= 2.44;
        if (onTarget) {
            const traj = {
                startX: ball.x, startY: ball.y, targetX: goalX, targetY: shotTargetY,
                speed: shotSpeed,
                startHeight: isHeader ? 0.3 : hOpt.targetHeight * 0.1,
                targetHeight: hOpt.targetHeight, arcHeight: hOpt.arcHeight,
            };
            const ev = defT.gkSave.evaluateSave(traj, defT.gk);
            const spx = defT.ownGoalX > 500
                ? Math.min(ev.savePointX, GOAL_R_X - 15)
                : Math.max(ev.savePointX, GOAL_L_X + 15);
            const st = gkState[teams.indexOf(defT)];
            // 사전 판정(확률 모델)이 권위 — canSave/결과 유형을 저장해 두고
            // 비행 중에는 이 판정대로만 연출한다 (물리 근접으로 재판정하지 않음)
            st.saveInfo = {
                traj, savePointX: spx, savePointY: ev.savePointY, done: false,
                canSave: ev.canSave,
                decidedType: ev.result,
            };
            const willAct = ev.canSave && ev.result !== SAVE_RESULT.GOAL;
            st.reactT = willAct ? GK_REACTION_TIME : 999;
            st.diveTimer = willAct ? 1.6 : 0;
            st.diveTargetX = spx;
            st.diveTargetY = ev.savePointY;
        }
        lastTouchTeam = team;
        passCtx = null; crossCtx = null;
        stallTimer = 0;
        shotCtx = { team, defTeam: defT, dirSign, mod: shotMod };
        phase = PHASE.SHOT;
    }

    // ── 5. 슛 비행 — 세이브 시 경기 지속 ──
    function shotTick(dt) {
        const { defTeam, dirSign } = shotCtx;
        const st = gkState[teams.indexOf(defTeam)];
        st.reactT -= dt;

        // 다이브
        if (st.diveTimer > 0) {
            st.diveTimer -= dt;
            if (st.reactT <= 0 && st.diveTargetX !== null) {
                const dx = st.diveTargetX - defTeam.gk.x, dy = st.diveTargetY - defTeam.gk.y;
                const d = Math.hypot(dx, dy);
                if (d > 1) {
                    const s = Math.min(GK_DIVE_SPEED * dt, d);
                    defTeam.gk.setPosition(defTeam.gk.x + (dx / d) * s, defTeam.gk.y + (dy / d) * s);
                }
                defTeam.gk.setAngle(dirSign > 0 ? 90 : -90);
            }
        }

        // 저장점 도달 판정 — 사전 판정(canSave·decidedType)에만 근거
        if (st.saveInfo && !st.saveInfo.done && st.saveInfo.canSave
            && st.saveInfo.decidedType !== SAVE_RESULT.GOAL) {
            const reached = dirSign > 0
                ? ball.x >= st.saveInfo.savePointX - 5
                : ball.x <= st.saveInfo.savePointX + 5;
            if (reached) {
                st.saveInfo.done = true;
                const type = st.saveInfo.decidedType;
                if (type === SAVE_RESULT.CATCH) {
                    ball.setPosition(st.saveInfo.savePointX - dirSign * 12, st.saveInfo.savePointY);
                    ball.setHeight(0);
                    beginDistribution(defTeam);
                    return;
                }
                // PARRY / DEFLECTION
                const df = defTeam.gkSave.calculateDeflection(type, { x: st.saveInfo.savePointX, y: st.saveInfo.savePointY }, st.saveInfo.traj);
                ball.setPosition(st.saveInfo.savePointX - dirSign * 8, st.saveInfo.savePointY);
                // calculateDeflection의 vx는 오른골 수비 기준(-) — 왼골이면 부호 반전
                bm.release(df.vx * dirSign, df.vy);
                st.saveInfo = null;
                shotCtx = null;
                enterLoose();
                return;
            }
        }

        shotCtx.mod.update(dt);
        const r = shotCtx.mod.result;
        if (r === null) return;

        // 모듈이 다음 shoot()에서 _result를 스스로 초기화한다 — 여기서 재할당 금지(getter 전용)
        shotCtx = null;
        if (r === 'goal') { finish('goal'); return; }
        if (r === 'miss-wide' || r === 'miss-high') { finish('out'); return; }
        enterLoose(); // 포스트·크로스바 리바운드 → 루즈볼 지속
    }

    // ── GK 캐치 후 배급 ──
    function beginDistribution(gkTeam) {
        posTeam = gkTeam;
        lastTouchTeam = gkTeam;
        bm.possess(gkTeam.gk, POSSESS_OFFSET);
        bm.snapToFront();
        gkState[teams.indexOf(gkTeam)].distribT = rand(0.4, 0.7);
        tackleCooldown = 0.9;
        ensureDefense(otherTeam(gkTeam));
        stallTimer = 0;
        passCtx = null; crossCtx = null; shotCtx = null;
        phase = PHASE.GKDISTRIB;
    }

    function distribTick(dt) {
        const gkTeam = posTeam;
        const st = gkState[teams.indexOf(gkTeam)];
        st.distribT -= dt;
        if (st.distribT > 0) return;

        const opp = otherTeam(gkTeam);
        let best = 0, bestScore = -Infinity;
        for (let k = 0; k < 3; k++) {
            const m = gkTeam.players[k];
            const dist = Math.hypot(m.x - gkTeam.gk.x, m.y - gkTeam.gk.y);
            let press = Infinity;
            for (const o of opp.players) press = Math.min(press, Math.hypot(o.x - m.x, o.y - m.y));
            const score = Math.min(dist, 320) * 0.4 + Math.min(press, 200) * 0.9;
            if (score > bestScore) { bestScore = score; best = k; }
        }
        const mate = gkTeam.players[best];
        const dist = Math.hypot(mate.x - gkTeam.gk.x, mate.y - gkTeam.gk.y);
        const useLong = dist > 270;
        gkTeam.gk.setAngle(Math.atan2(mate.y - ball.y, mate.x - ball.x));

        if (useLong) {
            PassMovement.longPass(bm, mate.x, mate.y, {
                flightDuration: Math.max(0.75, dist / 330), maxHeight: 0.95,
                bounce: { duration: 0.35, maxHeight: 0.28, velocityScale: 0.48 },
            });
        } else {
            PassMovement.shortPass(bm, mate.x, mate.y, { arriveSpeed: 120 });
        }
        passCtx = { type: 'gk', team: gkTeam, recIdx: best, elapsed: 0 };
        gkTeam.receptions[best].start({ runTargetX: mate.x, runTargetY: mate.y });
        posTeam = null;
        phase = PHASE.PASSING;
    }

    // ── 6. 크로스 감시 → 헤딩/경합 ──
    function updateCross(dt) {
        const cc = crossCtx;
        const t = cc.team;
        const hp = t.movements[cc.headIdx];

        // 공중 비행 중에는 예상 착지점으로 전력 질주 — 바운드 중에는 헤딩 창구로 직행
        if (bm.isAerial) {
            const land = landingPoint();
            if (land) {
                hp.clearFacingTarget();
                hp.speed = SPEEDS[4];
                hp.moveTo(clamp(land.x, 15, GOAL_R_X - 15), clamp(land.y, Y_MIN + 10, Y_MAX - 10));
                hp.update(dt);
                return;
            }
        }

        // 착지 순간 — 헤딩 창구 (미성립 시 바운드 후 루즈볼)
        if (cc.resolved) return;
        cc.resolved = true;
        const candidate = t.players[cc.headIdx];
        const cd = Math.hypot(candidate.x - ball.x, candidate.y - ball.y);
        const opp = otherTeam(t);
        let rival = null, rd = Infinity;
        for (const o of opp.players) {
            const d = Math.hypot(o.x - ball.x, o.y - ball.y);
            if (d < rd) { rd = d; rival = o; }
        }
        const rivalClose = rival && rd <= 30;

        if (cd <= 30 && !rivalClose) {
            executeHeaderShot(t, cc.headIdx, 0.75);
            return;
        }
        if (cd <= 30 && rivalClose) {
            // 공중볼 경합 — 위치 점수 승자가 헤딩
            const rollA = (1 - cd / 90) * 0.6 + 0.4 * rand(0.8, 1.2);
            const rollD = (1 - rd / 90) * 0.6 + 0.4 * rand(0.8, 1.2);
            if (rollD > rollA) {
                executeClearance(findUnit(rival));
            } else {
                executeHeaderShot(t, cc.headIdx, 0.8);
            }
            return;
        }
        // 헤딩 불가 — 루즈볼 전환
        crossCtx = null;
        enterLoose();
    }

    function executeHeaderShot(team, idx, incomingH) {
        const candidate = team.players[idx];
        crossCtx = null;
        bm.possess(candidate, POSSESS_OFFSET);
        bm.snapToFront();
        ball.setHeight(0.3);
        const headingMod = new HeadingShot({
            goalX: team.attackGoalX, basePowerMin: 240, basePowerMax: 340,
        });
        const sr = headingMod.execute(candidate, ball, {
            goalX: team.attackGoalX, incomingSpeed: 210, incomingHeight: incomingH, headerSkill: 0.5,
        });
        fireShot(team, idx, true, sr);
    }

    function executeClearance(unit) {
        crossCtx = null;
        if (!unit) { enterLoose(); return; }
        const { team, idx } = unit;
        const p = team.players[idx];
        bm.possess(p, POSSESS_OFFSET);
        bm.snapToFront();
        ball.setHeight(0.3);
        p.setAngle(Math.atan2(CENTER_Y - p.y * 0.5, team.attackGoalX - p.x));
        const tx = clamp(p.x + team.dir * rand(220, 330), 25, GOAL_R_X - 25);
        const ty = clamp(p.y + rand(-110, 110), Y_MIN + 15, Y_MAX - 15);
        PassMovement.longPass(bm, tx, ty, {
            flightDuration: rand(0.65, 0.9), maxHeight: 0.75 + Math.random() * 0.2,
            bounce: { duration: 0.38, maxHeight: 0.30, velocityScale: 0.50 },
        });
        lastTouchTeam = team;
        posTeam = null;
        ensureDefense(otherTeam(team));
        // 클리어런스는 어느 팀이든 닥치는 대로 회수 — 루즈볼 흐름
        enterLoose();
    }

    // ── 7. PASSING 틱 ──
    function passingTick(dt) {
        // 크로스 우선 처리
        if (crossCtx) {
            bm.update(dt);
            updateCross(dt);
            return;
        }
        if (!passCtx) { enterLoose(); return; }
        passCtx.elapsed += dt;

        const { team, recIdx } = passCtx;
        const rec = team.receptions[recIdx];
        rec.update(dt);
        team.movements[recIdx].update(dt);

        if (rec.received) { startOpen(team, recIdx); return; }

        // 무인 지상볼 근접 회수 워치독
        if (!bm.owner && !bm.isAerial && !bm.isBouncing) {
            const bs = Math.hypot(bm.vx, bm.vy);
            const near = nearestOf(team, ball.x, ball.y);
            const dMate = Math.hypot(near.p.x - ball.x, near.p.y - ball.y);
            if (bs <= 185 && dMate <= 24 && passCtx.elapsed > 0.25) {
                startOpen(team, near.idx);
                return;
            }
            // 볼 두고 서 있지 않게 최근접 팀원 추격 유지
            if (dMate > 24 && bs > 1) {
                const pm = team.movements[near.idx];
                pm.clearFacingTarget();
                pm.speed = SPEEDS[4];
                pm.moveTo(
                    clamp(ball.x + bm.vx * 0.2, 15, GOAL_R_X - 15),
                    clamp(ball.y + bm.vy * 0.2, Y_MIN + 12, Y_MAX - 12),
                );
                if (near.idx !== recIdx) pm.update(dt);
            }
        }

        // 장시간 미회수 → 일반 루즈볼
        if (passCtx.elapsed > 2.8) { enterLoose(); return; }
    }

    // 패스 비행 중 소유 팀 나머지 이동 (수신자 제외)
    function moveTeammatesDuringPass(t, dt) {
        const defT = otherTeam(t);
        for (let k = 0; k < 3; k++) {
            if (k === passCtx.recIdx) continue;
            const m = t.players[k], mm = t.movements[k];
            if (!mm.moving) {
                mm.clearFacingTarget();
                const press = nearestOf(defT, m.x, m.y);
                const px = clamp(m.x + t.dir * 80, 25, GOAL_R_X - 25);
                const py = clamp(m.y + (press.p.y > m.y ? -45 : 45), Y_MIN + 20, Y_MAX - 20);
                mm.speed = SPEEDS[3];
                mm.moveTo(px, py);
            }
            mm.update(dt);
        }
    }

    // 크로스 비행 중 소유 팀 나머지 이동 (헤더 후보 제외)
    function moveTeammatesDuringCross(t, dt) {
        for (let k = 0; k < 3; k++) {
            if (k === crossCtx.headIdx) continue;
            const mm = t.movements[k];
            if (!mm.moving) {
                mm.clearFacingTarget();
                const px = clamp(t.attackGoalX - t.dir * rand(140, 210), 25, GOAL_R_X - 25);
                const py = clamp(CENTER_Y + rand(-120, 120), Y_MIN + 25, Y_MAX - 25);
                mm.speed = SPEEDS[3];
                mm.moveTo(px, py);
            }
            mm.update(dt);
        }
    }

    // ── 협력수비 컨텍스트 갱신 ──
    function updateDefenseFor(defTeam, dt, extra = {}) {
        const atkTeam = otherTeam(defTeam);
        let holder = extra.holder ?? null;
        let receiver = null;

        if (posTeam === atkTeam) holder = atkTeam.players[posIdx];
        if (passCtx && passCtx.team === atkTeam) receiver = atkTeam.players[passCtx.recIdx];
        if (crossCtx && crossCtx.team === atkTeam) receiver = atkTeam.players[crossCtx.headIdx];

        defTeam.defenseAI.update(dt, {
            ball,
            ballVelocity: { x: bm.vx, y: bm.vy },
            attackers: atkTeam.players,
            attackerMovements: atkTeam.movements,
            holder,
            receiver,
            inFlight: Boolean(extra.inFlight ?? (bm.isAerial || bm.isBouncing)),
            goal: { x: defTeam.ownGoalX, y: CENTER_Y },
        });
    }

    // ── 8. OPEN 틱 — 오프볼 배치 + 행동 판단 ──
    function openTick(dt) {
        const t = posTeam, i = posIdx;
        const opp = otherTeam(t);
        const carrier = t.players[i];
        const ti = teams.indexOf(t);

        carrierControl(dt);

        // 오프볼 2인 — 캐리어 레인을 피한 나머지 레인 배치
        const carrierLane = nearestLane(carrier.y);
        const forwardness = (carrier.x - CENTER_X) * t.dir;
        let deepAssigned = false;
        for (const k of [0, 1, 2]) {
            if (k === i) continue;
            const m = t.players[k], mm = t.movements[k];
            let lane = t.lanes[k];
            if (lane === carrierLane) {
                const alts = [0, 1, 2].filter(l => l !== carrierLane);
                lane = alts.reduce((a, b) =>
                    Math.abs(LANE_Y[a] - m.y) <= Math.abs(LANE_Y[b] - m.y) ? a : b);
            }
            const laneY = LANE_Y[lane] + Math.sin(clock * 1.3 + weave[ti][k]) * 17;

            let tx;
            if (!deepAssigned && forwardness > 60) {
                deepAssigned = true;
                tx = carrier.x - t.dir * rand(85, 130);      // 후방 지원
            } else {
                tx = carrier.x + t.dir * rand(70, 135);      // 전방 침투
            }
            tx = clamp(tx, 25, GOAL_R_X - 25);
            if (Math.abs(carrier.y - laneY) < 55 && Math.abs(carrier.x - tx) < 80) {
                tx -= t.dir * 55;                            // 홀더와 겹침 방지
            }

            const dd = Math.hypot(m.x - tx, m.y - laneY);
            mm.clearFacingTarget();
            mm.speed = dd > 190 ? SPEEDS[4] : dd > 90 ? SPEEDS[3] : SPEEDS[2];
            mm.moveTo(tx, clamp(laneY, Y_MIN + 15, Y_MAX - 15));
        }

        updateDefenseFor(opp, dt, { holder: carrier, inFlight: false });

        // 행동 판단 — 박스에서도 즉사 슛이 아닌 확률 게이트 (드리블·패스 여지 유지)
        posElapsed += dt;
        passHold -= dt;
        kickTimer -= dt;
        if (kickTimer > 0 || passHold > 0 || !t.dribbles[i].ballAttached) return;

        let pressD = Infinity;
        for (const o of opp.players) pressD = Math.min(pressD, Math.hypot(o.x - carrier.x, o.y - carrier.y));
        const underPress = pressD < 95;
        if (underPress) pressTimer += dt; else pressTimer = 0;

        const dxGoalNow = Math.abs(t.attackGoalX - carrier.x);
        // 장기 정체 시 중거리(300)까지 슛 범위 확장 — 박스 진입 실패 보완
        const shootZone = dxGoalNow <= (stallTimer > 10 ? 300 : SHOOT_RANGE)
                       && dxGoalNow >= 40;

        // 교착 탈출 — 압박 2.2s / 전역 정체 15s 시 사다리 상향:
        //   강제 스루패스 4회 누적 → 완화 크로스 → 중거리슛 → 롱슛 (반드시 종결 유도)
        if (pressTimer > 2.6 || stallTimer > 17) {
            const hard = escapeStreak >= 4;
            if (!hard && tryPass({ underPress: true, relax: true })) {
                escapeStreak++;
                return;
            }
            if (tryCrossLoose()) { escapeStreak = 2; return; }
            if (tryShoot(420)) return;
            if (tryShoot(520)) return; // 최후 롱슛 — 70m 난사 방지
            // stall은 리셋하지 않는다 — 밸브(24s)가 반드시 종결 이벤트를 만든다
            pressTimer = 1.6;
            escapeStreak = Math.max(0, escapeStreak - 1);
        }

        // 장기 소유 — 리듬 상향(슛·패스 빈도 증가)
        const escalate = posElapsed > 7 ? 0.22 : posElapsed > 4 ? 0.1 : 0;

        const dxG = Math.abs(t.attackGoalX - carrier.x);
        const closeRange = dxG <= 165;
        // 근거리 1:1 찬스 — 슛 우선 (85%)
        if (closeRange && Math.random() < 0.85 && tryShoot()) return;
        if (!closeRange && shootZone && Math.random() < 0.5 && tryShoot()) return;

        if (Math.random() < (0.12 + escalate / 2) && tryCross()) return;

        const passP = (underPress ? 0.36 : 0.11) + escalate;
        if (Math.random() < passP) {
            // 슛 존에서는 전진 패스만 — 뒤파스로 찬스 날리기 방지
            const fwdOnly = shootZone || closeRange;
            if (tryPass({ underPress, forwardOnly: fwdOnly })) return;
            if (underPress && tryCross()) return;
        } else if (underPress && Math.random() < 0.4) {
            if (tryPass({ underPress, forwardOnly: shootZone || closeRange })) return;
        }
        kickTimer = rand(0.28, 0.5);
    }

    /** 완화 조건 크로스 — 긴급 탈출용 (중앙 자원 거리 기준 완화) */
    function tryCrossLoose() {
        const t = posTeam, i = posIdx;
        const p = t.players[i];
        if (Math.abs(t.attackGoalX - p.x) > 430) return false;

        let head = null, headScore = Infinity;
        for (const k of [0, 1, 2]) {
            if (k === i) continue;
            const m = t.players[k];
            const central = Math.abs(m.y - CENTER_Y);
            if (central > 190) continue;
            const mdx = Math.abs(t.attackGoalX - m.x);
            if (mdx > 460) continue;
            if (central + mdx * 0.35 < headScore) { headScore = central + mdx * 0.35; head = k; }
        }
        if (head === null) return false;
        return buildCross(t, i, p, head, rand(-48, 48));
    }

    // ── 9. LOOSE 틱 ──
    function looseTick(dt) {
        const aerial = bm.isAerial || bm.isBouncing;
        const land = aerial ? landingPoint() : null;
        const tx = land ? land.x : ball.x + bm.vx * 0.25;
        const ty = land ? land.y : ball.y + bm.vy * 0.25;

        // 각 팀 최근접 1인 추격, 나머지는 레인 유지 스프레드
        for (const t of teams) {
            const near = nearestOf(t, tx, ty);
            for (let k = 0; k < 3; k++) {
                const m = t.players[k], mm = t.movements[k];
                mm.clearFacingTarget();
                if (k === near.idx) {
                    const d = Math.hypot(m.x - tx, m.y - ty);
                    mm.speed = d > 120 ? SPEEDS[4] : SPEEDS[3];
                    mm.moveTo(clamp(tx, 15, GOAL_R_X - 15), clamp(ty, Y_MIN + 12, Y_MAX - 12));
                } else {
                    const laneY = LANE_Y[t.lanes[k]] + Math.sin(clock * 1.2 + weave[teams.indexOf(t)][k]) * 20;
                    const bias = t === lastTouchTeam ? 1 : 0.55;
                    const px = clamp(ball.x + t.dir * 70 * bias, 25, GOAL_R_X - 25);
                    mm.speed = SPEEDS[3];
                    mm.moveTo(px, clamp(laneY, Y_MIN + 20, Y_MAX - 20));
                }
                mm.update(dt);
            }
        }

        // 느린 지상볼 근접 수습 — 인터셉터 속도 조건 밖 볼
        if (!aerial && !bm.owner) {
            const bs = Math.hypot(bm.vx, bm.vy);
            if (bs < 45) {
                let pick = null, pd = 36;
                for (const p of allField) {
                    const d = Math.hypot(p.x - ball.x, p.y - ball.y);
                    if (d < pd) { pd = d; pick = p; }
                }
                if (pick) {
                    const u = findUnit(pick);
                    if (u) { startOpen(u.team, u.idx); return; }
                }
            }
        }
    }

    // ── 10. GK 업데이트 — 위치 잡기 + 박스 내 느린 볼 클레임 ──
    // GoalkeeperMovement는 오른쪽 골 전용 기하학(goalX-depth)이므로
    // 왼쪽 골 수비 팀은 거울 좌표로 계산해 결과를 반전시킨다.
    function gkPositionTarget(t) {
        if (t.ownGoalX < CENTER_X) {
            const m = t.gkMovement.update(
                { x: GOAL_R_X - ball.x, y: ball.y, vx: -bm.vx, vy: bm.vy }, t.gk);
            return { x: GOAL_R_X - m.x, y: m.y };
        }
        return t.gkMovement.update({ x: ball.x, y: ball.y, vx: bm.vx, vy: bm.vy }, t.gk);
    }

    function updateGKs(dt) {
        for (const t of teams) {
            const st = gkState[teams.indexOf(t)];

            if (phase === PHASE.SHOT && shotCtx && shotCtx.defTeam === t) continue; // 다이브가 담당

            if (phase === PHASE.GKDISTRIB && posTeam === t) {
                t.gk.setAngle(t.dir > 0 ? -90 : 90);
                continue;
            }

            const target = gkPositionTarget(t);
            const dx = target.x - t.gk.x, dy = target.y - t.gk.y, d = Math.hypot(dx, dy);
            if (d > 1) {
                const s = Math.min(GK_POSITION_SPEED * dt, d);
                t.gk.setPosition(t.gk.x + (dx / d) * s, t.gk.y + (dy / d) * s);
            }
            // 방향은 양 골 공통 — 공을 바라봄 (모듈 공식과 동일)
            t.gk.setAngle(Math.atan2(t.gk.x - ball.x, ball.y - t.gk.y) * 180 / Math.PI);
            st.reactT -= dt;

            if (complete || bm.owner || phase !== PHASE.LOOSE) continue;
            // 자기 페널티박스 안 느린 루즈볼 — GK 직접 클레임
            const boxDepth = 135;
            const inOwnBox = t.dir > 0 ? ball.x < boxDepth : ball.x > GOAL_R_X - boxDepth;
            const slowBall = !bm.isAerial && Math.hypot(bm.vx, bm.vy) < 200;
            if (inOwnBox && slowBall) {
                const d2 = Math.hypot(t.gk.x - ball.x, t.gk.y - ball.y);
                if (d2 > 4) {
                    const s2 = Math.min(GK_POSITION_SPEED * dt, d2);
                    t.gk.setPosition(t.gk.x + ((ball.x - t.gk.x) / d2) * s2, t.gk.y + ((ball.y - t.gk.y) / d2) * s2);
                } else {
                    beginDistribution(t);
                    return;
                }
            }
        }
    }

    // ── 11. 메인 루프 ──
    function tick(dt) {
        if (complete) return;
        clock += dt;
        if (tackleCooldown > 0) tackleCooldown -= dt;
        if (phase !== PHASE.SHOT && phase !== PHASE.GKDISTRIB) stallTimer += dt;

        updateGKs(dt);
        if (complete) return;

        // ── 최후 밸브: 장기 정체 시 소유자 롱슛 강제 — 무한 경기 차단 ──
        // 이상한 곳(자기 진영 깊숙한 곳)에서 난사 방지: 상대 진영 + 520 이내에서만 강제 슛
        if (stallTimer > 24 && bm.owner && (phase === PHASE.OPEN || phase === PHASE.GKDISTRIB)) {
            const u = findUnit(bm.owner);
            if (u && !(phase === PHASE.GKDISTRIB && u.team === posTeam)) {
                const dist = Math.abs(u.team.attackGoalX - bm.owner.x);
                const inOppHalf = u.team.dir > 0 ? bm.owner.x > CENTER_X : bm.owner.x < CENTER_X;
                if (inOppHalf && dist < 520) {
                    // tryShoot이 거리 체크를 하므로 실패 시에는 전진 패스로 대체
                    if (tryShoot(520)) { allSeparate(); return; }
                    if (tryPass({ underPress: true, relax: true, forwardOnly: true })) { allSeparate(); return; }
                } else if (tryPass({ underPress: true, relax: true, forwardOnly: true })) {
                    allSeparate(); return;
                }
            }
        }

        // ── 연장 한계: 장기 교착 경기는 무승부로 정리 (자동 재시작) ──
        if (clock > 135) { finish(null); return; }

        // ── SHOT ──
        if (phase === PHASE.SHOT) {
            shotTick(dt);
            allSeparate();
            return;
        }

        // ── GKDISTRIB ──
        if (phase === PHASE.GKDISTRIB) {
            distribTick(dt);
            if (complete || phase !== PHASE.GKDISTRIB) return;
            // 상대는 완전히 서 있지 않고 천천히 물러남
            const opp = otherTeam(posTeam);
            for (let k = 0; k < 3; k++) {
                const m = opp.players[k], mm = opp.movements[k];
                const tx = clamp(m.x + opp.dir * 40, 25, GOAL_R_X - 25);
                mm.clearFacingTarget();
                mm.speed = SPEEDS[1];
                mm.moveTo(tx, LANE_Y[opp.lanes[k]]);
                mm.update(dt);
            }
            allSeparate();
            if (outOfBounds()) finish('out');
            return;
        }

        // ── CONTEST ──
        if (phase === PHASE.CONTEST) {
            if (contest) contest.update(dt);
            const inContest = (p) => contest && (p === contest._a || p === contest._b);
            for (const t of teams) {
                for (let k = 0; k < 3; k++) {
                    const p = t.players[k];
                    if (inContest(p)) continue;
                    const mm = t.movements[k];
                    mm.clearFacingTarget();
                    mm.speed = SPEEDS[3];
                    mm.moveTo(
                        clamp(ball.x + t.dir * rand(-30, 30), 20, GOAL_R_X - 20),
                        clamp(ball.y + Math.sin(clock * 1.5 + weave[teams.indexOf(t)][k]) * 40, Y_MIN + 20, Y_MAX - 20),
                    );
                    mm.update(dt);
                }
            }
            bm.update(dt);
            allSeparate();
            if (outOfBounds()) finish('out');
            return;
        }

        // ── PASSING ──
        if (phase === PHASE.PASSING) {
            if (!crossCtx) bm.update(dt);

            if (crossCtx) moveTeammatesDuringCross(crossCtx.team, dt);
            else if (passCtx) moveTeammatesDuringPass(passCtx.team, dt);

            const atkT = crossCtx ? crossCtx.team : (passCtx ? passCtx.team : null);
            if (atkT) updateDefenseFor(otherTeam(atkT), dt, { inFlight: bm.isAerial || bm.isBouncing });

            passingTick(dt);
            if (complete || phase !== PHASE.PASSING) { allSeparate(); return; }

            interceptor.exclude = (passCtx && passCtx.recIdx !== null)
                ? passCtx.team.players[passCtx.recIdx]
                : null;
            if (interceptor.update(dt)) { allSeparate(); return; }

            allSeparate();
            if (outOfBounds()) finish('out');
            return;
        }

        // ── LOOSE ──
        if (phase === PHASE.LOOSE) {
            bm.update(dt);
            looseTick(dt);
            if (complete || phase !== PHASE.LOOSE) { allSeparate(); return; }
            interceptor.exclude = null;
            if (interceptor.update(dt)) { allSeparate(); return; }
            allSeparate();
            if (outOfBounds()) finish('out');
            return;
        }

        // ── OPEN ──
        for (let k = 0; k < 3; k++) {
            posTeam.movements[k].update(dt);
            posTeam.dribbles[k].update(dt);
        }
        bm.update(dt);
        bm.snapToFront();

        openTick(dt);
        if (complete || phase !== PHASE.OPEN) { allSeparate(); return; }
        allSeparate();

        // 태클 — 쿨다운 경과 후
        if (tackleCooldown <= 0 && bm.owner) {
            const unit = findUnit(bm.owner);
            if (unit) {
                for (const o of otherTeam(unit.team).players) {
                    if (CollisionSystem.isTackle(o, ball)) {
                        startLooseFromTackle(o);
                        return;
                    }
                }
            }
        }

        if (outOfBounds()) finish('out');
    }

    // ── 12. 시작 ──
    startOpen(teams[kickoffIdx], 1);
    tackleCooldown = 1.2; // 킥오프 직후 여유
    passHold = 0.9;

    loop.add(tick);
    return function stop() {
        loop.remove(tick);
        if (complete) return;
        for (const t of teams) {
            t.dribbles.forEach(d => d.stop());
            t.movements.forEach(m => m.stop());
            t.defenseAI.stop();
            t.receptions.forEach(r => r.stop());
        }
        interceptor.stop();
        if (contest) contest.stop();
    };
}
