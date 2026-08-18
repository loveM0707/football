/**
 * 감독(유저)의 전술 지침을 AI 모듈이 바로 사용할 수 있는 수치 파라미터로 변환한다.
 *
 * 설계 원칙: 전술 패널의 선택은 "코드에 박힌 기본 수치보다 우선"한다. 각 지시는
 * 유틸리티 점수에 큰 폭의 가·감산(수십 점 단위)이나 위치 좌표 자체를 좌우하는
 * 배율로 반영되어, 감독이 지시를 바꾸면 플레이 성향이 눈에 띄게 달라진다.
 * 다만 확실한 득점 기회·위험 회피 등 "축구적으로 당연한" 판단까지 뒤집지는
 * 않도록, 강제(hard gate)가 아닌 큰 가중치(soft weight) 형태로 적용한다.
 */
export class TeamInstructions {
  constructor({
    mentality = 'balanced', // 'defensive' | 'balanced' | 'attacking'
    tempo = 0.5, // 0 (느림) ~ 1 (빠름)
    width = 0.5, // 0 (좁음) ~ 1 (넓음)
    pressing = 0.5, // 0 (물러서기) ~ 0.5 (하프라인) ~ 1 (전원수비)
    passingDirectness = 0.5, // 0 (짧게) ~ 1 (길게)
    defensiveLineHeight = 0.5, // 0 (깊음) ~ 1 (높음)
    attackDirectness = 0.5, // 0 (측면) ~ 1 (중앙)
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

  // ─────────────────────────────────────────────────────────────
  // 팀 전술 (수비적 / 균형 / 공격적)
  // ─────────────────────────────────────────────────────────────

  /** -1(수비적) / 0(균형) / +1(공격적) — 다른 파생값의 공통 입력 */
  get mentalityScalar() {
    return { defensive: -1, balanced: 0, attacking: 1 }[this.mentality] ?? 0;
  }

  /** 공격 시 기본 위치를 얼마나 전진시킬지 (정규화 좌표, ±0.13 ≈ ±14m) */
  get mentalityAttackPush() {
    return this.mentalityScalar * 0.13;
  }

  /** 비소유(수비) 시 라인 높이 보정 (정규화 좌표) — 수비적이면 더 내려선다 */
  get mentalityDefenceAdjust() {
    return this.mentalityScalar * 0.07;
  }

  /**
   * 풀백/윙백 오버래핑 적극성 (0 ~ 1).
   * 수비적(0.08)이면 사실상 오버래핑을 하지 않고, 공격적(1.0)이면 항상 올라간다.
   */
  get overlapAggression() {
    return { defensive: 0.08, balanced: 0.55, attacking: 1.0 }[this.mentality] ?? 0.55;
  }

  /** 전진 패스 선호 가중치 — 공격적일수록 전진 거리 1m당 점수가 커진다 */
  get forwardPassWeight() {
    return 1.5 + this.mentalityScalar * 1.6; // 수비적 -0.1 ~ 공격적 3.1
  }

  /** 압박 임계값(드리블 유지/강제 패스) 보정 — 공격적일수록 리스크를 감수 */
  get mentalityRiskAdjust() {
    return this.mentalityScalar * 12;
  }

  /** 슈팅 의지 배율 */
  get mentalityShootMultiplier() {
    return 1 + this.mentalityScalar * 0.28; // 0.72 ~ 1.28
  }

  /** 수비 시 공격수가 하프라인을 넘어 전방에 남는지 (수비적이면 자기 진영 유지) */
  get keepStrikerHigh() {
    return this.mentality !== 'defensive';
  }

  // ─────────────────────────────────────────────────────────────
  // 좌우 폭 (좁음 / 균형 / 넓음)
  // ─────────────────────────────────────────────────────────────

  /**
   * 팀 폭 배율: 기본 포메이션 y좌표를 센터 기준으로 확장/축소.
   * 좁음(0.52)은 페널티 에어리어 폭(약 40m / 68m ≈ 0.6)에 가깝게 모이고,
   * 넓음(1.45)은 측면 선수가 터치라인 가까이 벌어진다.
   */
  get widthMultiplier() {
    return 0.52 + this.width * 0.93; // 0.52 ~ 1.45
  }

  /** 수비 시 폭 배율 — 수비 블록은 항상 공격보다 좁지만 지시는 그대로 반영된다 */
  get defensiveWidthMultiplier() {
    return 0.78 + this.width * 0.34; // 0.78 ~ 1.12
  }

  // ─────────────────────────────────────────────────────────────
  // 공격 방향 (측면 / 혼합 / 중앙) + 좌우 폭 연동
  // ─────────────────────────────────────────────────────────────

  /**
   * 중앙 지향도 (-1.45 = 극단적 측면 ~ +1.45 = 극단적 중앙).
   * 공격 방향 지시가 주 요인이고, 좌우 폭 지시(좁음=중앙 / 넓음=측면)가 보조로 더해진다.
   * PlayerBrain의 패스 평가에서 수신자의 좌우 위치와 곱해져 큰 가·감산이 된다.
   */
  get centralityPreference() {
    const dir = (this.attackDirectness - 0.5) * 2;   // -1(측면) ~ +1(중앙)
    const wid = (0.5 - this.width) * 2;              // +1(좁음→중앙) ~ -1(넓음→측면)
    return dir + wid * 0.45;
  }

  /** 측면 크로스를 실제로 올릴 확률 (측면 지향 1.0 ~ 중앙 지향 0.12) */
  get crossPreference() {
    return Math.max(0.12, Math.min(1, 0.56 - this.centralityPreference * 0.42));
  }

  /** 측면 선수(윙어·풀백)가 터치라인에 얼마나 붙는지 (0.30 안쪽 ~ 0.95 터치라인) */
  get flankHugFactor() {
    return Math.max(0.30, Math.min(0.95, 0.62 - this.centralityPreference * 0.32));
  }

  // ─────────────────────────────────────────────────────────────
  // 패스 템포 (느림 / 보통 / 빠름)
  // ─────────────────────────────────────────────────────────────

  /** 팀 템포 지시가 의사결정 긴급도에 곱해지는 배율 */
  get tempoUrgencyMultiplier() {
    return 0.60 + this.tempo * 0.80; // 0.60 ~ 1.40
  }

  /** 패스 유틸리티 배율 — 빠름이면 압박이 없어도 패스를 먼저 고른다 */
  get tempoPassMultiplier() {
    return 0.62 + this.tempo * 1.06; // 0.62 ~ 1.68
  }

  /** 드리블 유틸리티 배율 — 느림이면 드리블·살피기로 볼을 소유한다 */
  get tempoDribbleMultiplier() {
    return 1.55 - this.tempo * 1.02; // 1.55 ~ 0.53
  }

  /** 볼을 잡고 주위를 살피는(스캔) 시간 배율 */
  get tempoScanMultiplier() {
    return 1.65 - this.tempo * 1.25; // 1.65 ~ 0.40
  }

  // ─────────────────────────────────────────────────────────────
  // 패스 유형 (짧게 / 혼합 / 길게)
  // ─────────────────────────────────────────────────────────────

  /** -1(짧게) ~ +1(길게) */
  get passLengthPreference() {
    return (this.passingDirectness - 0.5) * 2;
  }

  /** 롱패스 사거리 컷오프 보정 (능력치에 더해지는 값) */
  get longPassSkillBonus() {
    return this.passLengthPreference * 45;
  }

  /** 패스 대신 드리블/전진을 선호하는 정도 (레거시 소비처 호환) */
  get directnessBias() {
    return this.passingDirectness;
  }

  // ─────────────────────────────────────────────────────────────
  // 수비 라인 (깊음 / 균형 / 높음)
  // ─────────────────────────────────────────────────────────────

  /** 수비 라인 높이 보정 (정규화 좌표, ±0.15 ≈ ±16m) */
  get lineHeightAdjust() {
    return (this.defensiveLineHeight - 0.5) * 0.30;
  }

  /**
   * 공격 시 수비수(CB/LB/RB)가 넘어갈 수 있는 X 상한 (정규화 좌표).
   * 깊음: 0.42(하프라인 아래에 잔류) / 높음: 0.60(하프라인까지 전진).
   */
  get defenderAdvanceLimit() {
    return 0.40 + this.defensiveLineHeight * 0.20;
  }

  /** 압박을 시작할 거리(미터). 높을수록 더 먼 거리에서부터 압박 */
  get pressingTriggerDistance() {
    return 9 + this.pressing * 22; // 9 ~ 31m
  }

  // ─────────────────────────────────────────────────────────────
  // 압박 (물러서기 / 하프라인 / 전원수비)
  // ─────────────────────────────────────────────────────────────

  /**
   * 즉시 압박을 시작하는 깊이 — 자기 골문으로부터의 거리 비율(피치 길이 기준).
   * 물러서기(0.30): 상대가 우리 파이널 서드에 들어와야 압박
   * 하프라인(0.55): 상대가 하프라인을 넘으면 압박
   * 전원수비(1.05): 상대 진영(상대가 자기 진영에 있을 때)에서도 압박
   */
  get pressDepthRatio() {
    if (this.pressing <= 0.5) return 0.30 + this.pressing * 0.50;  // 0.30 ~ 0.55
    return 0.55 + (this.pressing - 0.5) * 1.00;                     // 0.55 ~ 1.05
  }

  // ─────────────────────────────────────────────────────────────
  // 태클 (신중하게 / 보통 / 헌신적)
  // ─────────────────────────────────────────────────────────────

  /**
   * 태클 개입 거리 배율 — 헌신적일수록 더 바짝 붙어 볼을 뺏으러 간다.
   * 단, 자기 페널티 에어리어 부근에서는 호출부에서 '보통' 수준으로 되돌린다
   * (위험 지역 프리킥·PK 방지).
   */
  get tackleEngageMultiplier() {
    return 1.45 - this.tackleAggression * 0.90; // 1.45(신중) ~ 0.55(헌신적)
  }

  /** 태클 시도 시 파울 위험 배율 — 헌신적일수록 파울이 확연히 늘어난다 */
  get tackleFoulRiskMultiplier() {
    return 0.65 + this.tackleAggression * 1.45; // 0.65(신중) ~ 2.10(헌신적)
  }

  /** 태클 경합 점수 가산치 — 헌신적일수록 과감하게 발을 뻗는다 */
  get tackleCommitBonus() {
    return (this.tackleAggression - 0.5) * 14;
  }

  /** 대인 마크 밀착 거리 배율 — 헌신적일수록 바짝 붙는다 */
  get markTightnessMultiplier() {
    return 1.35 - this.tackleAggression * 0.75; // 1.35 ~ 0.60
  }

  // ─────────────────────────────────────────────────────────────
  // 골키퍼 배급 (짧은 패스 / 혼합 / 긴 패스)
  // ─────────────────────────────────────────────────────────────

  /** 골키퍼가 짧은 패스를 선택할 확률 */
  get gkShortPassChance() {
    return 0.92 - this.gkDistribution * 0.86; // 0.92 ~ 0.06
  }

  /** 골키퍼 짧은 패스 수신자 탐색 최대 거리(m) */
  get gkShortRange() {
    return 26;
  }

  // 레거시 호환 게터 ────────────────────────────────────────────
  get mentalityForwardBiasMeters() {
    return this.mentalityScalar * 5;
  }

  get defensiveLineOffset() {
    return -22 + this.defensiveLineHeight * 22;
  }
}
