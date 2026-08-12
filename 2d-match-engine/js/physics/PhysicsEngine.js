import { Vector2D } from '../entities/Vector2D.js';

const GRAVITY = 9.8;
const BALL_ROLL_FRICTION = 3.4;
const BOUNCE_DAMPING = 0.45;
const MAX_TURN_RATE = Math.PI * 5.5; // rad/s — 빠른 방향전환 (360도 회전 방지)

function normalizeAngle(angle) {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export const PhysicsEngine = {
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

  movePlayer(player, dt) {
    const diff = player.desiredVelocity.sub(player.velocity);
    const diffLen = diff.length();
    // 가속도를 1.6배로 높여 관성/미끄러짐을 줄이고 방향전환을 즉각적으로 만든다
    const accel = player.acceleration * 1.6;
    // 감속(정지/방향전환) 시에는 가속도를 더 높여 미끄러짐 방지
    const desiredSpeed = player.desiredVelocity.length();
    const currentSpeed = player.velocity.length();
    const isDecelerating = desiredSpeed < currentSpeed * 0.5;
    const effectiveAccel = isDecelerating ? accel * 1.8 : accel;
    const maxDeltaV = effectiveAccel * dt;

    if (diffLen <= maxDeltaV || diffLen < 1e-6) {
      player.velocity = player.desiredVelocity.clone();
    } else {
      player.velocity = player.velocity.add(diff.normalize().scale(maxDeltaV));
    }

    player.position = player.position.add(player.velocity.scale(dt));

    const speed = player.velocity.length();
    if (speed > player.maxSpeed * 0.6) {
      player.stamina = Math.max(0, player.stamina - dt * 0.35);
    } else {
      player.stamina = Math.min(100, player.stamina + dt * 0.15);
    }

    const angleDiff = normalizeAngle(player.desiredFacingAngle - player.facingAngle);
    const maxDelta = MAX_TURN_RATE * dt;
    if (Math.abs(angleDiff) <= maxDelta) {
      player.facingAngle = player.desiredFacingAngle;
    } else {
      player.facingAngle = normalizeAngle(player.facingAngle + Math.sign(angleDiff) * maxDelta);
    }
  },
};
