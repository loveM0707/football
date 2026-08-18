/**
 * 감독(유저)의 전술 지침을 AI 모듈이 바로 사용할 수 있는 수치 파라미터로 변환한다.
 * mentality/tempo/width/pressing/passingDirectness/defensiveLineHeight 는 0~1(혹은 열거형)로 입력받고,
 * OffTheBallMovement, PlayerBrain 등에서 곧바로 소비 가능한 파생값을 getter로 제공한다.
 */
export class TeamInstructions {
  constructor({
    mentality = 'balanced', // 'defensive' | 'balanced' | 'attacking'
    tempo = 0.5, // 0 (느림) ~ 1 (빠름)
    width = 0.5, // 0 (좁게) ~ 1 (넓게)
    pressing = 0.5, // 0 (물러서기) ~ 1 (전원수비)
    passingDirectness = 0.4, // 0 (짧은 패스) ~ 1 (직선적/롱볼)
    defensiveLineHeight = 0.5, // 0 (깊음) ~ 1 (높은 라인)
    attackDirectness = 0.5, // 0 (측면 위주) ~ 1 (중앙 위주)
    tackleAggression = 0.5, // 0 (신중하게) ~ 1 (헌신적)
    gkDistribution = 0.5, // 0 (짧은 패스) ~ 1 (긴 패스)
  } = {}) {
    this.mentality = mentality;
    this.tempo = tempo;
    this.width = width;
    this.pressing = pressing;
    this.passingDirectness = passingDirectness;
    this.defensiveLineHeight = defensiveLineHeight;
    this.attackDirectness = attackDirectness;
    this.tackleAggression = tackleAggression;
    this.gkDistribution = gkDistribution;
  }

  /** 공격 시 기본 위치를 얼마나 전진시킬지 (미터) */
  get mentalityForwardBiasMeters() {
    return { defensive: -5, balanced: 0, attacking: 5 }[this.mentality] ?? 0;
  }

  /** 팀 폭 배율: 기본 포메이션 y좌표를 센터 기준으로 확장/축소 */
  get widthMultiplier() {
    return 0.75 + this.width * 0.5; // 0.75 ~ 1.25
  }

  /** 압박을 시작할 거리(미터). 높을수록 더 먼 거리에서부터 압박 */
  get pressingTriggerDistance() {
    return 10 + this.pressing * 18; // 10 ~ 28m
  }

  /** 수비 라인이 하프라인으로부터 얼마나 떨어져 있는지(미터, 음수=자기 진영 깊숙) */
  get defensiveLineOffset() {
    return -22 + this.defensiveLineHeight * 22; // -22 ~ 0
  }

  /** 패스 대신 드리블/전진을 선호하는 정도 */
  get directnessBias() {
    return this.passingDirectness;
  }

  /** 측면 크로스 패스 가중 배율: 측면 지향(0)일수록 크다 (0.55 ~ 1.55) */
  get wingBiasMultiplier() {
    return 1.55 - this.attackDirectness * 1.0;
  }

  /** 중앙 침투/스루패스 가중 배율: 중앙 지향(1)일수록 크다 (0.6 ~ 1.4) */
  get centralBiasMultiplier() {
    return 0.6 + this.attackDirectness * 0.8;
  }

  /** 태클 개입 거리 배율: 헌신적(1)일수록 더 바짝 붙어 태클을 시도한다 (0.72 ~ 1.28) */
  get tackleEngageMultiplier() {
    return 1.28 - this.tackleAggression * 0.56;
  }

  /** 태클 시도 시 파울 위험 배율: 헌신적일수록 파울 위험이 커진다 (0.75 ~ 1.4) */
  get tackleFoulRiskMultiplier() {
    return 0.75 + this.tackleAggression * 0.65;
  }

  /** 태클 경합 점수 가산치: 헌신적일수록 더 과감하게 발을 뻗는다 (-3.5 ~ 3.5) */
  get tackleCommitBonus() {
    return (this.tackleAggression - 0.5) * 7;
  }

  /** 골키퍼 배급: 짧은 패스를 선택할 확률 (0.12 ~ 0.72) */
  get gkShortPassChance() {
    return 0.72 - this.gkDistribution * 0.60;
  }

  /** 팀 템포 지시가 실제 의사결정 긴급도에 곱해지는 배율 (0.72 ~ 1.28) */
  get tempoUrgencyMultiplier() {
    return 0.72 + this.tempo * 0.56;
  }
}
