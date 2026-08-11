import { Vector2D } from '../entities/Vector2D.js';

const GRAVITY = 9.8; // m/s^2
const BALL_ROLL_FRICTION = 3.4; // m/s^2, 잔디 위 구름 마찰에 의한 감속
const BOUNCE_DAMPING = 0.45;

export const PhysicsEngine = {
  /** 공의 지면 이동(마찰) + 높이(포물선/바운스) 갱신 */
  updateBall(ball, dt) {
    const speed = ball.velocity.length();
    if (speed > 0) {
      const decel = BALL_ROLL_FRICTION * dt;
      const newSpeed = Math.max(0, speed - decel);
      ball.velocity = newSpeed > 0 ? ball.velocity.normalize().scale(newSpeed) : Vector2D.zero();
    }
    ball.position = ball.position.add(ball.velocity.scale(dt));

    if (ball.height > 0 || ball.verticalVelocity !== 0) {
      ball.verticalVelocity -= GRAVITY * dt;
      ball.height += ball.verticalVelocity * dt;
      if (ball.height <= 0) {
        ball.height = 0;
        ball.verticalVelocity =
          ball.verticalVelocity < -0.6 ? -ball.verticalVelocity * BOUNCE_DAMPING : 0;
      }
    }
  },

  /** 선수는 desiredVelocity를 향해 가속도 한도 내에서 가속/감속한다 */
  movePlayer(player, dt) {
    const diff = player.desiredVelocity.sub(player.velocity);
    const diffLen = diff.length();
    const maxDeltaV = player.acceleration * dt;

    if (diffLen <= maxDeltaV || diffLen < 1e-6) {
      player.velocity = player.desiredVelocity.clone();
    } else {
      player.velocity = player.velocity.add(diff.normalize().scale(maxDeltaV));
    }

    player.position = player.position.add(player.velocity.scale(dt));

    // 이동 거리에 비례해 서서히 체력을 소모하고, 저속일 때는 소폭 회복시킨다
    const speed = player.velocity.length();
    if (speed > player.maxSpeed * 0.6) {
      player.stamina = Math.max(0, player.stamina - dt * 0.35);
    } else {
      player.stamina = Math.min(100, player.stamina + dt * 0.15);
    }
  },
};
