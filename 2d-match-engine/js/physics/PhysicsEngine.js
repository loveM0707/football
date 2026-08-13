import { Vector2D } from '../entities/Vector2D.js';

const GRAVITY = 9.8;
// 승법적(Multiplicative) 감쇠 모델: v_{t+dt} = v_t × (1 - μ × dt)
// 총 이동 거리(지수 감쇠 적분): D = v₀ / μ  →  v₀ = D × μ + v_arrival
const BALL_MU_GROUND = 0.45;       // 지상 구름 마찰 계수 (per second) — ActionExecutor와 동기화
const BALL_MU_AIR    = 0.005;      // 공중 공기저항 계수 (per second) — 롱패스 체공 중 속도 거의 유지
const BALL_STOP_SPEED = 0.35;      // 지상에서 이 속도 이하면 완전 정지
const BOUNCE_DAMPING = 0.45;       // 바운드 시 수직 속도 감쇠 계수
const BOUNCE_H_DAMPING = 0.5;      // 바운드 시 수평 속도 감쇠 계수 — 땅에 튄 뒤에도 속도가 유지되는 현상 방지
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
      // 승법적 감쇠: v_{t+dt} = v_t × (1 - μ × dt)
      // 공중이면 공기저항(μ_air≈0), 지상이면 잔디 마찰(μ_ground)
      const mu = (ball.height > 0) ? BALL_MU_AIR : BALL_MU_GROUND;
      let newSpeed = speed * (1 - mu * dt);
      // 지상에서만 정지 임계값 적용 (공중볼은 자연스럽게 낙하할 때까지 유지)
      if (ball.height === 0 && newSpeed < BALL_STOP_SPEED) {
        ball.velocity = Vector2D.zero();
      } else if (newSpeed < 0.01) {
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
        ball.verticalVelocity =
          ball.verticalVelocity < -0.6 ? -ball.verticalVelocity * BOUNCE_DAMPING : 0;
        // 바운드 순간 수평 속도도 감쇠 — 롱패스가 착지한 뒤에도 거의 그대로
        // 굴러가던 속도가 유지돼 수신 지역을 지나쳐 버리는 문제를 막는다
        ball.velocity = ball.velocity.scale(BOUNCE_H_DAMPING);
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
