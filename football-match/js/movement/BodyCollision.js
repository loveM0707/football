/**
 * BodyCollision - 선수 몸통 충돌 분리 모듈
 *
 * 선수들이 완전히 겹쳐 서로를 관통하는 것을 방지하기 위해,
 * 두 선수의 몸통이 일정 비율(기본 50%) 이상 겹치지 않도록 밀어낸다.
 *
 * 실제 축구 공통 로직이므로 메뉴/실경기 어디서든 재사용한다.
 *
 * 사용법:
 *   import { BodyCollision } from './BodyCollision.js';
 *   // 매 프레임, 모든 선수 이동 후:
 *   BodyCollision.separatePlayers([p1, p2, p3, ...]);
 */
import { Player } from '../entities/Player.js';

export class BodyCollision {
    /** 최소 중심 간격 = 몸통 반지름 × (2 − maxOverlapRatio) */
    static DEFAULT_MAX_OVERLAP_RATIO = 0.5; // 몸통의 50%까지만 겹침 허용
    static MIN_SEPARATION = Player.BODY_RADIUS * 2 * (1 - BodyCollision.DEFAULT_MAX_OVERLAP_RATIO);

    /**
     * 두 선수가 허용 한계보다 가까우면 서로 밀어낸다.
     * 각 선수의 원래 방향(angle)은 유지하면서 위치만 보정한다.
     *
     * @param {Player} a
     * @param {Player} b
     * @param {number} minSeparation  최소 중심 간격 (기본 MIN_SEPARATION)
     * @returns {boolean} 분리가 일어났으면 true
     */
    static separate(a, b, minSeparation = BodyCollision.MIN_SEPARATION) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= minSeparation || dist < 0.0001) return false;

        // 분리 벡터: 각 선수를 절반씩 밀어냄
        const push = (minSeparation - dist) / 2;
        const nx = dx / dist;
        const ny = dy / dist;

        a.setPosition(a.x - nx * push, a.y - ny * push);
        b.setPosition(b.x + nx * push, b.y + ny * push);
        return true;
    }

    /**
     * 여러 선수 간 몸통 충돌을 모두 해소한다.
     * 이중 루프로 모든 쌍을 검사해 겹침을 반복 해소한다.
     *
     * @param {Player[]} players
     * @param {number} minSeparation  최소 중심 간격 (기본 MIN_SEPARATION)
     * @param {number} maxPasses      최대 반복 횟수 (기본 4 — 복잡한 군집에서도 안정)
     */
    static separatePlayers(players, minSeparation = BodyCollision.MIN_SEPARATION, maxPasses = 4) {
        if (!players || players.length < 2) return;
        for (let pass = 0; pass < maxPasses; pass++) {
            let moved = false;
            for (let i = 0; i < players.length; i++) {
                for (let j = i + 1; j < players.length; j++) {
                    if (BodyCollision.separate(players[i], players[j], minSeparation)) moved = true;
                }
            }
            if (!moved) break;
        }
    }
}