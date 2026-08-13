import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

// ─── 공 물리 상수 (PhysicsEngine과 동기화) ──────────────────────
// 승법적 감쇠 모델: v_{t+dt} = v_t × (1 − μ × dt)
// 총 이동 거리(지수 적분): D = v₀ / μ  →  v₀ = D × μ + v_arrival
const BALL_MU_GROUND = 0.45;   // 지상 구름 마찰 계수 (per second)
const BALL_MU_AIR    = 0.005;  // 공중 공기저항 계수 (per second, 롱패스 체공 중 거의 속도 유지)
const GRAVITY        = 9.8;    // 중력 가속도 (m/s²)
const PASS_V_MAX     = 28;     // 패스 최대 초기 속도 (m/s) — 롱패스 도달 가능하도록 상향
const D_LONG         = 30;     // 이 거리(m) 이상은 공중 롱패스 처리 (≈ 경기장 폭 절반)
const V_ARRIVAL      = 3.0;    // 수신자 발밑 도착 기대 속도 (m/s)

/**
 * 지상 패스/클리어가 터치라인·엔드라인을 넘어가지 않도록 킥 세기를 제한한다.
 * 공중볼(isLofted)은 포물선 궤도이므로 이 제한을 적용하지 않는다.
 * D = v / μ (승법적 모델의 총 이동 거리 공식)
 */
function containKickSpeed(fromPos, dir, speed, isLofted = false) {
  if (isLofted) return speed; // 공중볼: 포물선 궤도이므로 지상 거리 제한 미적용
  const margin = 1.5;
  let maxTravel = Infinity;
  if (dir.x > 1e-6) maxTravel = Math.min(maxTravel, (Pitch.LENGTH - margin - fromPos.x) / dir.x);
  else if (dir.x < -1e-6) maxTravel = Math.min(maxTravel, (margin - fromPos.x) / dir.x);
  if (dir.y > 1e-6) maxTravel = Math.min(maxTravel, (Pitch.WIDTH - margin - fromPos.y) / dir.y);
  else if (dir.y < -1e-6) maxTravel = Math.min(maxTravel, (margin - fromPos.y) / dir.y);

  if (!Number.isFinite(maxTravel) || maxTravel <= 1.0) return speed;
  const travel = speed / BALL_MU_GROUND; // D = v / μ (승법적 모델)
  if (travel <= maxTravel * 1.4) return speed;
  return Math.max(4, maxTravel * 1.1 * BALL_MU_GROUND);
}

export const ActionExecutor = {
  execute(player, intent, ball, eventBus) {
    switch (intent.type) {
      case 'MOVE':
        this._executeMove(player, intent, ball);
        break;
      case 'PASS':
        this._executePass(player, intent, ball, eventBus);
        break;
      case 'SHOOT':
        this._executeShoot(player, intent, ball, eventBus);
        break;
      case 'CLEAR':
        this._executeClear(player, intent, ball, eventBus);
        break;
      case 'HOLD':
      default:
        player.desiredVelocity = Vector2D.zero();
        player.state = 'HOLD';
        break;
    }
  },

  _executeMove(player, intent, ball) {
    const toTarget = intent.target.sub(player.position);
    const dist = toTarget.length();
    const speedFactor = intent.speedFactor ?? (intent.sprint ? 1.0 : 0.7);
    let desiredSpeed = player.maxSpeed * speedFactor;
    if (dist < 1.2) desiredSpeed *= Math.max(0.15, dist / 1.2);

    player.desiredVelocity = dist > 1e-6 ? toTarget.normalize().scale(desiredSpeed) : Vector2D.zero();
    player.state = intent.sprint ? 'SPRINT' : 'MOVE';

    if (player.hasBall && dist > 0.5) {
      // 드리블 중: 진행 방향으로 facingAngle 즉시 스냅 (360도 회전 방지)
      player.desiredFacingAngle = toTarget.angle();
      player.facingAngle = player.desiredFacingAngle;
    } else {
      const moveSpeed = player.velocity.length();
      if (moveSpeed > 1.0) {
        player.desiredFacingAngle = dist > 0.2 ? toTarget.angle() : player.velocity.angle();
      } else if (player.hasBall) {
        const attackDir = player.team.attackingDirection;
        player.desiredFacingAngle = attackDir === 1 ? 0 : Math.PI;
      } else if (ball) {
        const toBall = ball.position.sub(player.position);
        if (toBall.length() > 0.3) player.desiredFacingAngle = toBall.angle();
      }
    }
  },

  _executePass(passer, intent, ball, eventBus) {
    const receiver = intent.targetPlayer;

    // 스루패스(Through Pass): targetPos가 있으면 수신자 현위치 대신 미래 빈 공간으로 차낸다
    const aimPoint = intent.targetPos
      ? intent.targetPos.clone()
      : (() => {
          const rawDist = receiver.position.sub(passer.position).length();
          const leadTime = Math.min(1.1, rawDist / 16);
          return receiver.position.add(receiver.velocity.scale(leadTime));
        })();

    let toAim = aimPoint.sub(passer.position);
    const dist = Math.max(0.1, toAim.length());

    // ── 실수(Error) 로직: 낮은 패스/시야 능력치 + 높은 압박 → 목표 오차 증가 ──
    const passingSkill = passer.attributes.passing / 100;
    const vision = (passer.attributes.vision ?? passer.attributes.positioning) / 100;
    const pressurePenalty = (intent.pressure ?? 0) / 100;
    const skillError = 1 - passingSkill * 0.7 - vision * 0.3;
    const errorScale = skillError * (0.35 + pressurePenalty * 0.9);

    // 각도 오차(rad) + 세기 오차
    const angleError = (Math.random() - 0.5) * 2 * errorScale * 0.55;
    const powerError = 1 + (Math.random() - 0.5) * errorScale * 0.5;
    const aimDir = toAim.normalize();
    let dir = aimDir.rotate(angleError);

    // 극단 상황(고압박 + 저실력)에서는 빗맞는다. 다만 완전히 반대로 차버리지는
    // 않도록 각도 폭을 좁혀 뜬금없이 라인 밖으로 나가는 현상을 막는다.
    const misplaceChance = errorScale * 0.20;
    if (Math.random() < misplaceChance) {
      const badAngle = (Math.random() - 0.5) * 1.4; // ±약 40도
      dir = dir.rotate(badAngle);
    }

    // D_LONG(30m) 이상이면 공중 롱패스, 아니면 지정된 lofted 값 사용
    const isLong = intent.lofted || dist >= D_LONG;

    // 롱패스 고도: 거리에 비례해 높게 차올려 체공 시간 확보
    // vertical이 클수록 t_air = 2·v_vert/g 가 길어져 수평 속도를 낮출 수 있음
    const vertical = isLong ? Math.min(14, 4.0 + dist * 0.22) : 0;

    // ── 초기 속도 역산 (Required Initial Velocity) ────────────────
    // • 지상 패스: v₀ = d × μ_ground + v_arrival  (승법적 감쇠 역산)
    //   총 이동 거리 D = v₀ / μ이므로, 타겟까지 d를 커버하려면 v₀ = d·μ + v_arrival
    // • 공중 롱패스: 체공 중 마찰 거의 없으므로 비행시간 기반 역산
    //   t_air = 2·v_vert / g,  v_h = d / t_air = d·g / (2·v_vert)
    let speed;
    if (isLong) {
      // 비행시간 기반 수평 속도: 공이 정확히 dist에 착지하도록
      speed = dist * GRAVITY / (2 * Math.max(1, vertical));
    } else if (dist < 10) {
      speed = 4.5 + dist * 0.45;                        // 단거리: 4.5~9 m/s
    } else {
      speed = dist * BALL_MU_GROUND + V_ARRIVAL;         // 중거리: v₀ = d·μ + v_arr
    }
    speed *= powerError;
    // passSpeed 능력치: 롱패스는 영향을 줄여 비행 속도를 일정하게 유지
    const psScale = (passer.attributes.passSpeed ?? 70) / 100;
    speed *= isLong ? 0.92 + psScale * 0.2 : 0.8 + psScale * 0.5;

    // V_max 클램프: 초과 시 수신자가 computeInterceptionPoint로 공 쪽으로 마중 나감
    speed = Math.min(PASS_V_MAX, speed);

    // 지상 패스만 구역 이탈 방지 적용 (공중볼은 포물선 궤도라 적용 불필요)
    speed = containKickSpeed(passer.position, aimDir, speed, isLong);

    ball.kick(dir.scale(speed), vertical, passer);
    ball.isShot = false;
    ball.passTargetPlayer = receiver;

    passer.hasBall = false;
    passer.desiredVelocity = Vector2D.zero();
    passer.state = 'PASS';
    passer.facingAngle = dir.angle();
    passer.desiredFacingAngle = passer.facingAngle;
    eventBus.emit('pass', { from: passer, to: receiver, team: passer.team });
  },

  _executeShoot(shooter, intent, ball, eventBus) {
    const opponentGoalSide = shooter.team.attackingDirection === 1 ? 'right' : 'left';
    const goalX = opponentGoalSide === 'left' ? 0 : Pitch.LENGTH;
    const [topY, bottomY] = Pitch.goalYRange();

    const accuracy = shooter.attributes.shooting / 100;
    // ── 실수(Error) 로직: 슛 능력치가 낮거나 압박이 심하면 오차 증가 ──
    const pressurePenalty = (intent.pressure ?? 0) / 100;
    const spread = 0.15 + (1 - accuracy) * (0.9 + pressurePenalty * 0.8);
    let targetY = topY + (bottomY - topY) * (0.5 + (Math.random() - 0.5) * spread);

    const wideMissChance = (1 - accuracy) * 0.25 + pressurePenalty * 0.12;
    if (Math.random() < wideMissChance) {
      targetY = Math.random() < 0.5 ? topY - 3 - Math.random() * 3 : bottomY + 3 + Math.random() * 3;
    }

    const targetPoint = new Vector2D(goalX, targetY);
    const dir = targetPoint.sub(shooter.position).normalize();
    // shotSpeed 능력치: 0.85~1.25배 범위로 슈팅 파워 조절
    const shotSpeedScale = 0.85 + (shooter.attributes.shotSpeed ?? 70) / 100 * 0.4;
    const power = (16 + accuracy * 8 + Math.random() * 2) * shotSpeedScale;
    const dist = shooter.position.sub(targetPoint).length();
    const vertical = dist > 16 ? 1.1 + Math.random() * 1.3 : 0;

    ball.kick(dir.scale(power), vertical, shooter);
    ball.isShot = true;

    shooter.hasBall = false;
    shooter.desiredVelocity = Vector2D.zero();
    shooter.state = 'SHOOT';
    shooter.facingAngle = dir.angle();
    shooter.desiredFacingAngle = shooter.facingAngle;
    eventBus.emit('shot', { by: shooter, team: shooter.team });
  },

  _executeClear(player, intent, ball, eventBus) {
    const attackDir = player.team.attackingDirection;
    // 자기 진영 깊은 곳에서 → 전방 + 약간 측면으로 롱킥
    const lateralOffset = (Math.random() - 0.5) * 20;
    const targetX = player.position.x + attackDir * 45;
    const targetY = Math.max(5, Math.min(Pitch.WIDTH - 5, Pitch.WIDTH / 2 + lateralOffset));
    const target = new Vector2D(targetX, targetY);
    const dir = target.sub(player.position).normalize();
    // 라인 밖으로 걷어차 버리지 않도록 세기를 제한한다
    const speed = containKickSpeed(player.position, dir, 14 + Math.random() * 4);

    ball.kick(dir.scale(speed), 5.5 + Math.random() * 2.5, player);
    ball.isShot = false;
    ball.passTargetPlayer = null;

    player.hasBall = false;
    player.desiredVelocity = Vector2D.zero();
    player.state = 'PASS';
    player.facingAngle = dir.angle();
    player.desiredFacingAngle = player.facingAngle;
    eventBus.emit('clear', { by: player, team: player.team });
  },
};
