/**
 * ShotDecision - 슈팅 판단 모듈
 *
 * "언제 때려야 하는가"를 시나리오가 아닌 모듈이 결정한다.
 * 축구 코칭 관점의 세 축으로 슛 가치를 계산한다:
 *
 *   1) 사거리  — 골대까지의 거리. 박스 안일수록 가치가 급상승한다.
 *   2) 시야각  — 두 골포스트가 만드는 각폭. 측면으로 갈수록 좁아진다.
 *   3) 차단    — 슛 라인 위의 수비수와 골키퍼의 노출 정도.
 *
 * 결정적 찬스(박스 안 + 슛 라인 열림 + GK 1대1)에서는 forced=true 를 반환한다.
 * 시나리오는 forced일 때 드리블·크로스·패스를 모두 건너뛰고 슛만 실행해야 한다.
 * 이것이 "골키퍼와 1대1인데 측면으로 드리블해 크로스를 올리는" 현상을 없앤다.
 *
 * 몸 방향이 골대와 너무 어긋나면 shoot=false, needTurn=true 를 반환한다.
 * 이때 시나리오는 슛 대신 캐리어를 골대 쪽으로 한 터치 돌려 세우면 된다.
 * 순간 회전으로 때리는 부자연스러운 슛을 방지한다.
 */
import { angleTo, angleDiff } from './Direction.js';

const DEFAULTS = {
    goalTopY: 303.4,
    goalBotY: 376.6,
    goalCenterY: 340,
    maxRange: 185,        // 일반 슛 사거리 (SVG, 10 = 1m)
    minRange: 22,         // 이보다 가까우면 각도가 없어 슛이 성립하지 않음
    boxDepth: 165,        // 페널티 박스 깊이
    blockRadius: 26,      // 슛 라인 차단 판정 반경
    turnLimitDeg: 78,     // 일반 슛 허용 회전각
    forcedTurnLimitDeg: 115, // 결정적 찬스에서 허용하는 회전각 (한 터치 후 슛)
    reachRadius: 0.62,    // 시야각 품질 기준 (라디안) — 페널티 스팟 수준
    keeperOutThreshold: 26, // GK가 골라인에서 이만큼 나오면 "노출"로 간주
};

/** 점 P 에서 선분 AB 까지의 최단 거리 */
function pointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

export class ShotDecision {
    constructor(options = {}) {
        this.o = { ...DEFAULTS, ...options };
    }

    /**
     * 슛 기회를 평가한다.
     *
     * @param {object} ctx
     *   shooter      {x,y,angle} 볼 소유 선수
     *   ball         {x,y}       현재 볼 위치 (킥 시작점)
     *   attackGoalX  {number}    공격 방향 골라인 X
     *   dir          {number}    +1 = 오른쪽 골 공격, -1 = 왼쪽
     *   defenders    {Array}     상대 필드 선수
     *   keeper       {object}    상대 골키퍼 (선택)
     *   ballAttached {boolean}   볼이 발에 붙어 있는지
     *   rangeBoost   {number}    정체 시 사거리 확장분
     * @returns {{
     *   shoot: boolean, forced: boolean, needTurn: boolean,
     *   quality: number, aimY: number, turnDeg: number,
     *   oneOnOne: boolean, blockers: number, distance: number
     * }}
     */
    evaluate(ctx) {
        const o = this.o;
        const shooter = ctx.shooter;
        const ball = ctx.ball ?? shooter;
        const gx = ctx.attackGoalX;
        const dir = ctx.dir ?? 1;
        const defenders = ctx.defenders ?? [];
        const keeper = ctx.keeper ?? null;
        const attached = ctx.ballAttached !== false;
        const rangeBoost = ctx.rangeBoost ?? 0;

        const fail = (extra = {}) => ({
            shoot: false, forced: false, needTurn: false,
            quality: 0, aimY: o.goalCenterY, turnDeg: 0,
            oneOnOne: false, blockers: 0,
            distance: Math.abs(gx - shooter.x), ...extra,
        });

        // 전방 거리 — 골대가 등 뒤에 있으면 슛 자체가 성립하지 않는다
        const forwardDist = (gx - shooter.x) * dir;
        if (forwardDist < o.minRange) return fail();
        if (forwardDist > o.maxRange + rangeBoost) return fail();
        if (!attached) return fail();

        // ── 1. 시야각 — 두 포스트가 만드는 각폭 ──
        const angTop = Math.atan2(o.goalTopY - shooter.y, forwardDist);
        const angBot = Math.atan2(o.goalBotY - shooter.y, forwardDist);
        const viewAngle = Math.abs(angBot - angTop);
        const angleQuality = clamp01(viewAngle / o.reachRadius);
        // 각이 거의 없으면(극단적 측면) 슛은 낭비 — 크로스/패스가 정답
        if (viewAngle < 0.16) return fail();

        // ── 2. 거리 품질 ──
        const distQuality = clamp01(1 - (forwardDist - 45) / (o.maxRange - 45));

        // ── 3. 슛 라인 차단 — 볼과 골문 중앙을 잇는 선분 위의 수비수 ──
        const aimBase = clamp01((shooter.y - o.goalTopY) / (o.goalBotY - o.goalTopY));
        // 조준점: 골문 안쪽에서 슈터 쪽 사이드를 살짝 선호 (실제 마무리 습관)
        const aimY = o.goalTopY + (o.goalBotY - o.goalTopY) * (0.25 + aimBase * 0.5);

        let blockers = 0;
        let nearestBlock = Infinity;
        for (const d of defenders) {
            // 슈터 뒤에 있는 수비수는 슛을 막지 못한다
            if ((d.x - shooter.x) * dir < -6) continue;
            const gap = pointToSegment(d.x, d.y, ball.x, ball.y, gx, aimY);
            if (gap < o.blockRadius) blockers++;
            if (gap < nearestBlock) nearestBlock = gap;
        }
        const blockQuality = blockers === 0
            ? clamp01(nearestBlock / (o.blockRadius * 2.2))
            : Math.max(0, 0.35 - blockers * 0.15);

        // ── 4. 골키퍼 노출도 — 나와 있으면 로빙·구석 슛 가치 상승 ──
        let keeperQuality = 0.5;
        if (keeper) {
            const keeperOut = Math.abs(keeper.x - gx);
            const lateralGap = Math.abs(keeper.y - aimY);
            keeperQuality = clamp01(
                0.35 + (keeperOut > o.keeperOutThreshold ? 0.3 : 0) + lateralGap / 120,
            );
        }

        const quality = clamp01(
            distQuality * 0.34 + angleQuality * 0.30 + blockQuality * 0.24 + keeperQuality * 0.12,
        );

        // ── 5. 회전각 — 몸을 얼마나 돌려야 때릴 수 있는가 ──
        const aimAngle = angleTo(ball.x, ball.y, gx, aimY);
        const turnDeg = Math.abs(angleDiff(aimAngle, shooter.angle));

        // ── 6. 결정적 찬스 판정 ──
        // 박스 안 + 슛 라인 완전 개방 + 각도 확보 = GK와의 1대1.
        // 이 상황에서 드리블·크로스로 새는 것을 forced 로 차단한다.
        const inBox = forwardDist <= o.boxDepth;
        const oneOnOne = inBox && blockers === 0 && angleQuality > 0.42;
        // 골문 정면 극근접은 각도가 조금 좁아도 무조건 마무리
        const pointBlank = forwardDist <= 95 && blockers === 0 && angleQuality > 0.30;
        const decisive = oneOnOne || pointBlank;

        if (decisive) {
            if (turnDeg > o.forcedTurnLimitDeg) {
                // 등지고 있음 — 슛 대신 골대 쪽으로 몸을 돌리도록 알린다
                return {
                    shoot: false, forced: true, needTurn: true,
                    quality, aimY, turnDeg, oneOnOne: true,
                    blockers, distance: forwardDist,
                };
            }
            return {
                shoot: true, forced: true, needTurn: false,
                quality: Math.max(quality, 0.85), aimY, turnDeg,
                oneOnOne: true, blockers, distance: forwardDist,
            };
        }

        // ── 7. 일반 상황 — 품질을 확률로 환산 ──
        if (turnDeg > o.turnLimitDeg) {
            return fail({ quality, aimY, turnDeg, blockers, distance: forwardDist });
        }
        const chance = quality * quality * 0.85;
        return {
            shoot: Math.random() < chance,
            forced: false, needTurn: false,
            quality, aimY, turnDeg, oneOnOne: false,
            blockers, distance: forwardDist,
        };
    }
}
