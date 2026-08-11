import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { Ball } from '../entities/Ball.js';
import { MatchState, Phase } from './MatchState.js';
import { ActionExecutor } from './ActionExecutor.js';
import { PhysicsEngine } from '../physics/PhysicsEngine.js';
import { Collision } from '../physics/Collision.js';
import { DuelResolver } from '../ai/DuelResolver.js';
import { decidePlayerIntent } from '../ai/PlayerBrain.js';
import { computeSupportPosition } from '../ai/OffTheBallMovement.js';

/**
 * 매치 엔진 전체를 매 틱마다 조율하는 오케스트레이터.
 * 순서: (1) 모든 선수의 AI 의도 결정 -> (2) 실행(패스/슛/이동으로 변환)
 *       -> (3) 물리 적분 -> (4) 드리블 시 볼 부착 -> (5) 충돌/겹침 해소
 *       -> (6) 볼 소유권/경합 판정 -> (7) 아웃오브플레이(코너/스로인/골킥/골) 판정
 * Gemini 초안의 "MatchEngine(경합 판정)"은 이름 충돌을 피해 DuelResolver로 분리했고,
 * 이 오케스트레이터 자체는 별도로 MatchSimulator라는 이름을 사용한다.
 */
export class MatchSimulator {
  constructor({ homeTeam, awayTeam, eventBus }) {
    this.homeTeam = homeTeam;
    this.awayTeam = awayTeam;
    this.eventBus = eventBus;
    this.ball = new Ball();
    this.matchState = new MatchState();

    this._secondHalfKickoffTeam = awayTeam;
    this._pendingKickoffTeam = homeTeam;
    this._kickoffTaker = null;

    this._setupKickoff(homeTeam);
  }

  reset() {
    this.matchState.reset();
    this.homeTeam.score = 0;
    this.awayTeam.score = 0;
    this.homeTeam.possessionSeconds = 0;
    this.awayTeam.possessionSeconds = 0;
    if (this.homeTeam.attackingDirection !== 1) {
      this.homeTeam.flipAttackingDirection();
      this.awayTeam.flipAttackingDirection();
    }
    this._setupKickoff(this.homeTeam);
  }

  /**
   * 배속(timeScale)이 높으면 한 프레임의 dt가 커져 빠른 공이 골키퍼를 "관통"하듯
   * 충돌 판정을 건너뛸 수 있다(터널링). 물리/AI를 항상 짧은 고정 단위로 서브스텝
   * 처리해, 재생 속도와 무관하게 판정 정밀도가 유지되도록 한다.
   */
  tick(dt) {
    const MAX_STEP = 0.12;
    let remaining = dt;
    while (remaining > 1e-6) {
      const step = Math.min(MAX_STEP, remaining);
      this._tickOnce(step);
      remaining -= step;
    }
  }

  _tickOnce(dt) {
    this.matchState.advanceClock(dt);

    switch (this.matchState.phase) {
      case Phase.KICKOFF:
        this._tickRestartPhase(dt, true);
        break;
      case Phase.THROW_IN:
      case Phase.CORNER_KICK:
      case Phase.GOAL_KICK:
        this._tickRestartPhase(dt, false);
        break;
      case Phase.GOAL_SCORED:
        this._tickGoalScored(dt);
        break;
      case Phase.HALF_TIME:
        this._tickHalfTime(dt);
        break;
      case Phase.FULL_TIME:
        break;
      case Phase.IN_PLAY:
      default:
        this._tickInPlay(dt);
        break;
    }

    if (this.matchState.phase === Phase.IN_PLAY && this.matchState.isHalfOver()) {
      this._startHalfTimeOrFullTime();
    }
  }

  // ---------- 정상 플레이 ----------

  _tickInPlay(dt) {
    const allPlayers = [...this.homeTeam.players, ...this.awayTeam.players];

    for (const player of allPlayers) {
      const team = player.team;
      const opponentTeam = team === this.homeTeam ? this.awayTeam : this.homeTeam;
      const intent = decidePlayerIntent({
        player,
        team,
        opponentTeam,
        ball: this.ball,
        matchState: this.matchState,
        dt,
      });
      ActionExecutor.execute(player, intent, this.ball, this.eventBus);
    }

    for (const p of allPlayers) PhysicsEngine.movePlayer(p, dt);
    // 소유자가 있으면 공은 발에 부착되므로 자유 물리(마찰/포물선)를 적용하지 않는다
    if (!this.ball.owner) PhysicsEngine.updateBall(this.ball, dt);

    Collision.resolvePlayerOverlap(allPlayers);
    Collision.clampPlayersToPitch(allPlayers);

    if (!this._checkGoalkeeperSave()) {
      this._updatePossession(allPlayers, dt);
    }
    // 소유권 판정 후 공을 소유자 발 앞에 스냅 (방향 전환 시에도 공이 따라온다)
    this._attachBallToFoot();

    if (this.ball.owner) this.ball.owner.team.possessionSeconds += dt;

    this._checkBoundaries();
  }

  /**
   * 볼을 소유한 선수의 발 앞에 공을 물리적으로 부착한다. 렌더링만 속이는 것이 아니라
   * ball.position 자체를 매 틱 발 위치로 갱신하므로, 선수가 방향을 바꾸면 공도 함께 돌고
   * 절대 혼자 굴러가지 않는다. 드리블 능력이 낮을수록 공이 발에서 조금 더 떨어진다(터치 오차).
   */
  _attachBallToFoot() {
    const ball = this.ball;
    const player = ball.owner;
    if (!player) return;

    const dribbleSkill = player.attributes.dribbling / 100;
    const speed = player.velocity.length();

    // 렌더링되는 두 발 위치(중심에서 약 0.81m)에 맞춰 공을 놓는다. 몸 한가운데가 아니라 발 앞이다.
    // 정지 시 0.85m, 전력질주 시 최대 1.4m까지 앞으로 밀려나간다(드리블 능력 낮을수록 더 멀리).
    const footDist = 0.85 + (speed / Math.max(player.maxSpeed, 1e-6)) * (0.35 + (1 - dribbleSkill) * 0.2);
    const foot = Vector2D.fromAngle(player.facingAngle).scale(footDist);

    ball.position = Pitch.clampInside(player.position.add(foot), 0.1);
    ball.velocity = player.velocity.clone(); // 공은 선수와 함께 움직인다
    ball.height = 0;
    ball.verticalVelocity = 0;
  }

  /**
   * 슈팅한 공이 골키퍼의 다이빙 반경 안에 들어오면 정확히 발밑까지 오지 않아도
   * 선방을 시도한다. 일반 소유권 판정(BALL_CONTROL_RADIUS)보다 넓은 반경을 사용해
   * 골키퍼가 몸을 던져 막는 상황을 표현한다.
   */
  _checkGoalkeeperSave() {
    if (!this.ball.isShot) return false;
    for (const team of [this.homeTeam, this.awayTeam]) {
      const gk = team.goalkeeper;
      if (gk === this.ball.owner) continue;
      const dist = gk.position.sub(this.ball.position).length();
      if (dist < 2.2) {
        this._assignOwner(gk);
        return true;
      }
    }
    return false;
  }

  _updatePossession(allPlayers, dt = 0) {
    const ball = this.ball;
    ball.kickLockTimer = Math.max(0, ball.kickLockTimer - dt);

    if (ball.height > 0.8) {
      if (ball.owner) {
        ball.owner.hasBall = false;
        ball.owner = null;
      }
      return;
    }

    // 드리블 중 소유자는 공이 2.2m까지 벌어져도 소유권 유지 (터치 후 공이 앞으로 굴러가는 자연스러운 상황)
    const DRIBBLE_KEEP_RADIUS = 2.2;
    const inRange = Collision.playersWithinRadiusOfBall(allPlayers, ball, Collision.BALL_CONTROL_RADIUS);

    if (ball.owner) {
      const ownerDist = ball.owner.position.sub(ball.position).length();
      if (ownerDist <= DRIBBLE_KEEP_RADIUS) {
        // 태클 경합은 쿨다운을 두고 간헐적으로만 판정한다. 매 틱 판정하면 소유권이
        // 1초에도 수십 번 뒤집혀 경기가 진행되지 않는다.
        ball.duelCooldown = Math.max(0, (ball.duelCooldown ?? 0) - dt);
        if (ball.duelCooldown <= 0) {
          const challenger = inRange.find((p) => p.team !== ball.owner.team);
          if (challenger) {
            ball.duelCooldown = 0.6; // 성패와 무관하게 다음 경합까지 간격을 둔다
            const winner = DuelResolver.resolveTackle(challenger, ball.owner);
            if (winner === challenger) {
              ball.owner.hasBall = false;
              this._assignOwner(challenger);
            }
          }
        }
        return; // 소유권 유지
      }
      // 공이 너무 멀어지면 소유권 해제
      ball.owner.hasBall = false;
      ball.owner = null;
    }

    // 방금 공을 찬 선수는 잠금 시간 동안 다시 잡을 수 없다(패스/슛이 즉시 취소되는 것 방지)
    const claimable = ball.kickLockTimer > 0
      ? inRange.filter((p) => p !== ball.kicker)
      : inRange;

    if (claimable.length === 0) return;
    this._assignOwner(claimable[0]);
  }

  _assignOwner(player) {
    const ball = this.ball;
    if (player.role === 'GK' && ball.isShot && ball.velocity.length() > 7) {
      const reflexes = player.attributes.reflexes;
      const roll = Math.random() * 100;
      if (roll < reflexes * 0.5) {
        this._setOwner(player);
        ball.position = player.position.clone();
        this.eventBus.emit('save', { team: player.team, gk: player, held: true });
      } else if (roll < reflexes * 0.5 + 30) {
        const goalCenter = Pitch.goalCenter(player.team.attackingDirection === 1 ? 'left' : 'right');
        const away = ball.position.sub(goalCenter).normalize();
        const perp = new Vector2D(-away.y, away.x).scale(Math.random() < 0.5 ? 1 : -1);
        ball.velocity = perp.scale(4 + Math.random() * 5).add(away.scale(2));
        ball.isShot = false;
        ball.owner = null;
        this.eventBus.emit('save', { team: player.team, gk: player, held: false });
        return;
      } else {
        this._setOwner(player);
        ball.position = player.position.clone();
      }
      return;
    }
    this._setOwner(player);
  }

  _setOwner(player) {
    const ball = this.ball;
    const isNewController = ball.owner !== player;
    if (ball.owner) ball.owner.hasBall = false;
    ball.owner = player;
    player.hasBall = true;
    ball.lastTouchedBy = player;
    ball.lastTouchedTeam = player.team;
    ball.isShot = false;
    ball.passTargetPlayer = null; // 소유권이 결정되면 패스 수신자 정보 초기화

    // 공을 잡는 순간 공을 완전히 멈춰 발밑에 놓는다(트래핑). 굴러가던 관성이 남아
    // 곧바로 흘러나가는 현상을 막는다.
    ball.velocity = Vector2D.zero();
    ball.height = 0;
    ball.verticalVelocity = 0;
    ball.position = player.position.add(Vector2D.fromAngle(player.facingAngle).scale(0.85));

    if (isNewController && player.role !== 'GK') {
      player.brainMemory.controlTimer = 0.18 + Math.random() * 0.22;
      player.brainMemory.decisionCooldown = 0;
      player.brainMemory.lastIntent = null;
    }
  }

  // ---------- 아웃오브플레이 판정 ----------

  _checkBoundaries() {
    const { x, y } = this.ball.position;
    if (x <= 0 || x >= Pitch.LENGTH) {
      if (Pitch.isGoal(x, y)) {
        this._handleGoal(x);
      } else {
        this._handleGoalLineOut(x, y);
      }
      return;
    }
    if (y < 0 || y > Pitch.WIDTH) {
      this._handleThrowIn(x, y);
    }
  }

  _teamByDirection(dir) {
    return this.homeTeam.attackingDirection === dir ? this.homeTeam : this.awayTeam;
  }

  _handleGoal(x) {
    const isLeftGoal = x <= 0;
    const scoringTeam = isLeftGoal ? this._teamByDirection(-1) : this._teamByDirection(1);
    scoringTeam.score += 1;
    this.matchState.score[scoringTeam.side] = scoringTeam.score;
    this.matchState.lastEvent = `GOAL: ${scoringTeam.name}`;
    this.eventBus.emit('goal', { team: scoringTeam });

    this.ball.velocity = Vector2D.zero();
    this.ball.owner = null;
    this.matchState.phase = Phase.GOAL_SCORED;
    this.matchState.phaseTimer = 2.5;
    this._pendingKickoffTeam = scoringTeam === this.homeTeam ? this.awayTeam : this.homeTeam;
  }

  _handleGoalLineOut(x, y) {
    const isLeftGoal = x <= 0;
    const defendingTeam = isLeftGoal ? this._teamByDirection(1) : this._teamByDirection(-1);
    const attackingTeam = defendingTeam === this.homeTeam ? this.awayTeam : this.homeTeam;

    if (this.ball.lastTouchedTeam === defendingTeam) {
      this._setupCorner(attackingTeam, isLeftGoal, y);
    } else {
      this._setupGoalKick(defendingTeam, isLeftGoal);
    }
  }

  _handleThrowIn(x, y) {
    const outTeam = this.ball.lastTouchedTeam;
    const throwTeam = outTeam ? (outTeam === this.homeTeam ? this.awayTeam : this.homeTeam) : this.homeTeam;
    const clampedX = Math.max(1, Math.min(Pitch.LENGTH - 1, x));
    const edgeY = y < Pitch.WIDTH / 2 ? 0.3 : Pitch.WIDTH - 0.3;
    this._setupThrowIn(throwTeam, clampedX, edgeY);
  }

  // ---------- 세트피스 셋업 ----------

  _setupKickoff(kickingTeam) {
    this.homeTeam.applyFormationBasePositions();
    this.awayTeam.applyFormationBasePositions();
    const allPlayers = [...this.homeTeam.players, ...this.awayTeam.players];
    for (const p of allPlayers) p.reset(p.basePosition);

    this.ball.reset(Pitch.center());
    const taker = this._nearestPlayer(kickingTeam, Pitch.center(), true);
    taker.position = Pitch.center().clone();
    this._setOwner(taker);

    this._kickoffTaker = taker;
    this._pendingKickoffTeam = kickingTeam;
    this.matchState.phase = Phase.KICKOFF;
    this.matchState.phaseTimer = 1.0;
    this.matchState.restartInfo = { type: 'KICKOFF', team: kickingTeam, taker };
    this.eventBus.emit('restart', { type: 'KICKOFF', team: kickingTeam });
  }

  _setupThrowIn(team, x, y) {
    this.ball.reset(new Vector2D(x, y));
    const taker = this._nearestPlayer(team, this.ball.position, true);
    taker.position = this.ball.position.clone();
    taker.velocity = Vector2D.zero();
    taker.desiredVelocity = Vector2D.zero();
    taker.facingAngle = Pitch.center().sub(taker.position).angle();
    taker.desiredFacingAngle = taker.facingAngle;
    this._setOwner(taker);
    // _setOwner가 공을 발 앞으로 옮기므로, 스로인 지점(터치라인 위)으로 되돌린다
    const spot = new Vector2D(x, y);
    this.ball.position = spot.clone();
    this.matchState.phase = Phase.THROW_IN;
    this.matchState.phaseTimer = 1.0;
    this.matchState.restartInfo = { type: 'THROW_IN', team, taker, spot };
    this.eventBus.emit('restart', { type: 'THROW_IN', team });
  }

  /** 스로인 규정: 상대 선수는 공에서 5m 밖으로 물러나야 한다 */
  _enforceThrowInDistance() {
    const info = this.matchState.restartInfo;
    if (!info || info.type !== 'THROW_IN') return;
    const opponents = info.team === this.homeTeam ? this.awayTeam.players : this.homeTeam.players;
    const MIN_DIST = 5;
    for (const o of opponents) {
      const delta = o.position.sub(this.ball.position);
      const d = delta.length();
      if (d < MIN_DIST) {
        const dir = d > 1e-6 ? delta.normalize() : Vector2D.fromAngle(Math.random() * Math.PI * 2);
        o.position = Pitch.clampInside(this.ball.position.add(dir.scale(MIN_DIST)), 0.45);
      }
    }
  }

  _setupCorner(team, isLeftGoal, y) {
    const cx = isLeftGoal ? 0.4 : Pitch.LENGTH - 0.4;
    const cy = y < Pitch.WIDTH / 2 ? 0.4 : Pitch.WIDTH - 0.4;
    this.ball.reset(new Vector2D(cx, cy));
    const taker = this._nearestPlayer(team, this.ball.position, true);
    taker.position = this.ball.position.clone();
    taker.velocity = Vector2D.zero();
    taker.desiredVelocity = Vector2D.zero();
    taker.facingAngle = Pitch.goalCenter(isLeftGoal ? 'left' : 'right').sub(taker.position).angle();
    taker.desiredFacingAngle = taker.facingAngle;
    this._setOwner(taker);
    this.ball.position = new Vector2D(cx, cy); // 코너 아크 위로 되돌린다
    this.matchState.phase = Phase.CORNER_KICK;
    this.matchState.phaseTimer = 1.6;
    this.matchState.restartInfo = { type: 'CORNER', team, taker };
    this.eventBus.emit('restart', { type: 'CORNER', team });
  }

  _setupGoalKick(team, isLeftGoal) {
    const gx = isLeftGoal ? Pitch.GOAL_BOX_LENGTH * 0.6 : Pitch.LENGTH - Pitch.GOAL_BOX_LENGTH * 0.6;
    const gy = Pitch.WIDTH / 2;
    this.ball.reset(new Vector2D(gx, gy));
    const gk = team.goalkeeper;
    gk.position = this.ball.position.clone();
    gk.velocity = Vector2D.zero();
    gk.desiredVelocity = Vector2D.zero();
    gk.facingAngle = team.attackingDirection === 1 ? 0 : Math.PI;
    gk.desiredFacingAngle = gk.facingAngle;
    this._setOwner(gk);
    this.ball.position = new Vector2D(gx, gy); // 골 에어리어 스폿으로 되돌린다
    this.matchState.phase = Phase.GOAL_KICK;
    this.matchState.phaseTimer = 1.2;
    this.matchState.restartInfo = { type: 'GOAL_KICK', team, taker: gk };
    this.eventBus.emit('restart', { type: 'GOAL_KICK', team });
  }

  _nearestPlayer(team, pos, excludeGK = false) {
    const pool = excludeGK ? team.outfieldPlayers : team.players;
    let best = null;
    let bestDist = Infinity;
    for (const p of pool) {
      const d = p.position.sub(pos).length();
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  _chooseReceiver(taker, team, opponentTeam) {
    let best = null;
    let bestScore = -Infinity;
    for (const t of team.players) {
      if (t === taker) continue;
      const dist = t.position.sub(taker.position).length();
      if (dist < 3 || dist > 50) continue;
      const pressure = opponentTeam.players.filter((o) => o.position.sub(t.position).length() < 4).length;
      const forward = (t.position.x - taker.position.x) * team.attackingDirection;
      const score = forward * 0.6 - pressure * 10 - dist * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  // ---------- 재개 대기 국면 ----------

  _tickRestartPhase(dt, isKickoff) {
    if (!isKickoff && !this.matchState.restartInfo) {
      this.matchState.phase = Phase.IN_PLAY;
      return;
    }
    const allPlayers = [...this.homeTeam.players, ...this.awayTeam.players];
    const restartTeam = isKickoff ? this._pendingKickoffTeam : this.matchState.restartInfo.team;
    const taker = isKickoff ? this._kickoffTaker : this.matchState.restartInfo.taker;

    // 스로인이면 가까운 팀원 2명을 지목해 볼을 받으러 오게 한다
    const throwInSupporters = new Set();
    if (!isKickoff && this.matchState.restartInfo.type === 'THROW_IN') {
      const candidates = restartTeam.outfieldPlayers
        .filter((p) => p !== taker)
        .sort((a, b) => a.position.sub(taker.position).length() - b.position.sub(taker.position).length())
        .slice(0, 2);
      candidates.forEach((p) => throwInSupporters.add(p));
    }

    for (const player of allPlayers) {
      if (player === taker || player.role === 'GK') continue;

      if (throwInSupporters.has(player)) {
        // 스로어로부터 6~9m 떨어진 필드 안쪽 지점으로 이동해 받을 준비
        const inward = Pitch.center().sub(taker.position).normalize();
        const along = new Vector2D(-inward.y, inward.x);
        const idx = [...throwInSupporters].indexOf(player);
        const spread = idx === 0 ? 1 : -1;
        const spot = taker.position
          .add(inward.scale(5 + idx * 2))
          .add(along.scale(spread * (4 + idx * 2)));
        ActionExecutor.execute(
          player,
          { type: 'MOVE', target: Pitch.clampInside(spot, 1.5), sprint: true },
          this.ball,
          this.eventBus
        );
        continue;
      }

      const inPossession = player.team === restartTeam;
      const target = computeSupportPosition({ player, team: player.team, ball: this.ball, inPossession });
      ActionExecutor.execute(player, { type: 'MOVE', target, sprint: false }, this.ball, this.eventBus);
    }

    for (const p of allPlayers) PhysicsEngine.movePlayer(p, dt);
    Collision.resolvePlayerOverlap(allPlayers);
    Collision.clampPlayersToPitch(allPlayers);

    // 스로인: 공과 스로어를 터치라인 위 지점에 고정(드리블 불가), 상대는 5m 밖으로
    if (!isKickoff && this.matchState.restartInfo.type === 'THROW_IN') {
      const spot = this.matchState.restartInfo.spot;
      this.ball.position = spot.clone();
      this.ball.velocity = Vector2D.zero();
      taker.position = spot.clone();
      taker.velocity = Vector2D.zero();
      taker.desiredVelocity = Vector2D.zero();
      this._enforceThrowInDistance();

      const closeTeammates = restartTeam.outfieldPlayers.filter(
        (p) => p !== taker && p.position.sub(taker.position).length() < 10
      ).length;
      if (closeTeammates >= 1) this.matchState.phaseTimer = 0;
      else if (this.matchState.phaseTimer < 0.3) this.matchState.phaseTimer = 0.3; // 동료가 올 때까지 대기
    }

    this.matchState.phaseTimer -= dt;
    if (this.matchState.phaseTimer <= 0) {
      if (isKickoff) this._executeKickoff();
      else this._executeSetPieceRestart();
    }
  }

  _executeKickoff() {
    const taker = this._kickoffTaker;
    const opponentTeam = taker.team === this.homeTeam ? this.awayTeam : this.homeTeam;
    const receiver =
      this._chooseReceiver(taker, taker.team, opponentTeam) ??
      taker.team.players.find((p) => p !== taker && p.role !== 'GK');
    ActionExecutor.execute(taker, { type: 'PASS', targetPlayer: receiver, lofted: false }, this.ball, this.eventBus);
    this.matchState.phase = Phase.IN_PLAY;
    this.matchState.restartInfo = null;
  }

  _executeSetPieceRestart() {
    const info = this.matchState.restartInfo;
    const taker = info.taker;
    const team = info.team;
    const opponentTeam = team === this.homeTeam ? this.awayTeam : this.homeTeam;
    const receiver = this._chooseReceiver(taker, team, opponentTeam) ?? team.players.find((p) => p !== taker);
    const lofted = info.type !== 'THROW_IN';
    ActionExecutor.execute(taker, { type: 'PASS', targetPlayer: receiver, lofted }, this.ball, this.eventBus);
    this.matchState.phase = Phase.IN_PLAY;
    this.matchState.restartInfo = null;
  }

  // ---------- 골 세리머니 / 하프타임 / 풀타임 ----------

  _tickGoalScored(dt) {
    this.matchState.phaseTimer -= dt;
    if (this.matchState.phaseTimer <= 0) {
      this._setupKickoff(this._pendingKickoffTeam);
    }
  }

  _startHalfTimeOrFullTime() {
    if (this.matchState.half === 1) {
      this.matchState.phase = Phase.HALF_TIME;
      this.matchState.phaseTimer = 2.0;
      this.eventBus.emit('halftime', {});
    } else {
      this.matchState.phase = Phase.FULL_TIME;
      this.eventBus.emit('fulltime', { score: { ...this.matchState.score } });
    }
  }

  _tickHalfTime(dt) {
    this.matchState.phaseTimer -= dt;
    if (this.matchState.phaseTimer <= 0) {
      this.homeTeam.flipAttackingDirection();
      this.awayTeam.flipAttackingDirection();
      this.matchState.startSecondHalf();
      this._setupKickoff(this._secondHalfKickoffTeam);
    }
  }
}
