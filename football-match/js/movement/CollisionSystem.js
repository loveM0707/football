import { Player } from '../entities/Player.js';
import { Ball }   from '../entities/Ball.js';

export class CollisionSystem {
    // Players can overlap up to 1/3 of body radius
    static MIN_PLAYER_DIST = Player.BODY_RADIUS * 2 * (2 / 3); // ≈ 13.3

    // Defender touches the ball
    static TACKLE_DIST = Player.BODY_RADIUS + Ball.RADIUS + 2; // 19
    // 정규화된 공 높이 기준. 이보다 높은 공은 점프한 선수도 건드리지 못한다.
    static MAX_AERIAL_REACH = 0.35;

    static isBodyCollision(p1, p2) {
        return Math.hypot(p1.x - p2.x, p1.y - p2.y) < CollisionSystem.MIN_PLAYER_DIST;
    }

    static isTackle(defender, ball, maxAerialReach = CollisionSystem.MAX_AERIAL_REACH) {
        if (ball.height > maxAerialReach) return false;
        return Math.hypot(defender.x - ball.x, defender.y - ball.y) < CollisionSystem.TACKLE_DIST;
    }

    /** Returns velocity to apply to ball after a tackle (ball bounces away from defender) */
    static bounceVelocity(defender, ball, speed = 250) {
        const dx  = ball.x - defender.x;
        const dy  = ball.y - defender.y;
        const len = Math.hypot(dx, dy) || 1;
        return { vx: (dx / len) * speed, vy: (dy / len) * speed };
    }
}
