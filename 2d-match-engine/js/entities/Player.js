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

    this.state = 'POSITIONING';
    this.stamina = 100; // 0~100, 100 = 완전 체력
    this.hasBall = false;

    // FSM/의사결정 쿨다운 등 브레인 전용 스크래치 메모리
    this.brainMemory = { decisionCooldown: 0 };
  }

  get maxSpeed() {
    const paceFactor = 5.2 + (this.attributes.pace / 100) * 3.3; // 5.2 ~ 8.5 m/s
    const staminaFactor = 0.55 + 0.45 * (this.stamina / 100);
    return paceFactor * staminaFactor;
  }

  get acceleration() {
    return 4 + (this.attributes.acceleration / 100) * 4.5;
  }

  reset(position) {
    this.position = position.clone();
    this.velocity = Vector2D.zero();
    this.desiredVelocity = Vector2D.zero();
    this.state = 'POSITIONING';
    this.hasBall = false;
  }
}
