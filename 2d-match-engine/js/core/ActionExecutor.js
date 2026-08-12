import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

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
    let dir = toAim.normalize().rotate(angleError);

    // 극단 상황(고압박 + 저실력)에서는 엉뚱한 방향으로 빗나간다
    const misplaceChance = errorScale * 0.45;
    if (Math.random() < misplaceChance) {
      const badAngle = (Math.random() - 0.5) * Math.PI * 1.6;
      dir = dir.rotate(badAngle);
    }

    // 25m 이상이면 자동으로 공중볼(롱패스), 아니면 지정된 lofted 값 사용
    const isLong = intent.lofted || dist > 25;

    let speed;
    if (!isLong && dist < 11) {
      speed = Math.min(12, 6 + dist * 0.5);
    } else {
      speed = Math.min(19, 6 + dist * 0.4);
    }
    speed *= powerError;
    // passSpeed 능력치: 0.8~1.3배 범위로 공 초기 속도 조절
    speed *= 0.8 + (passer.attributes.passSpeed ?? 70) / 100 * 0.5;

    const vertical = isLong ? Math.min(6.5, 2.0 + dist * 0.08) : 0;

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
    const speed = 14 + Math.random() * 4;

    ball.kick(dir.scale(speed), 4.5 + Math.random() * 2, player);
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
