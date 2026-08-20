import { Vector2D } from '../../entities/Vector2D.js';
import { Pitch } from '../../entities/Pitch.js';
import { clamp, inRect, ownPenaltyBox, teamNX } from '../core/Coords.js';
import { Phase } from '../core/MatchState.js';
import { Role } from '../tactics/RoleModel.js';
import { BallFlight } from '../entities/Ball.js';
import { CROSSBAR_HEIGHT } from '../ai/ShotPlanner.js';
import {
  captureOffsideSnapshot, isOffsideOffence, isOffsideExemptRestart,
} from './Offside.js';

/**
 * 규칙 엔진 (Law 5·8~17).
 *
 * ⚠ 출처 고지
 *   이 실행 환경에서는 IFAB 공식 문서(theifab.com)에 접근할 수 없다
 *   (네트워크 정책상 차단). 따라서 아래 구현은 널리 통용되는
 *   표준 축구 규칙에 근거하며, 원문과 대조하지 못한 세부는
 *   해당 위치에 단순화 사실을 명시했다.
 *
 * ⚠ 권한 규칙
 *   경기 국면(Phase)을 바꾸는 판정은 오직 이 클래스가 내린다.
 *   선수 AI는 사건(반칙 등)을 발생시킬 뿐이며, 그것이 어떤 재개로
 *   이어지는지는 여기서 결정한다 (Section 5·37).
 *
 * 볼·선수 물리는 건드리지 않는다. 판정 결과는 RestartEngine에 넘긴다.
 */

/** 어드밴티지를 지켜보는 시간 (초). 이 안에 이득이 유지되면 반칙을 불지 않는다 */
const ADVANTAGE_WINDOW = 1.3;

/** 득점·재개 후 다음 판정까지의 최소 간격 (초) — 중복 판정 방지 */
const DECISION_COOLDOWN = 0.3;

/** 재개 준비에 쓰는 시간을 추가 시간으로 적립하는 비율 */
const STOPPAGE_FACTOR = 1.0;

export class RulesEngine {
  /**
   * @param {RestartEngine} restartEngine
   */
  constructor(restartEngine) {
    this.restarts = restartEngine;

    /** 어드밴티지 심사 중인 반칙 */
    this._pendingFoul = null;
    /** 마지막 판정 이후 경과 시간 */
    this._cooldown = 0;
    /** 볼이 차인 순간의 오프사이드 스냅샷 */
    this._offsideSnapshot = null;
    /** 이 재개에서 오프사이드가 면제되는가 */
    this._offsideExempt = false;
  }

  /**
   * 엔진에 연결한다 — 사건 구독을 설정한다.
   * @param {MatchEngine} engine
   */
  attach(engine) {
    engine.eventBus.on('foulCommitted', (event) => this._onFoul(engine, event));
    engine.eventBus.on('pass', (event) => this._onBallPlayed(engine, event.from));
    engine.eventBus.on('shot', (event) => this._onBallPlayed(engine, event.by));
    engine.eventBus.on('firstTouch', (event) => this._onTouch(engine, event.player));
    // 재개 킥 실행 시 오프사이드 스냅샷을 남긴다.
    // 골킥·코너킥·스로인은 면제(첫 볼), 페널티는 적용 대상이 아니다.
    engine.eventBus.on('restart', (event) => this._onRestartKicked(engine, event));
    return this;
  }

  /**
   * 재개 킥 실행 시 오프사이드 스냅샷을 남긴다.
   * @param {MatchEngine} engine
   * @param {object} event restart 이벤트
   */
  _onRestartKicked(engine, event) {
    if (!event.kicker) return;
    if (event.type === 'PENALTY') return;
    // _onBallPlayed가 _offsideExempt 플래그로 골킥/코너/스로인 면제를 처리한다
    this._onBallPlayed(engine, event.kicker);
  }

  // ──────────────────────────────────────────────────────────
  // 파이프라인 훅
  // ──────────────────────────────────────────────────────────

  /**
   * 스텝 시작 — 재개 진행과 하프 종료를 처리한다.
   */
  preStep(engine, dt) {
    this._cooldown = Math.max(0, this._cooldown - dt);

    const state = engine.state;

    // 재개 준비 중이면 배치를 진행하고, 준비되면 볼을 인플레이로 만든다
    if (state.isRestartPending && state.restart) {
      state.addStoppage(dt * STOPPAGE_FACTOR);
      this.restarts.update(engine, dt);
      return;
    }

    // 하프/경기 종료 판정
    if (state.phase === Phase.IN_PLAY && state.isHalfComplete) {
      this._endHalf(engine);
    }
  }

  /**
   * 스텝 종료 — 볼 위치와 사건을 보고 판정한다.
   */
  postStep(engine, dt) {
    if (!engine.state.isBallInPlay) return;

    // 어드밴티지 심사가 진행 중이면 먼저 결론을 낸다
    if (this._pendingFoul) {
      this._reviewAdvantage(engine, dt);
      if (!engine.state.isBallInPlay) return;
    }

    if (this._cooldown > 0) return;

    // 1. 득점 (Law 10)
    if (this._checkGoal(engine)) return;
    // 2. 볼 아웃 (Law 9)
    if (this._checkOutOfPlay(engine)) return;
  }

  // ──────────────────────────────────────────────────────────
  // Law 9 / 10 — 아웃과 득점
  // ──────────────────────────────────────────────────────────

  /**
   * 득점 판정 (Law 10).
   * 볼 "전체"가 골라인을 완전히 넘어야 하고, 골포스트 사이·크로스바 아래여야 한다.
   */
  _checkGoal(engine) {
    const ball = engine.ball;
    const [goalTop, goalBottom] = Pitch.goalYRange();
    const radius = ball.radius;

    // 볼 전체가 골라인을 넘었는가
    const overLeft = ball.position.x + radius < 0;
    const overRight = ball.position.x - radius > Pitch.LENGTH;
    if (!overLeft && !overRight) return false;

    const insideMouth =
      ball.position.y > goalTop && ball.position.y < goalBottom &&
      ball.height + radius < CROSSBAR_HEIGHT;

    if (!insideMouth) return false;

    // 왼쪽 골문(x=0)은 +x로 공격하는 팀이 지킨다.
    // 따라서 그 골문에 들어간 볼은 −x로 공격하는 팀의 득점이다.
    const scoringSide = overLeft ? -1 : 1;
    const scorer = engine.teams.find((t) => t.attackingDirection === scoringSide);
    if (!scorer) return false;

    engine.state.addGoal(scorer.side);
    engine.eventBus.emit('goal', {
      team: scorer,
      scorer: ball.lastTouch?.player ?? null,
      score: { ...engine.state.score },
    });

    // 킥오프는 실점한 팀이 시작한다 (Law 8)
    this._awardRestart(engine, {
      type: 'KICKOFF',
      team: scorer.opponent,
      position: Pitch.center(),
      reason: 'GOAL',
    }, Phase.GOAL);
    return true;
  }

  /**
   * 아웃 판정 (Law 9).
   * 볼 전체가 터치라인 또는 골라인을 완전히 넘어야 아웃이다.
   */
  _checkOutOfPlay(engine) {
    const ball = engine.ball;
    const radius = ball.radius;
    const lastTouch = ball.lastTouch;

    const overTop = ball.position.y + radius < 0;
    const overBottom = ball.position.y - radius > Pitch.WIDTH;
    const overLeft = ball.position.x + radius < 0;
    const overRight = ball.position.x - radius > Pitch.LENGTH;

    if (!overTop && !overBottom && !overLeft && !overRight) return false;

    // 마지막 접촉을 알 수 없으면 드롭볼 대신 중앙에서 재개한다 (단순화)
    if (!lastTouch) {
      this._awardRestart(engine, {
        type: 'KICKOFF',
        team: engine.homeTeam,
        position: Pitch.center(),
        reason: 'UNKNOWN_TOUCH',
      }, Phase.BALL_OUT);
      return true;
    }

    const lastTeam = lastTouch.team;
    const opponent = lastTeam.opponent;

    // ── 터치라인 → 스로인 (Law 15) ──────────────────────────
    if (overTop || overBottom) {
      const y = overTop ? 0 : Pitch.WIDTH;
      const x = clamp(ball.position.x, 1, Pitch.LENGTH - 1);
      this._awardRestart(engine, {
        type: 'THROW_IN',
        team: opponent,
        position: new Vector2D(x, y),
        reason: 'TOUCHLINE',
      }, Phase.THROW_IN);
      return true;
    }

    // ── 골라인 → 골킥 또는 코너킥 (Law 16·17) ───────────────
    const goalSide = overLeft ? 'left' : 'right';
    // 이 골라인을 지키는 팀 = 그 반대편으로 공격하는 팀
    const defendingTeam = engine.teams.find(
      (t) => t.attackingDirection === (overLeft ? 1 : -1)
    );

    if (lastTeam === defendingTeam) {
      // 수비 팀이 마지막으로 만졌다 → 코너킥
      const cornerY = ball.position.y < Pitch.WIDTH / 2 ? 0 : Pitch.WIDTH;
      const cornerX = goalSide === 'left' ? 0 : Pitch.LENGTH;
      this._awardRestart(engine, {
        type: 'CORNER_KICK',
        team: defendingTeam.opponent,
        position: new Vector2D(cornerX, cornerY),
        reason: 'GOAL_LINE',
      }, Phase.CORNER_KICK);
    } else {
      // 공격 팀이 마지막으로 만졌다 → 골킥
      const box = Pitch.goalBoxRect(goalSide);
      const kickX = goalSide === 'left' ? box.w : Pitch.LENGTH - box.w;
      this._awardRestart(engine, {
        type: 'GOAL_KICK',
        team: defendingTeam,
        position: new Vector2D(kickX, Pitch.WIDTH / 2),
        reason: 'GOAL_LINE',
      }, Phase.GOAL_KICK);
    }
    return true;
  }

  // ──────────────────────────────────────────────────────────
  // Law 11 — 오프사이드
  // ──────────────────────────────────────────────────────────

  /** 볼이 차인 순간 오프사이드 스냅샷을 남긴다 */
  _onBallPlayed(engine, kicker) {
    if (!kicker) return;
    if (this._offsideExempt) {
      // 예외 재개(골킥·코너킥·스로인)에서 나간 첫 볼은 오프사이드가 없다
      this._offsideSnapshot = null;
      this._offsideExempt = false;
      return;
    }
    this._offsideSnapshot = captureOffsideSnapshot(kicker, engine.ball);
  }

  /**
   * 볼에 관여한 순간 오프사이드 반칙을 판정한다.
   *
   * 오프사이드 "위치"에 있었다는 것만으로는 반칙이 아니며,
   * 그 선수가 실제로 볼에 관여했을 때 성립한다.
   */
  _onTouch(engine, player) {
    if (!player) return;
    const snapshot = this._offsideSnapshot;
    if (!snapshot) return;

    if (isOffsideOffence(snapshot, player)) {
      this._offsideSnapshot = null;
      engine.eventBus.emit('offside', {
        player,
        team: player.team,
        position: player.position.clone(),
      });
      // 간접 프리킥 — 반칙이 일어난 지점 (Law 11)
      this._awardRestart(engine, {
        type: 'INDIRECT_FREE_KICK',
        team: player.team.opponent,
        position: Pitch.clampInside(player.position, 1.0),
        reason: 'OFFSIDE',
      }, Phase.OFFSIDE);
      return;
    }

    // 관여가 확인되면 스냅샷은 소멸한다
    this._offsideSnapshot = null;
  }

  // ──────────────────────────────────────────────────────────
  // Law 12 — 반칙과 어드밴티지
  // ──────────────────────────────────────────────────────────

  /**
   * 반칙 사건 접수. 곧바로 휘슬을 불지 않고 어드밴티지를 살핀다 (Law 5).
   */
  _onFoul(engine, event) {
    if (!engine.state.isBallInPlay) return;
    if (this._pendingFoul) return;

    this._pendingFoul = {
      offender: event.offender,
      victim: event.victim,
      position: event.position.clone(),
      elapsed: 0,
      victimTeam: event.victim?.team ?? null,
    };
  }

  /**
   * 어드밴티지 심사.
   *
   * 반칙을 당한 팀이 계속 볼을 갖고 유리하게 진행 중이면 반칙을 불지 않는다.
   * 이득이 사라지면 원래 지점에서 프리킥을 준다.
   */
  _reviewAdvantage(engine, dt) {
    const pending = this._pendingFoul;
    // 이미 결론이 난 뒤 다시 호출될 수 있다 (반칙 선언 → 재개 확정 시 초기화)
    if (!pending) return;
    pending.elapsed += dt;

    const possessionTeam = engine.possession?.team ?? null;
    const victimTeam = pending.victimTeam;

    // 심사 중 피해 팀이 볼을 잃으면 즉시 반칙을 선언한다
    if (possessionTeam && victimTeam && possessionTeam !== victimTeam) {
      this._awardFoul(engine, pending);
      return;
    }

    if (pending.elapsed < ADVANTAGE_WINDOW) return;

    // 창이 끝났다 — 피해 팀이 여전히 볼을 갖고 있으면 어드밴티지 적용
    if (possessionTeam && victimTeam && possessionTeam === victimTeam) {
      engine.eventBus.emit('advantage', {
        team: victimTeam, offender: pending.offender,
      });
      this._pendingFoul = null;
      return;
    }

    this._awardFoul(engine, pending);
  }

  /** 반칙을 선언하고 재개를 정한다 */
  _awardFoul(engine, pending) {
    this._pendingFoul = null;

    const offender = pending.offender;
    const victimTeam = pending.victimTeam ?? offender.team.opponent;
    const dir = offender.team.attackingDirection;

    // 반칙 지점이 반칙 팀의 페널티 지역 안이면 페널티킥 (Law 14)
    const box = ownPenaltyBox(dir);
    const isPenalty = inRect(pending.position, box);

    engine.eventBus.emit('foul', {
      team: victimTeam,
      offender,
      victim: pending.victim,
      position: pending.position.clone(),
      penalty: isPenalty,
    });

    if (isPenalty) {
      const goalX = dir === 1 ? 0 : Pitch.LENGTH;
      const spotX = goalX + dir * Pitch.PENALTY_SPOT_DIST;
      this._awardRestart(engine, {
        type: 'PENALTY',
        team: victimTeam,
        position: new Vector2D(spotX, Pitch.WIDTH / 2),
        reason: 'FOUL_IN_BOX',
      }, Phase.PENALTY);
      return;
    }

    this._awardRestart(engine, {
      type: 'DIRECT_FREE_KICK',
      team: victimTeam,
      position: Pitch.clampInside(pending.position, 1.0),
      reason: 'FOUL',
    }, Phase.DIRECT_FREE_KICK);
  }

  // ──────────────────────────────────────────────────────────
  // 공통
  // ──────────────────────────────────────────────────────────

  /**
   * 재개를 확정하고 국면을 전환한다.
   * 국면 변경은 이 경로로만 일어난다.
   */
  _awardRestart(engine, restart, phase) {
    this._cooldown = DECISION_COOLDOWN;
    this._pendingFoul = null;
    this._offsideSnapshot = null;
    // 골킥·코너킥·스로인에서 나가는 첫 볼은 오프사이드 면제 (Law 11)
    this._offsideExempt = isOffsideExemptRestart(restart.type);

    engine.setPhase(phase, restart);
    this.restarts.setup(engine, restart);
  }

  /** 하프 또는 경기 종료 */
  _endHalf(engine) {
    const state = engine.state;
    if (state.half === 1) {
      engine.setPhase(Phase.HALF_TIME, null);
      engine.eventBus.emit('halftime', { score: { ...state.score } });
    } else {
      engine.setPhase(Phase.FULL_TIME, null);
      engine.eventBus.emit('fulltime', { score: { ...state.score } });
    }
  }

  /**
   * 후반 시작 — 진영을 교대하고 킥오프를 준비한다.
   * 외부(UI/시나리오)에서 호출한다.
   */
  startSecondHalf(engine) {
    engine.state.startSecondHalf();
    for (const team of engine.teams) team.swapSides();
    this._awardRestart(engine, {
      type: 'KICKOFF',
      team: engine.awayTeam,
      position: Pitch.center(),
      reason: 'SECOND_HALF',
    }, Phase.KICKOFF);
  }

  /** 경기 시작 킥오프 */
  kickOff(engine, team = engine.homeTeam) {
    this._awardRestart(engine, {
      type: 'KICKOFF',
      team,
      position: Pitch.center(),
      reason: 'MATCH_START',
    }, Phase.KICKOFF);
  }
}
