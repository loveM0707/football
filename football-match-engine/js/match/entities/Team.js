import { Role, Line } from '../tactics/RoleModel.js';
import { resolveSlots } from '../tactics/Formation.js';
import { clamp01 } from '../core/Coords.js';

/**
 * 팀 소유 국면 (Section 12).
 *
 * 단순히 "볼을 갖고 있는가"가 아니라, 전환 직후의 과도기를 별도 상태로 둔다.
 * 전환 국면에서는 안정적 소유와 전혀 다른 행동(카운터프레스, 역습 침투)이 나온다.
 */
export const PossessionPhase = {
  IN_POSSESSION: 'IN_POSSESSION',
  OUT_OF_POSSESSION: 'OUT_OF_POSSESSION',
  TRANSITION_ATTACK: 'TRANSITION_ATTACK',   // 방금 볼을 딴 직후
  TRANSITION_DEFENCE: 'TRANSITION_DEFENCE', // 방금 볼을 잃은 직후
};

/** 전환 국면이 유지되는 시간 (초) — 이 시간이 지나면 안정 국면으로 넘어간다 */
export const TRANSITION_DURATION = 3.0;

/** 멘탈리티 → 스칼라 (-1 수비적 ~ +1 공격적) */
const MENTALITY_SCALAR = { defensive: -1, balanced: 0, attacking: 1 };

/**
 * 팀 전술 지시.
 *
 * 모든 값은 0~1로 정규화한다. 0.5가 "보통"이며 기본값이다.
 * 이 값들은 팀 속성이고, 선수 개개인의 행동은 여기에서 유도된다.
 */
export class TeamTactics {
  constructor(options = {}) {
    const n = (key, def = 0.5) => clamp01(options[key] ?? def);

    /** 'defensive' | 'balanced' | 'attacking' */
    this.mentality = options.mentality ?? 'balanced';

    // 형태
    this.width = n('width');                             // 팀 폭
    this.compactness = n('compactness');                 // 라인 간 밀집도
    this.defensiveLineHeight = n('defensiveLineHeight'); // 수비 라인 높이

    // 수비
    this.pressingIntensity = n('pressingIntensity');     // 압박 강도
    this.tackleAggression = n('tackleAggression');       // 태클 적극성

    // 공격
    this.buildUpRisk = n('buildUpRisk');                 // 빌드업 리스크 감수
    this.attackDirectness = n('attackDirectness');       // 직선적 공격 성향
    this.passingDirectness = n('passingDirectness');     // 전진 패스 선호
    this.tempo = n('tempo');                             // 템포

    // 골키퍼
    this.gkDistribution = n('gkDistribution');           // 배급 길이 (0 짧게 ~ 1 길게)
  }

  /** 멘탈리티 스칼라 -1 ~ +1 */
  get mentalityScalar() {
    return MENTALITY_SCALAR[this.mentality] ?? 0;
  }

  /**
   * 수비 블록의 기준 높이 (팀 상대 정규화 nx).
   * 수비 라인 지시 + 멘탈리티가 함께 작용한다.
   * 0.14(매우 깊음) ~ 0.50(매우 높음)
   */
  get blockHeightNX() {
    return 0.14 + this.defensiveLineHeight * 0.30 + this.mentalityScalar * 0.03;
  }

  /**
   * 목표 팀 길이 (최후방~최전방, m).
   * 컴팩트할수록 짧다. 실제 축구의 수비 블록은 대략 30~45m.
   */
  get targetTeamLength() {
    return 44 - this.compactness * 13; // 44m(느슨) ~ 31m(밀집)
  }

  /**
   * 목표 팀 폭 (m). 피치 폭 68m를 넘지 않는다.
   * 수비 시에는 TeamShape가 여기에 추가 압축을 적용한다.
   */
  get targetTeamWidth() {
    return 34 + this.width * 24; // 34m(좁음) ~ 58m(넓음)
  }

  /**
   * 압박 발동 깊이 — 볼이 자기 골문에서 이 거리(m) 안에 들어오면 압박한다.
   * 압박 강도가 높을수록 더 멀리(상대 진영까지) 나가서 압박한다.
   */
  get pressTriggerDistance() {
    return 34 + this.pressingIntensity * 58; // 34m ~ 92m
  }

  /** 값을 부분 갱신한다 (전술 패널 변경 반영용) */
  apply(options = {}) {
    for (const [key, value] of Object.entries(options)) {
      if (key === 'mentality') {
        if (MENTALITY_SCALAR[value] !== undefined) this.mentality = value;
      } else if (typeof this[key] === 'number') {
        this[key] = clamp01(value);
      }
    }
  }
}

/**
 * 팀.
 *
 * 선수 목록 + 전술 지시 + 현재 팀 상태를 보관한다.
 * 팀 형태 계산(TeamShape)과 임무 배정(TacticalEngine)의 결과가
 * 여기 캐시되어 같은 틱 안에서 모든 선수가 동일한 팀 상태를 참조한다.
 * (선수마다 팀 상태를 따로 계산하면 서로 모순된 판단이 나온다)
 */
export class Team {
  /**
   * @param {object} opts
   * @param {string} opts.name 팀 이름
   * @param {'home'|'away'} opts.side
   * @param {string} opts.color 렌더링 색상
   * @param {string} opts.formationName 포메이션 이름
   * @param {Player[]} opts.players 선수 11명
   * @param {object} opts.tactics 전술 초기값
   */
  constructor({ name, side, color, formationName = '4-4-2', players = [], tactics = {} }) {
    this.name = name;
    this.side = side;
    this.color = color;
    this.formationName = formationName;
    this.tactics = new TeamTactics(tactics);

    /** 공격 방향: +1 = x 증가 방향, -1 = x 감소 방향 */
    this.attackingDirection = side === 'home' ? 1 : -1;

    this.players = players;
    this._bindPlayers();

    /** 상대 팀 — MatchEngine이 주입 */
    this.opponent = null;

    this.resetState();
  }

  /** 선수에게 팀·포메이션 슬롯을 주입한다 */
  _bindPlayers() {
    const slots = resolveSlots(this.formationName);
    this.players.forEach((player, i) => {
      player.team = this;
      // 슬롯 수와 선수 수가 어긋나도 죽지 않도록 방어한다
      player.slot = slots[i] ?? slots[slots.length - 1];
      // 포메이션이 지정한 역할을 실제 역할로 삼는다
      if (player.slot) player.role = player.slot.role;
    });
  }

  /** 팀 상태 초기화 */
  resetState() {
    /** 현재 소유 국면 */
    this.phase = PossessionPhase.OUT_OF_POSSESSION;
    /** 현재 국면이 유지된 시간 (초) */
    this.phaseTimer = 0;
    /** 누적 점유 시간 (초) — 점유율 표시용 */
    this.possessionSeconds = 0;

    /**
     * TeamShape가 매 틱 채우는 형태 캐시.
     * 팀 단위로 한 번만 계산하고 모든 선수가 공유한다.
     */
    this.shape = null;

    /**
     * TacticalEngine이 매 틱 채우는 임무 배정 결과.
     * presser/cover는 팀당 최대 1명이 보장된다.
     */
    this.assignment = {
      presser: null,
      cover: null,
      looseChaser: null,
      marks: new Map(), // 수비수 → 마크 대상
    };
  }

  /** 포메이션 변경 — 슬롯을 다시 배정한다 */
  setFormation(name) {
    this.formationName = name;
    this._bindPlayers();
  }

  /** 하프타임 진영 교대 */
  swapSides() {
    this.attackingDirection *= -1;
  }

  // ── 선수 조회 ──────────────────────────────────────────────

  get goalkeeper() {
    return this.players.find((p) => p.role === Role.GK) ?? null;
  }

  /** 골키퍼를 제외한 필드 플레이어 */
  get outfield() {
    return this.players.filter((p) => p.role !== Role.GK);
  }

  /** 특정 라인 소속 선수 */
  playersInLine(line) {
    return this.players.filter((p) => p.slot?.line === line);
  }

  /** 최후방 라인 (골키퍼 제외) */
  get backLine() {
    return this.playersInLine(Line.BACK);
  }

  // ── 국면 전환 ──────────────────────────────────────────────

  /**
   * 소유 국면을 설정한다. 같은 국면이면 타이머만 이어간다.
   * @param {string} phase PossessionPhase 값
   */
  setPhase(phase) {
    if (this.phase !== phase) {
      this.phase = phase;
      this.phaseTimer = 0;
    }
  }

  /** 매 스텝 국면 타이머를 전진시키고, 전환 국면의 만료를 처리한다 */
  advancePhase(dt) {
    this.phaseTimer += dt;
    if (this.phaseTimer >= TRANSITION_DURATION) {
      if (this.phase === PossessionPhase.TRANSITION_ATTACK) {
        this.setPhase(PossessionPhase.IN_POSSESSION);
      } else if (this.phase === PossessionPhase.TRANSITION_DEFENCE) {
        this.setPhase(PossessionPhase.OUT_OF_POSSESSION);
      }
    }
  }

  /** 공격 국면인가 (안정 소유 + 공격 전환) */
  get isAttacking() {
    return this.phase === PossessionPhase.IN_POSSESSION ||
           this.phase === PossessionPhase.TRANSITION_ATTACK;
  }

  /** 수비 국면인가 */
  get isDefending() {
    return !this.isAttacking;
  }

  /** 결정론 검증용 상태 요약 */
  snapshot() {
    return {
      side: this.side,
      phase: this.phase,
      players: this.players.map((p) => p.snapshot()),
    };
  }
}
