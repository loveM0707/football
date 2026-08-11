import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

/**
 * PlayerBrain이 반환한 "의도(intent)"를 실제 선수 속도/공 속도/바라보는 방향 변화로 변환한다.
 * AI(의사결정)와 실행(물리적 결과)을 분리해두면 이후 AI 로직만 바꿔도 실행 계층은 그대로 재사용된다.
 */
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
    // speedFactor: 명시적으로 지정되면 그 값, 없으면 sprint 여부로 결정 (0.45~1.0의 다단계 속도 지원)
    const speedFactor = intent.speedFactor ?? (intent.sprint ? 1.0 : 0.7);
    let desiredSpeed = player.maxSpeed * speedFactor;
    if (dist < 1.2) desiredSpeed *= Math.max(0.15, dist / 1.2);

    player.desiredVelocity = dist > 1e-6 ? toTarget.normalize().scale(desiredSpeed) : Vector2D.zero();
    player.state = intent.sprint ? 'SPRINT' : 'MOVE';

    // 바라보는 방향: 실제로 뛰고 있을 때는(달리기 침투 포함) 진행 방향을 보고,
    // 공을 가진 채 멈춰 있을 때는 전방을 살피며, 공 없이 자리를 지킬 때는 볼을 바라본다
    // (스루패스를 받으러 뛰어가는 상황은 이동 중이므로 자연히 진행 방향을 보게 된다).
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
  },

  _executePass(passer, intent, ball, eventBus) {
    const receiver = intent.targetPlayer;
    const rawDist = receiver.position.sub(passer.position).length();

    // 전진하는 동료를 향해 리드 패스: 받는 선수의 현재 속도를 반영해 조금 앞쪽을 노린다
    const leadTime = Math.min(1.1, rawDist / 16);
    const aimPoint = receiver.position.add(receiver.velocity.scale(leadTime));
    const toAim = aimPoint.sub(passer.position);
    const dist = Math.max(0.1, toAim.length());

    const passingAcc = passer.attributes.passing / 100;
    const angleError = (1 - passingAcc) * 0.3 * (Math.random() - 0.5) * 2;
    const dir = toAim.normalize().rotate(angleError);

    // 스로인은 최대 10m 거리로 제한, 일반 패스는 거리에 따라 가속
    let speed;
    if (!intent.lofted && dist < 11) {
      // 스로인: 거리에 따라 6~12 m/s
      speed = Math.min(12, 6 + dist * 0.5);
    } else {
      // 일반 패스/킥: 거리에 따라 6~19 m/s
      speed = Math.min(19, 6 + dist * 0.4);
    }

    const vertical = intent.lofted ? Math.min(5.5, 1.8 + dist * 0.06) : 0;

    ball.kick(dir.scale(speed), vertical, passer);
    ball.isShot = false;
    ball.passTargetPlayer = receiver; // 수신자 정보 저장

    passer.hasBall = false;
    passer.desiredVelocity = Vector2D.zero();
    passer.state = 'PASS';
    // 패스하는 순간에는 즉시 패스 방향을 정면으로 바라본다(회전 애니메이션 대기 없이 스냅)
    passer.facingAngle = dir.angle();
    passer.desiredFacingAngle = passer.facingAngle;
    eventBus.emit('pass', { from: passer, to: receiver, team: passer.team });
  },

  _executeShoot(shooter, intent, ball, eventBus) {
    const opponentGoalSide = shooter.team.attackingDirection === 1 ? 'right' : 'left';
    const goalX = opponentGoalSide === 'left' ? 0 : Pitch.LENGTH;
    const [topY, bottomY] = Pitch.goalYRange();

    const accuracy = shooter.attributes.shooting / 100;
    const spread = 0.15 + (1 - accuracy) * 0.9;
    let targetY = topY + (bottomY - topY) * (0.5 + (Math.random() - 0.5) * spread);

    const wideMissChance = (1 - accuracy) * 0.25;
    if (Math.random() < wideMissChance) {
      targetY = Math.random() < 0.5 ? topY - 3 - Math.random() * 3 : bottomY + 3 + Math.random() * 3;
    }

    const targetPoint = new Vector2D(goalX, targetY);
    const dir = targetPoint.sub(shooter.position).normalize();
    const power = 16 + accuracy * 8 + Math.random() * 2;
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
};
