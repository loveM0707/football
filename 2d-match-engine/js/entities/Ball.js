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
    this.kicker = null;           // 방금 공을 찬 선수
    this.kickLockTimer = 0;       // 이 시간 동안 kicker는 공을 다시 소유할 수 없다
    this.duelCooldown = 0;        // 태클 경합 판정 간격
    this.duelCount = 0;           // 연속 경합 횟수 (2회 초과 시 강제 종료)
    this.contest = null;          // 현재 몸싸움 경합 정보({ holder, challenger, timer, outcome })
    this.interceptionDone = false; // 이번 비행(킥) 동안의 가로채기 판정 여부
    this.headingCooldown = 0;     // 헤딩 재경합 방지 쿨다운
  }

  reset(position) {
    this.position = position.clone();
    this.velocity = Vector2D.zero();
    this.height = 0;
    this.verticalVelocity = 0;
    this.owner = null;
    this.isShot = false;
    this.passTargetPlayer = null;
    this.kicker = null;
    this.kickLockTimer = 0;
    this.duelCount = 0;
    this.contest = null;
    this.interceptionDone = false;
    this.headingCooldown = 0;
  }

  /**
   * ground velocity(Vector2D)와 선택적 수직 초기속도로 공을 찬다.
   * 찬 직후에는 공이 아직 발밑에 있으므로, 찬 선수가 곧바로 다시 잡아 패스가 취소되는 것을 막기 위해
   * 짧은 잠금 시간을 건다.
   */
  kick(groundVelocity, verticalVelocity = 0, kicker = null) {
    this.velocity = groundVelocity.clone();
    this.verticalVelocity = verticalVelocity;
    this.owner = null;
    this.kicker = kicker;
    this.kickLockTimer = 0.45;
    this.contest = null;
    this.interceptionDone = false; // 새 비행 시작 → 가로채기 판정 재개
    this.headingCooldown = 0;     // 새 킥 → 헤딩 판정 재개
  }

  isMoving() {
    return this.velocity.length() > 0.05 || this.height > 0.05;
  }

  speed() {
    return this.velocity.length();
  }
}
