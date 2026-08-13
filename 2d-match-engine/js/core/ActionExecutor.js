import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

/** PhysicsEngine의 구름 마찰과 동일 — 킥 거리 예측에 사용 */
const BALL_DECEL = 2.4;   // PhysicsEngine.BALL_ROLL_FRICTION 과 동기화
const PASS_V_MAX  = 13;   // 지상 패스 최대 초기 속도 (m/s)

/**
 * 패스/클리어가 터치라인·엔드라인을 넘어가지 않도록 킥 세기를 제한한다.
 * 진행 방향으로 경기장을 벗어나기까지의 거리보다 멀리 굴러갈 세기라면,
 * 라인 안쪽에서 멈추도록 속도를 낮춘다.
 */
function containKickSpeed(fromPos, dir, speed) {
  const margin = 1.5;
  let maxTravel = Infinity;
  if (dir.x > 1e-6) maxTravel = Math.min(maxTravel, (Pitch.LENGTH - margin - fromPos.x) / dir.x);
  else if (dir.x < -1e-6) maxTravel = Math.min(maxTravel, (margin - fromPos.x) / dir.x);
  if (dir.y > 1e-6) maxTravel = Math.min(maxTravel, (Pitch.WIDTH - margin - fromPos.y) / dir.y);
  else if (dir.y < -1e-6) maxTravel = Math.min(maxTravel, (margin - fromPos.y) / dir.y);

  if (!Number.isFinite(maxTravel) || maxTravel <= 1.0) return speed;
  const travel = (speed * speed) / (2 * BALL_DECEL);
  // 살짝 넘치는 정도는 그대로 둔다(라인 아웃도 축구의 일부). 라인까지 거리의
  // 1.4배를 넘게 굴러갈 세기, 즉 명백히 "뜬금없이 걷어찬" 킥만 잡아준다.
  if (travel <= maxTravel * 1.4) return speed;
  return Math.max(4, Math.sqrt(2 * BALL_DECEL * maxTravel * 1.1));
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

    // 22m 이상이면 자동으로 공중볼(롱패스), 아니면 지정된 lofted 값 사용
    const isLong = intent.lofted || dist > 22;

    // v₀ = min(α·d + base, v_max) — 거리 비례 초기 속도, 상한 제한
    // 롱패스는 목표 도달에 필요한 최소 속도(√(2·a·d))로 계산해 과속 방지
    let speed;
    if (isLong) {
      speed = Math.min(PASS_V_MAX, Math.sqrt(2 * BALL_DECEL * dist) * 1.05);
    } else if (dist < 12) {
      speed = Math.min(10, 5.0 + dist * 0.38);  // 단거리: 5~10m/s
    } else {
      speed = Math.min(PASS_V_MAX, 4.5 + dist * 0.35);  // 중거리: ~9~13m/s
    }
    speed *= powerError;
    // passSpeed 능력치: 롱패스는 영향을 줄여 비행 속도를 일정하게 유지
    const psScale = (passer.attributes.passSpeed ?? 70) / 100;
    speed *= isLong ? 0.92 + psScale * 0.2 : 0.8 + psScale * 0.5;

    // 롱패스 고도를 크게 높여 체공 시간을 늘린다
    const vertical = isLong ? Math.min(12, 3.5 + dist * 0.20) : 0;

    // 의도한 방향(오차 적용 전) 기준으로 세기를 제한한다. 노린 대로 찼는데 라인 밖으로
    // 나가는 일은 없애되, 빗맞은 패스는 여전히 아웃될 수 있다(자연스러운 실수).
    speed = containKickSpeed(passer.position, aimDir, speed);

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
