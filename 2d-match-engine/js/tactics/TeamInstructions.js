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
    pressing = 0.5, // 0 (낮은 압박) ~ 1 (높은 압박)
    passingDirectness = 0.4, // 0 (짧은 패스) ~ 1 (직선적/롱볼)
    defensiveLineHeight = 0.5, // 0 (수비적) ~ 1 (높은 라인)
  } = {}) {
    this.mentality = mentality;
    this.tempo = tempo;
    this.width = width;
    this.pressing = pressing;
    this.passingDirectness = passingDirectness;
    this.defensiveLineHeight = defensiveLineHeight;
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
}
