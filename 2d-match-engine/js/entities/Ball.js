import { Vector2D } from './Vector2D.js';
import { Pitch } from './Pitch.js';

export class Ball {
  constructor() {
    this.radius = 0.35; // meters (시각적으로 보이도록 실제 22cm보다 살짝 크게 설정)
    this.position = Pitch.center();
    this.velocity = Vector2D.zero();
    this.height = 0; // 미터, 0 = 지면
    this.verticalVelocity = 0;
    this.owner = null; // Player | null
    this.lastTouchedBy = null;
    this.lastTouchedTeam = null;
    this.isShot = false;
    this.passTargetPlayer = null; // 패스 수신 예상 선수
  }

  reset(position) {
    this.position = position.clone();
    this.velocity = Vector2D.zero();
    this.height = 0;
    this.verticalVelocity = 0;
    this.owner = null;
    this.isShot = false;
    this.passTargetPlayer = null;
  }

  /** ground velocity(Vector2D)와 선택적 수직 초기속도로 공을 찬다 */
  kick(groundVelocity, verticalVelocity = 0) {
    this.velocity = groundVelocity.clone();
    this.verticalVelocity = verticalVelocity;
    this.owner = null;
  }

  isMoving() {
    return this.velocity.length() > 0.05 || this.height > 0.05;
  }

  speed() {
    return this.velocity.length();
  }
}
