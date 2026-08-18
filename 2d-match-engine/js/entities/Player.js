import { Vector2D } from './Vector2D.js';

const DEFAULT_ATTRIBUTES = {
  pace: 70,
  acceleration: 70,
  stamina: 70,
  passing: 70,
  shooting: 70,
  tackling: 70,
  positioning: 70,
  dribbling: 70,
  strength: 70,
  reflexes: 65,
  vision: 70,
  agility: 70,
  interception: 60,
  passSpeed: 70,      // 패스 속도: 공의 초기 속도에 영향
  shotSpeed: 70,      // 슈팅 속도: 슛 시 공의 초기 비행 속도
  decisionMaking: 70, // 판단력: 최적 행동 선택 시 랜덤 에러 확률
  power: 70,          // 파워: 태클/몸싸움 승률 계산에 추가 사용
  jumping: 65,        // 점프력: 공중볼 경합(헤딩) 승률에 영향
  heading: 65,        // 헤딩: 헤딩 패스/슛의 정확도와 파워
  physical: 70,       // 피지컬: 몸싸움(볼 소유 유지)과 헤딩 경합 승률의 핵심 능력치.
                       // 센터포워드·센터백이 평균적으로 높다.
};

let nextId = 1;

export class Player {
  constructor({ name, number, role, attributes = {}, team = null }) {
    this.id = nextId++;
    this.name = name;
    this.number = number;
    this.role = role; // 'GK','LB','CB','RB','LM','CM','RM','ST' 등
    this.attributes = { ...DEFAULT_ATTRIBUTES, ...attributes };
    this.team = team;

    this.position = Vector2D.zero();
    this.velocity = Vector2D.zero();
    this.desiredVelocity = Vector2D.zero();
    this.basePosition = Vector2D.zero();
    this.normalizedBase = null; // 포메이션 정규화 좌표 (0~1)

    // 선수가 바라보는 방향(라디안). facingAngle은 매 틱 desiredFacingAngle을 향해
    // 제한된 각속도로 서서히 회전한다(순간 방향전환 방지).
    this.facingAngle = 0;
    this.desiredFacingAngle = 0;

    this.state = 'POSITIONING';
    this.stamina = 100; // 0~100, 100 = 완전 체력
    this.hasBall = false;
    // 정지 상태에서 스프린트(3단계)까지 가속하는 데 걸린 경과 시간(초).
    // PhysicsEngine이 매 틱 갱신하며, 가속도 능력치가 높을수록 3단계에 더 빨리 도달한다.
    this._rampTimer = 0;

    // FSM/의사결정 쿨다운 등 브레인 전용 스크래치 메모리
    // 개인별 성향으로 다양한 플레이 스타일 구현
    this.brainMemory = {
      decisionCooldown: 0,
      aggressiveness: 0.5 + Math.random() * 0.5,     // 0.5~1: 공격적일수록 높음
      defensiveness: 0.4 + Math.random() * 0.6,      // 0.4~1: 수비적일수록 높음
      creativity: 0.3 + Math.random() * 0.7,         // 0.3~1: 창의적일수록 높음 (드리블, 롱패스 선호)
      riskTolerance: 0.4 + Math.random() * 0.6,      // 0.4~1: 위험을 감수할수록 높음
    };
  }

  get maxSpeed() {
    const paceFactor = 3.8 + (this.attributes.pace / 100) * 2.4; // 3.8 ~ 6.2 m/s
    const staminaFactor = 0.55 + 0.45 * (this.stamina / 100);
    return paceFactor * staminaFactor;
  }

  get acceleration() {
    return 2.6 + (this.attributes.acceleration / 100) * 3.0;
  }

  /**
   * 드리블(공 소유 중 이동) 속도 배율 — 드리블 능력치가 높을수록 볼을 갖고도
   * 빠르게 움직인다. 0.88(드리블 0) ~ 1.12(드리블 100).
   */
  get dribbleSpeedMultiplier() {
    return 0.88 + (this.attributes.dribbling / 100) * 0.24;
  }

  reset(position) {
    this.position = position.clone();
    this.velocity = Vector2D.zero();
    this.desiredVelocity = Vector2D.zero();
    this.state = 'POSITIONING';
    this.hasBall = false;
    this._rampTimer = 0;
    if (this.team) {
      this.facingAngle = this.team.attackingDirection === 1 ? 0 : Math.PI;
      this.desiredFacingAngle = this.facingAngle;
    }
  }
}
