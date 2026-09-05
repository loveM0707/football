/**
 * Shielding - 볼 쉴딩(보호) 모듈
 *
 * 상대 선수의 위치를 기반으로 몸 방향과 이동을 제어하여 볼을 보호한다.
 *   - 몸을 상대와 볼 사이에 배치한다 (등을 상대에게)
 *   - 볼을 상대 반대편(발 앞)에 유지한다
 *   - 저속으로 이동하며 공간을 확보한다
 *   - 탈출 가능한 방향을 주기적으로 탐색한다
 *
 * DribbleDecision.SHIELD가 이 모듈에 위임한다.
 * 시나리오/AI 레이어는 직접 사용하지 않는다.
 */
import { angleTo, angleDiff, forwardVector } from './Direction.js';
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const DEFAULTS = {
    shieldSpeed: SPEEDS[0],          // 쉴딩 중 이동 속도 (50 SVG/s)
    escapeCheckInterval: 0.55,       // 탈출 방향 탐색 주기 (초)
    pressThreshold: 55,              // 이보다 가까운 수비수가 있으면 쉴딩 유지
    releaseThreshold: 80,            // 이보다 멀어지면 쉴딩 해제
    moveDistance: 18,                // 프레임당 이동 목표 거리
    sideEscapeBias: 0.35,           // 측면 탈출 선호도
};

export class Shielding {
    constructor(options = {}) {
        this._active = false;
        this._timer  = 0;
        this._o = { ...DEFAULTS, ...options };
    }

    get active() { return this._active; }

    start() {
        this._active = true;
        this._timer  = 0;
    }

    stop() {
        this._active = false;
        this._timer  = 0;
    }

    /**
     * 쉴딩 방향과 이동 목표를 계산한다.
     *
     * @param {object} carrier   볼 소유 선수 {x, y, angle}
     * @param {Array}  defenders 상대 선수 배열 [{x, y}, ...]
     * @param {object} [bounds]  필드 경계 {xMin, xMax, yMin, yMax}
     * @returns {object|null} 쉴딩 정보, 또는 쉴딩 불필요 시 null
     *   bodyAngle  {number}  몸이 향할 방향 (수비수를 등지는 각도)
     *   moveX      {number}  이동 목표 X
     *   moveY      {number}  이동 목표 Y
     *   speed      {number}  이동 속도
     *   pressDist  {number}  가장 가까운 수비수까지 거리
     */
    calcShield(carrier, defenders, bounds) {
        const nearest = this._findNearest(carrier, defenders);
        if (!nearest || nearest.dist > this._o.releaseThreshold) return null;

        // 몸 방향: 수비수를 등지도록 — 수비수 → 캐리어 방향
        const bodyAngle = angleTo(nearest.player.x, nearest.player.y,
                                  carrier.x, carrier.y);

        // 이동 방향: 수비수 반대 방향 + 약간 측면 편향
        const escRad = bodyAngle * Math.PI / 180;
        const sideSign = Math.random() > 0.5 ? 1 : -1;
        const sideBias = sideSign * this._o.sideEscapeBias;
        const dist = this._o.moveDistance + Math.random() * 8;

        const bnd = bounds ?? {};
        const moveX = clamp(
            carrier.x + (-Math.sin(escRad)) * dist * (1 - Math.abs(sideBias))
                + Math.cos(escRad) * dist * sideBias,
            bnd.xMin ?? 25, bnd.xMax ?? 1025,
        );
        const moveY = clamp(
            carrier.y + Math.cos(escRad) * dist * (1 - Math.abs(sideBias))
                + Math.sin(escRad) * dist * sideBias,
            bnd.yMin ?? 45, bnd.yMax ?? 635,
        );

        return {
            bodyAngle,
            moveX,
            moveY,
            speed: this._o.shieldSpeed,
            pressDist: nearest.dist,
        };
    }

    /**
     * 매 프레임 호출. 쉴딩 행동을 실행한다.
     *
     * @param {number}  dt
     * @param {object}  carrier    볼 소유 선수 {x, y, angle}
     * @param {object}  pm         PlayerMovement 인스턴스
     * @param {Array}   defenders  상대 선수 배열
     * @param {object}  [bounds]   필드 경계
     * @returns {boolean} true면 쉴딩 계속, false면 해제됨
     */
    update(dt, carrier, pm, defenders, bounds) {
        if (!this._active) return false;

        this._timer -= dt;
        if (this._timer > 0) return true;
        this._timer = this._o.escapeCheckInterval;

        const result = this.calcShield(carrier, defenders, bounds);
        if (!result) {
            this._active = false;
            return false;
        }

        // 몸을 수비수 반대로 돌린다
        pm.setFacingTarget(result.bodyAngle);
        pm.speed = result.speed;
        pm.moveTo(result.moveX, result.moveY);

        return true;
    }

    /** 가장 가까운 수비수 탐색 */
    _findNearest(carrier, defenders) {
        let best = null, bestD = Infinity;
        for (const d of defenders) {
            const dist = Math.hypot(d.x - carrier.x, d.y - carrier.y);
            if (dist < bestD) { bestD = dist; best = d; }
        }
        return best ? { player: best, dist: bestD } : null;
    }
}
