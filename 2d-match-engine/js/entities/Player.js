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
  reflexes: 65, // 골키퍼 전용, 필드 플레이어는 사용되지 않음
  vision: 70, // 시야: 패스 옵션 인식/오차에 영향
  agility: 70, // 민첩성: 경합(태클 대 드리블)에서 공격수 방어력에 영향
  interception: 60, // 가로채기: 패스/슛 궤적 차단 능력
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

  reset(position) {
    this.position = position.clone();
    this.velocity = Vector2D.zero();
    this.desiredVelocity = Vector2D.zero();
    this.state = 'POSITIONING';
    this.hasBall = false;
    if (this.team) {
      this.facingAngle = this.team.attackingDirection === 1 ? 0 : Math.PI;
      this.desiredFacingAngle = this.facingAngle;
    }
  }
}
