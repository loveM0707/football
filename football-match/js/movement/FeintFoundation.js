/**
 * FeintFoundation - 페인트 기초 모듈
 *
 * 방향 전환 속임의 기초 메커니즘을 제공한다.
 *
 * 페인트 유형:
 *   bodyFake     어깨 드롭 — 한쪽으로 기울인 후 반대로 전환
 *   stopAndGo    급정지 후 가속 — 감속 후 다른 방향으로 폭발적 가속
 *   insideOut    안쪽→바깥쪽 — 안쪽으로 가는 척 하다가 바깥으로 전환
 *
 * 각 메서드는 페인트 매개변수 객체를 반환한다.
 * DribbleDecision이 FEINT 액션을 선택하면 이 매개변수로 2단계 실행:
 *   phase 0 (FAKE): 가짜 방향으로 짧은 이동
 *   phase 1 (GO): 실제 방향으로 가속 돌파
 *
 * 이 모듈은 구체적인 기술(스텝오버, 크루이프 턴 등)의 기초가 된다.
 */
import { angleTo, angleDiff } from './Direction.js';
import { PlayerMovement } from './PlayerMovement.js';

const SPEEDS = PlayerMovement.SPEEDS;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

export class FeintFoundation {
    /**
     * 어깨 드롭 (Body Fake)
     *
     * 수비수가 있는 쪽으로 살짝 기울인 후, 반대 방향으로 급회전하며 전진한다.
     *
     * @param {object} carrier  {x, y, angle}
     * @param {object} defender {x, y} 가장 가까운 수비수
     * @param {object} [options]
     * @returns {object} 페인트 매개변수
     *   fakeAngle    {number} 가짜 방향 (도)
     *   fakeSpeed    {number} 가짜 이동 속도
     *   fakeDuration {number} 가짜 지속 시간 (초)
     *   goAngle      {number} 실제 돌파 방향 (도)
     *   goSpeed      {number} 돌파 속도
     *   goDuration   {number} 돌파 지속 시간 (초)
     */
    static bodyFake(carrier, defender, options = {}) {
        const toDefAngle = angleTo(carrier.x, carrier.y, defender.x, defender.y);
        const diff = angleDiff(toDefAngle, carrier.angle);
        const fakeSign = Math.sign(diff) || 1;

        // 가짜 방향: 수비수 쪽으로 20~35도 기울이기
        const fakeDeviation = rand(20, 35);
        const fakeAngle = carrier.angle + fakeSign * fakeDeviation;

        // 실제 방향: 반대쪽으로 25~45도 전환
        const goDeviation = rand(25, 45);
        const goAngle = carrier.angle - fakeSign * goDeviation;

        return {
            fakeAngle,
            fakeSpeed: options.fakeSpeed ?? SPEEDS[2],
            fakeDuration: rand(0.18, 0.30),
            goAngle,
            goSpeed: options.goSpeed ?? SPEEDS[4],
            goDuration: rand(0.50, 0.70),
        };
    }

    /**
     * 급정지 후 가속 (Stop and Go)
     *
     * 갑자기 멈추어 수비수의 무게 중심을 무너뜨린 후,
     * 다른 방향으로 폭발적으로 가속한다.
     *
     * @param {object} carrier  {x, y, angle}
     * @param {object} [options]
     * @returns {object} 페인트 매개변수
     */
    static stopAndGo(carrier, options = {}) {
        // 정지 후 방향: 현재 방향에서 25~50도 편향
        const sideSign = Math.random() > 0.5 ? 1 : -1;
        const deviation = rand(25, 50);
        const goAngle = carrier.angle + sideSign * deviation;

        return {
            fakeAngle: carrier.angle,
            fakeSpeed: SPEEDS[0],       // 거의 정지
            fakeDuration: rand(0.12, 0.22),
            goAngle,
            goSpeed: options.goSpeed ?? SPEEDS[4],
            goDuration: rand(0.45, 0.65),
        };
    }

    /**
     * 안쪽→바깥쪽 전환 (Inside-Out)
     *
     * 안쪽(중앙)으로 커팅하는 척 하다가 바깥쪽(사이드)으로 전환한다.
     *
     * @param {object} carrier   {x, y, angle}
     * @param {number} centerY   필드 중앙 Y
     * @param {object} [options]
     * @returns {object} 페인트 매개변수
     */
    static insideOut(carrier, centerY = 340, options = {}) {
        // 안쪽 = 중앙 방향, 바깥쪽 = 사이드 방향
        const toCenter = carrier.y > centerY ? -1 : 1;

        const insideAngle = carrier.angle + toCenter * rand(25, 40);
        const outsideAngle = carrier.angle - toCenter * rand(30, 50);

        return {
            fakeAngle: insideAngle,
            fakeSpeed: options.fakeSpeed ?? SPEEDS[3],
            fakeDuration: rand(0.15, 0.25),
            goAngle: outsideAngle,
            goSpeed: options.goSpeed ?? SPEEDS[4],
            goDuration: rand(0.45, 0.65),
        };
    }

    /**
     * 무작위 페인트 유형 선택.
     * 상황에 따라 적절한 페인트를 자동 선택한다.
     *
     * @param {object} carrier   {x, y, angle}
     * @param {object} defender  {x, y} 가장 가까운 수비수
     * @param {object} [options]
     * @returns {object} 페인트 매개변수
     */
    static auto(carrier, defender, options = {}) {
        const dist = Math.hypot(defender.x - carrier.x, defender.y - carrier.y);
        const roll = Math.random();

        // 수비수가 매우 가까우면 급정지 후 가속이 효과적
        if (dist < 40 && roll < 0.4) {
            return FeintFoundation.stopAndGo(carrier, options);
        }
        // 중거리에서는 어깨 드롭이 효과적
        if (roll < 0.65) {
            return FeintFoundation.bodyFake(carrier, defender, options);
        }
        // 나머지는 안쪽→바깥쪽
        return FeintFoundation.insideOut(carrier, options.centerY ?? 340, options);
    }
}
