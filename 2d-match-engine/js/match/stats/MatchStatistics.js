/**
 * 경기 통계 (Section 30).
 *
 * ⚠ 통계는 시뮬레이션에서 "관찰"만 한다.
 *   목표 수치를 맞추기 위해 여기서 숫자를 조작하지 않는다.
 *   분포가 비현실적이면 원인은 AI/물리 쪽에 있는 것이고,
 *   이 파일은 그것을 드러내는 계측기일 뿐이다.
 *
 * 실제로 발생하는 이벤트만 구독한다:
 *   pass, dribbleTouch, tackle, tackleFailed, foulCommitted,
 *   firstTouch, turnover, restart, goal, offside, save, gkClaim
 *
 * MatchEngine 파이프라인의 9단계(sample)에서 매 스텝 호출되며,
 * 점유 지속시간·팀 형태처럼 "매 순간 흐르는" 값만 여기서 처리한다.
 */

/** 슛 이후 이 시간 안에 결론(득점/세이브)이 안 나면 오프타깃으로 간주한다 (초) */
const SHOT_RESOLUTION_TIMEOUT = 2.5;

export class MatchStatistics {
  constructor() {
    this.reset();
  }

  reset() {
    this.home = this._emptySide();
    this.away = this._emptySide();

    this._possessionStart = { home: null, away: null };
    this._possessionDurations = { home: [], away: [] };
    this._lastPossessionTeam = null;

    this._teamLengthSamples = { home: [], away: [] };
    this._defLineSamples = { home: [], away: [] };

    /** 결론이 나지 않은 슛 — 온타깃 여부를 사후 판정하기 위한 대기열 */
    this._pendingShots = [];
  }

  _emptySide() {
    return {
      passesAttempted: 0,
      passesByType: {},
      shots: 0,
      shotsOnTarget: 0,
      goals: 0,
      crosses: 0,
      dribbleContests: 0,
      dribblesWon: 0,
      tackles: 0,
      fouls: 0,
      offsides: 0,
      corners: 0,
      throwIns: 0,
      goalKicks: 0,
      saves: 0,
      turnovers: 0,
      turnoversOwnThird: 0,
      turnoversFinalThird: 0,
      passLengths: [],
      shotDistances: [],
    };
  }

  /** @param {MatchEngine} engine */
  attach(engine) {
    const bus = engine.eventBus;

    bus.on('pass', (e) => this._onPass(e));
    bus.on('shot', (e) => this._onShot(engine, e));
    bus.on('goal', (e) => this._onGoal(engine, e));
    // 태클 시도 = 캐리어 입장에서는 1v1 드리블 경합.
    // 'tackle'(수비 성공)만 수비팀의 태클 성공으로 집계하고,
    // 'tackleFailed'(수비수가 실패 → 공격수가 제쳤다)는 태클 성공이 아니라
    // 드리블 성공으로만 집계한다 — 실패한 시도를 성공으로 세면 안 된다.
    bus.on('tackle', (e) => this._onTackleResolved(e, false, true));
    bus.on('tackleFailed', (e) => this._onTackleResolved(e, true, false));
    bus.on('foulCommitted', (e) => this._side(e.offender.team).fouls++);
    bus.on('offside', (e) => this._side(e.team.opponent).offsides++);
    bus.on('save', (e) => this._onSave(e));
    bus.on('restart', (e) => this._onRestart(e));
    bus.on('turnover', (e) => this._onTurnover(e));

    return this;
  }

  _side(team) {
    return team.side === 'home' ? this.home : this.away;
  }

  // ── 이벤트 핸들러 ────────────────────────────────────────

  _onPass(e) {
    const side = this._side(e.team);
    side.passesAttempted++;
    side.passesByType[e.type] = (side.passesByType[e.type] ?? 0) + 1;
    side.passLengths.push(e.distance);
    if (e.type === 'CROSS') side.crosses++;
  }

  _onShot(engine, e) {
    const side = this._side(e.team);
    side.shots++;
    side.shotDistances.push(e.distance);
    this._pendingShots.push({ team: e.team, time: engine.time });
  }

  _onGoal(engine, e) {
    this._side(e.team).goals++;
    // 득점으로 이어진 슛은 확실히 온타깃이다
    this._resolvePendingShot(e.team, true);
  }

  _onSave(e) {
    this._side(e.gk.team).saves++;
    // 슛을 막은 세이브만 온타깃이다 (gkClaim은 루즈볼·크로스 처리라 여기 오지 않는다)
    if (!e.shot) return;
    // 세이브는 GK 소속팀에서 발생하므로, 슈팅 팀(상대)을 기준으로 되돌린다
    this._resolvePendingShot(e.gk.team.opponent, true);
  }

  /**
   * 대기 중인 슛 하나를 온타깃/오프타깃으로 확정한다.
   * 같은 팀의 가장 오래된 대기 슛을 하나 소비한다.
   */
  _resolvePendingShot(shootingTeam, onTarget) {
    const idx = this._pendingShots.findIndex((s) => s.team === shootingTeam);
    if (idx === -1) return;
    const [shot] = this._pendingShots.splice(idx, 1);
    if (onTarget) this._side(shootingTeam).shotsOnTarget++;
  }

  /** 타임아웃된 슛(막히거나 빗나간 것)을 오프타깃으로 정리한다 */
  _sweepPendingShots(currentTime) {
    this._pendingShots = this._pendingShots.filter(
      (s) => currentTime - s.time < SHOT_RESOLUTION_TIMEOUT
    );
  }

  _onTackleResolved(e, attackerBeatDefender, tackleSucceeded) {
    const tackler = e.winner ?? e.tackler;
    const carrier = e.loser ?? e.carrier;
    if (!tackler || !carrier) return;

    if (tackleSucceeded) this._side(tackler.team).tackles++;
    const attackerSide = this._side(carrier.team);
    attackerSide.dribbleContests++;
    if (attackerBeatDefender) attackerSide.dribblesWon++;
  }

  _onRestart(e) {
    const side = this._side(e.team);
    switch (e.type) {
      case 'CORNER_KICK': side.corners++; break;
      case 'THROW_IN': side.throwIns++; break;
      case 'GOAL_KICK': side.goalKicks++; break;
      default: break;
    }
  }

  _onTurnover(e) {
    const side = this._side(e.loser);
    side.turnovers++;

    const nx = e.loser.shape ? e.loser.shape.ballNX : 0.5;
    if (nx < 0.33) side.turnoversOwnThird++;
    else if (nx > 0.67) side.turnoversFinalThird++;
  }

  // ── 틱 표본 ──────────────────────────────────────────────

  /**
   * @param {MatchEngine} engine
   * @param {number} dt
   */
  sample(engine, dt) {
    const possession = engine.possession;
    const currentTeam = possession?.team ?? null;

    if (currentTeam !== this._lastPossessionTeam) {
      if (this._lastPossessionTeam && this._possessionStart[this._lastPossessionTeam.side] !== null) {
        const duration = engine.time - this._possessionStart[this._lastPossessionTeam.side];
        this._possessionDurations[this._lastPossessionTeam.side].push(duration);
      }
      if (currentTeam) {
        this._possessionStart[currentTeam.side] = engine.time;
      }
      this._lastPossessionTeam = currentTeam;
    }

    for (const team of engine.teams) {
      if (!team.shape) continue;
      this._teamLengthSamples[team.side].push(team.shape.teamLength);
      this._defLineSamples[team.side].push(team.shape.backLineNX);
    }

    this._sweepPendingShots(engine.time);
  }

  // ── 요약 ─────────────────────────────────────────────────

  /**
   * 전체 요약 리포트를 만든다.
   * @param {MatchEngine} engine
   */
  summary(engine) {
    const totalPossession = engine.homeTeam.possessionSeconds + engine.awayTeam.possessionSeconds;

    const sideSummary = (side, team) => {
      const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const longPasses = side.passLengths.filter((d) => d > 30).length;
      const throughPasses = side.passesByType.THROUGH ?? 0;

      return {
        possessionPct: totalPossession > 0
          ? Math.round((team.possessionSeconds / totalPossession) * 100)
          : 50,
        passesAttempted: side.passesAttempted,
        shots: side.shots,
        shotsOnTarget: side.shotsOnTarget,
        goals: side.goals,
        crosses: side.crosses,
        dribbleContests: side.dribbleContests,
        dribblesWon: side.dribblesWon,
        tackles: side.tackles,
        fouls: side.fouls,
        offsides: side.offsides,
        corners: side.corners,
        throwIns: side.throwIns,
        goalKicks: side.goalKicks,
        saves: side.saves,
        turnovers: side.turnovers,
        turnoversOwnThird: side.turnoversOwnThird,
        turnoversFinalThird: side.turnoversFinalThird,
        avgPassLength: Number(avg(side.passLengths).toFixed(1)),
        longPassPct: side.passesAttempted > 0
          ? Math.round((longPasses / side.passesAttempted) * 100)
          : 0,
        throughPassPct: side.passesAttempted > 0
          ? Math.round((throughPasses / side.passesAttempted) * 100)
          : 0,
        avgShotDistance: Number(avg(side.shotDistances).toFixed(1)),
        avgTeamLength: Number(avg(this._teamLengthSamples[team.side]).toFixed(1)),
        avgDefensiveLineNX: Number(avg(this._defLineSamples[team.side]).toFixed(2)),
        avgPossessionDuration: Number(avg(this._possessionDurations[team.side]).toFixed(1)),
      };
    };

    return {
      matchSeconds: engine.state.totalSeconds,
      score: { ...engine.state.score },
      home: sideSummary(this.home, engine.homeTeam),
      away: sideSummary(this.away, engine.awayTeam),
    };
  }
}
