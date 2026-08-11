import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

/**
 * PlayerBrain이 반환한 "의도(intent)"를 실제 선수 속도/공 속도 변화로 변환한다.
 * AI(의사결정)와 실행(물리적 결과)을 분리해두면 이후 AI 로직만 바꿔도 실행 계층은 그대로 재사용된다.
 */
export const ActionExecutor = {
  execute(player, intent, ball, eventBus) {
    switch (intent.type) {
      case 'MOVE':
        this._executeMove(player, intent);
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

  _executeMove(player, intent) {
    const toTarget = intent.target.sub(player.position);
    const dist = toTarget.length();
    const speedFactor = intent.sprint ? 1.0 : 0.7;
    let desiredSpeed = player.maxSpeed * speedFactor;
    if (dist < 1.2) desiredSpeed *= Math.max(0.15, dist / 1.2);

    player.desiredVelocity = dist > 1e-6 ? toTarget.normalize().scale(desiredSpeed) : Vector2D.zero();
    player.state = intent.sprint ? 'SPRINT' : 'MOVE';
  },

  _executePass(passer, intent, ball, eventBus) {
    const receiver = intent.targetPlayer;
    const toReceiver = receiver.position.sub(passer.position);
    const dist = Math.max(0.1, toReceiver.length());

    const passingAcc = passer.attributes.passing / 100;
    const angleError = (1 - passingAcc) * 0.32 * (Math.random() - 0.5) * 2;
    const dir = toReceiver.normalize().rotate(angleError);

    const speed = Math.min(27, 9 + dist * 0.55);
    const vertical = intent.lofted ? Math.min(6.5, 2.2 + dist * 0.07) : 0;

    ball.kick(dir.scale(speed), vertical);
    ball.isShot = false;

    passer.hasBall = false;
    passer.desiredVelocity = Vector2D.zero();
    passer.state = 'PASS';
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
    const power = 22 + accuracy * 10 + Math.random() * 3;
    const dist = shooter.position.sub(targetPoint).length();
    const vertical = dist > 16 ? 1.3 + Math.random() * 1.5 : 0;

    ball.kick(dir.scale(power), vertical);
    ball.isShot = true;

    shooter.hasBall = false;
    shooter.desiredVelocity = Vector2D.zero();
    shooter.state = 'SHOOT';
    eventBus.emit('shot', { by: shooter, team: shooter.team });
  },

  /** 드리블 중인 볼은 선수의 이동 방향 살짝 앞쪽, 발밑에 붙어 따라간다 */
  attachBallToCarrier(ball, player) {
    const facing = player.velocity.length() > 0.3 ? player.velocity.normalize() : new Vector2D(1, 0);
    ball.position = player.position.add(facing.scale(0.55));
    ball.velocity = player.velocity.clone();
    ball.height = 0;
    ball.verticalVelocity = 0;
  },
};
