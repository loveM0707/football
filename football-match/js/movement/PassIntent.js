/**
 * PassIntent - 패스 조준(의도) 공통 모듈
 *
 * "어디로 어떤 종류의 패스를 할 것인가"를 결정한다.
 * 수신자의 현재 위치가 아니라 예상 위치를 조준한다:
 *   aim = 수신자 위치 + 수신자 속도 × 볼 비행 예상 시간
 *
 * 고정 리드 거리(180/190 등 시나리오 하드코딩) 대신
 * 수신자 속도에 비례한 리드로, 서 있는 선수에게는 발밑으로,
 * 전력 질주하는 선수에게는 앞 공간으로 패스가 간다.
 *
 * 종류:
 *   toFeet  발밑 (짧은 리드) — 압박 속 연결
 *   through 앞 공간 (긴 리드) — 침투 패스
 *   short   일반 (중간 리드)
 *   long    공중 (중간 리드, 비행시간 길어 자연히 앞 조준)
 *   auto    거리로 short/long 자동 선택
 */
import { FIELD_WIDTH, FIELD_HEIGHT } from './FieldGeometry.js';

const DEFAULTS = {
    longDist: 250,          // auto: 이보다 멀면 long
    flightPerDist: {        // 종류별 비행시간 추정 (초 = 거리 / 값)
        toFeet: 380,
        through: 300,
        short: 380,
        long: 340,
    },
    leadRange: {            // 종류별 리드 허용 범위 [최소, 최대] (SVG)
        toFeet: [6, 18],
        through: [40, 200],
        short: [14, 40],
        long: [30, 48],
    },
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class PassIntent {
    constructor(options = {}) {
        this.o = {
            ...DEFAULTS,
            ...options,
            flightPerDist: { ...DEFAULTS.flightPerDist, ...(options.flightPerDist ?? {}) },
            leadRange: { ...DEFAULTS.leadRange, ...(options.leadRange ?? {}) },
        };
    }

    /**
     * @param {object} ctx
     *   ball         {x,y}    킥 시작점
     *   receiver     {x,y}    수신자 현재 위치
     *   receiverVel  {x,y}    수신자 속도 (SVG/s, 기본 0)
     *   kind         {string} toFeet|through|short|long|auto (기본 auto)
     *   flightDiv    {number} 비행시간 추정치 재정의 (거리 / 값, 선택)
     *   leadMin      {number} 리드 하한 재정의 (선택)
     *   leadMax      {number} 리드 상한 재정의 (선택)
     *   bounds       {object} 조준 클램프 {minX,maxX,minY,maxY} (기본 필드)
     * @returns {{ aimX, aimY, kind, leadDistance, flightEst, dirX, dirY }}
     */
    plan(ctx) {
        const o = this.o;
        const ball = ctx.ball;
        const rec = ctx.receiver;
        const vel = ctx.receiverVel ?? { x: 0, y: 0 };
        const bounds = ctx.bounds ?? { minX: 0, maxX: FIELD_WIDTH, minY: 0, maxY: FIELD_HEIGHT };

        const dist = Math.hypot(rec.x - ball.x, rec.y - ball.y);
        let kind = ctx.kind ?? 'auto';
        if (kind === 'auto') kind = dist > o.longDist ? 'long' : 'short';

        // 비행 예상 시간으로 수신자 예상 위치를 조준한다
        const flightDiv = ctx.flightDiv ?? o.flightPerDist[kind] ?? o.flightPerDist.short;
        const flightEst = dist / Math.max(1, flightDiv);
        const speed = Math.hypot(vel.x, vel.y);
        const [rangeMin, rangeMax] = o.leadRange[kind] ?? o.leadRange.short;
        const leadMin = ctx.leadMin ?? rangeMin;
        const leadMax = ctx.leadMax ?? rangeMax;
        const lead = speed < 1 ? 0 : clamp(speed * flightEst, leadMin, leadMax);
        const nx = speed < 1 ? 0 : vel.x / speed;
        const ny = speed < 1 ? 0 : vel.y / speed;

        const aimX = clamp(rec.x + nx * lead, bounds.minX, bounds.maxX);
        const aimY = clamp(rec.y + ny * lead, bounds.minY, bounds.maxY);
        const leadDistance = Math.hypot(aimX - rec.x, aimY - rec.y);

        // 킥 방향 (볼→조준점)
        const dx = aimX - ball.x, dy = aimY - ball.y;
        const dl = Math.hypot(dx, dy) || 1;

        return { aimX, aimY, kind, leadDistance, flightEst, dirX: dx / dl, dirY: dy / dl };
    }
}
