/**
 * AerialTrajectory - 공중볼 궤적 예측 공통 모듈
 *
 * 1. 공의 낙하지점 예측을 전담한다.
 * 공의 현재 좌표만이 아니라 속도와 예상 궤적(비행 시간·포물선)을 함께 고려한다.
 *
 * 기존에 3곳(HeadingSystem·BallReception·ThreeVsThree)에 복사되어 있던
 * private(_aerialVx·_aerialDuration) 직접 접근을 이 모듈 하나로 통합한다.
 * BallMovement 공개 getter(aerialState·bounceState)만 사용하므로
 * 캡슐화를 깨지 않으며, 크로스·코너킥·롱패스·골킥 어디서나 재사용 가능하다.
 *
 * 순수 모듈이다 — 이동·점프·헤딩을 직접 수행하지 않는다.
 */
export class AerialTrajectory {
    /**
     * 낙하지점을 예측한다.
     * @param {object} ball 공 { x, y }
     * @param {BallMovement} bm
     * @returns {null | { x, y, time, kind }} kind: 'aerial' | 'bounce'
     */
    predictLanding(ball, bm) {
        // 공중 비행 중 — 등속 수평 이동이므로 남은 시간만큼 외삽한다
        const air = bm.aerialState;
        if (air) {
            if (air.remaining <= 0.02) return null;
            return {
                x: ball.x + air.vx * air.remaining,
                y: ball.y + air.vy * air.remaining,
                time: air.remaining,
                kind: 'aerial',
            };
        }
        // 바운드 중 — 바운드 속도로 남은 시간만큼 외삽한다
        const bnc = bm.bounceState;
        if (bnc) {
            if (bnc.remaining <= 0.02) return null;
            return {
                x: ball.x + bnc.vx * bnc.remaining,
                y: ball.y + bnc.vy * bnc.remaining,
                time: bnc.remaining,
                kind: 'bounce',
            };
        }
        return null;
    }

    /**
     * t초 후 수평 위치를 예측한다 (등속 가정).
     * @returns {null | { x, y }}
     */
    positionAt(ball, bm, t) {
        const air = bm.aerialState;
        if (air) {
            const useT = Math.max(0, Math.min(t, air.remaining));
            return { x: ball.x + air.vx * useT, y: ball.y + air.vy * useT };
        }
        const bnc = bm.bounceState;
        if (bnc) {
            const useT = Math.max(0, Math.min(t, bnc.remaining));
            return { x: ball.x + bnc.vx * useT, y: ball.y + bnc.vy * useT };
        }
        return null;
    }

    /**
     * t초 후 높이를 예측한다 (포물선 h = maxH·4·p·(1-p)).
     * @returns {number} 0~1 스케일. 비행 중이 아니면 현재 높이.
     */
    heightAt(ball, bm, t) {
        const air = bm.aerialState;
        if (air && air.duration > 0) {
            const p = Math.max(0, Math.min(1, (air.timer + t) / air.duration));
            return air.maxH * 4 * p * (1 - p);
        }
        const bnc = bm.bounceState;
        if (bnc && bnc.duration > 0) {
            const p = Math.max(0, Math.min(1, (bnc.timer + t) / bnc.duration));
            return bnc.maxHeight * 4 * p * (1 - p);
        }
        return ball.height ?? 0;
    }

    /**
     * 목표 높이에 도달하기까지 남은 시간을 역산한다.
     * @param {BallMovement} bm
     * @param {number} targetHeight 0~1 스케일
     * @returns {number} 남은 시간(초). 도달 불가면 -1.
     */
    timeToHeight(bm, targetHeight) {
        const air = bm.aerialState;
        if (!air || air.duration <= 0) return -1;
        const { maxH, timer, duration } = air;
        const progress = timer / duration;
        // 포물선 역산: -4·maxH·p² + 4·maxH·p - target = 0
        const a = -4 * maxH;
        const b = 4 * maxH;
        const c = -targetHeight;
        if (Math.abs(a) < 1e-9) return -1;
        const disc = b * b - 4 * a * c;
        if (disc < 0) return -1;
        const sqrtD = Math.sqrt(disc);
        const p1 = (-b + sqrtD) / (2 * a);
        const p2 = (-b - sqrtD) / (2 * a);
        const next = [p1, p2].filter((p) => p > progress && p <= 1);
        if (next.length === 0) return -1;
        return (Math.min(...next) - progress) * duration;
    }

    /**
     * 공이 헤딩 가능 높이 창구에 들어오는 첫 시점을 구한다.
     * @param {BallMovement} bm
     * @param {number} low 창구 하한 (기본 0.12)
     * @param {number} high 창구 상한 (기본 0.65)
     * @returns {number} 남은 시간(초). 창구 밖이면 -1.
     */
    timeToWindow(bm, low = 0.12, high = 0.65) {
        const air = bm.aerialState;
        if (!air) return -1;
        // 현재 높이가 이미 창구 안이면 즉시
        const curH = air.maxH * 4 * air.progress * (1 - air.progress);
        if (curH >= low && curH <= high) return 0;
        // 하강 구간에서 상한에 닿는 시점을 우선한다 (점프 타이밍 기준)
        const tHigh = this.timeToHeight(bm, high);
        if (tHigh >= 0) return tHigh;
        return this.timeToHeight(bm, low);
    }
}
