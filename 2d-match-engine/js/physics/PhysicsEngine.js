import { Vector2D } from '../entities/Vector2D.js';

const GRAVITY = 9.8;
// 지상: 선형 감쇠 (등가속도) — newSpeed = speed - BALL_MU_GROUND × dt
// 공중: 승법적 감쇠 (공기저항) — newSpeed = speed × (1 - BALL_MU_AIR × dt)
const BALL_MU_GROUND  = 2.6;    // 지상 감속 가속도 (m/s²) — ActionExecutor와 동기화 (2.4 → 2.6: 볼 구름 약간 감소)
const BALL_MU_AIR     = 0.005;  // 공중 공기저항 계수 (per second)
const BALL_STOP_SPEED = 0.05;   // 선형 감쇠 후 잔여 미세 속도 제거용 임계값 (낮게 유지)
const BOUNCE_V_DAMPING   = 0.45;  // 수직 반발 계수 (바운드 높이 감쇠)
const BOUNCE_H_DAMPING   = 0.85;  // 수평 속도 유지 계수 — 롱패스 착지 후 관성 유지
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
      let newSpeed;
      if (ball.height > 0) {
        // 공중: 승법적 감쇠 (공기저항, 속도 거의 유지)
        newSpeed = speed * (1 - BALL_MU_AIR * dt);
      } else {
        // 지상: 선형 감쇠 (등가속도 마찰력)
        // newSpeed = speed - μ × dt → 자연스럽게 0에 수렴
        newSpeed = speed - BALL_MU_GROUND * dt;
      }
      if (newSpeed <= BALL_STOP_SPEED) {
        ball.velocity = Vector2D.zero();
      } else {
        ball.velocity = ball.velocity.normalize().scale(newSpeed);
      }
    }
    ball.position = ball.position.add(ball.velocity.scale(dt));

    if (ball.height > 0 || ball.verticalVelocity !== 0) {
      ball.verticalVelocity -= GRAVITY * dt;
      ball.height += ball.verticalVelocity * dt;
      if (ball.height <= 0) {
        ball.height = 0;
        if (ball.verticalVelocity < -0.6) {
          // 수직 반발 (높이 감쇠)
          ball.verticalVelocity = -ball.verticalVelocity * BOUNCE_V_DAMPING;
          // 수평 속도 완화 감쇠 — 롱패스 착지 후 관성 유지
          ball.velocity = ball.velocity.scale(BOUNCE_H_DAMPING);
        } else {
          ball.verticalVelocity = 0;
        }
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
