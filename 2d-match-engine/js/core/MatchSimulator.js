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
      case Phase.SET_PIECE_SETUP:
        this._tickSetPieceSetup(dt);
        break;
      case Phase.THROW_IN:
      case Phase.CORNER_KICK:
      case Phase.GOAL_KICK:
      case Phase.FREE_KICK:
        this._tickRestartPhase(dt, false);
        break;
      case Phase.GK_POSSESSION:
        this._tickGkPossession(dt);
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

    // ── Stage 5: 가로채기/블로킹 — 패스·슛 궤적 위 수비수의 차단 판정 ──
    // 비행(킥)당 1회만 판정해 매 틱 반복되며 공이 떨어지는 것을 방지한다
    if (!ball.owner && !ball.interceptionDone && ball.speed() > 6 && ball.height < 3.2) {
      ball.interceptionDone = true;
      if (this._tryInterception(allPlayers)) return;
    }

    if (ball.height > 0.8) {
      if (ball.owner) {
        ball.owner.hasBall = false;
        ball.owner = null;
      }
      return;
    }

    const DRIBBLE_KEEP_RADIUS = 2.2;
    const inRange = Collision.playersWithinRadiusOfBall(allPlayers, ball, Collision.BALL_CONTROL_RADIUS);

    if (ball.owner) {
      const ownerDist = ball.owner.position.sub(ball.position).length();
      if (ownerDist <= DRIBBLE_KEEP_RADIUS) {
        ball.duelCooldown = Math.max(0, (ball.duelCooldown ?? 0) - dt);
        if (ball.duelCooldown <= 0) {
          const challenger = inRange.find((p) => p.team !== ball.owner.team);
          if (challenger) {
            ball.duelCount = (ball.duelCount ?? 0) + 1;
            const holder = ball.owner;
            const winner = DuelResolver.resolveTackle(challenger, holder);

            if (winner === challenger) {
              // 4단계 결과 ①: 수비수 승리 — 소유 or 루즈볼
              ball.duelCount = 0;
              ball.duelCooldown = 1.0;
              const looseChance = 0.25 + (1 - challenger.attributes.tackling / 100) * 0.3;
              if (Math.random() < looseChance) {
                holder.hasBall = false;
                const dir = Vector2D.fromAngle(challenger.facingAngle + (Math.random() - 0.5) * 1.5);
                ball.owner = null;
                ball.kicker = challenger;
                ball.kickLockTimer = 0.25;
                ball.velocity = dir.scale(4 + Math.random() * 3);
                ball.isShot = false;
                this.eventBus.emit('tackle', { winner: challenger, loose: true });
              } else {
                holder.hasBall = false;
                this._assignOwner(challenger);
                this.eventBus.emit('tackle', { winner: challenger, loose: false });
              }
            } else {
              // 4단계 결과 ②: 공격수 승리 — 수비수 멈칫 + 일정 확률 파울
              challenger.brainMemory.stunTimer = 0.4 + Math.random() * 0.5;
              const foulChance = 0.04 + (1 - challenger.attributes.tackling / 100) * 0.1;
              if (Math.random() < foulChance) {
                this._triggerFoul(challenger, holder);
                return;
              }
              if (ball.duelCount >= 2) {
                // 2회 이상 경합 → 밀어내기로 빠르게 마무리
                const pushDir = challenger.position.sub(holder.position).normalize();
                challenger.position = Pitch.clampInside(
                  challenger.position.add(pushDir.scale(2.0)), 0.5
                );
                challenger.velocity = pushDir.scale(2.5);
                ball.duelCount = 0;
                ball.duelCooldown = 1.8; // 장시간 냉각
              } else {
                ball.duelCooldown = 0.5;
              }
            }
          } else {
            ball.duelCount = 0; // 상대 없으면 리셋
          }
        }
        return;
      }
      ball.owner.hasBall = false;
      ball.owner = null;
    }

    const claimable = ball.kickLockTimer > 0
      ? inRange.filter((p) => p !== ball.kicker)
      : inRange;

    if (claimable.length === 0) return;
    this._assignOwner(claimable[0]);
  }

  /**
   * Stage 5: 패스/슛 공의 예상 궤적(velocity * 0.6s) 위를 지나치는 수비수를 찾아
   * interception 능력치로 가로채기(소유) 또는 몸에 맞고 굴절(Deflection)을 판정한다.
   */
  _tryInterception(allPlayers) {
    const ball = this.ball;
    const speed = ball.speed();
    const dir = ball.velocity.normalize();
    const trajEnd = ball.position.add(dir.scale(Math.min(speed * 0.6, 14)));

    let best = null;
    let bestT = Infinity;
    for (const p of allPlayers) {
      if (p.role === 'GK') continue;
      if (ball.kickLockTimer > 0 && p === ball.kicker) continue;
      const { dist, t } = this._segmentDistance(p.position, ball.position, trajEnd);
      if (t > 0.03 && t < 0.8 && dist < 1.25 && t < bestT) {
        bestT = t;
        best = p;
      }
    }
    if (!best) return false;

    const skill = (best.attributes.interception ?? 50) / 100;
    const pacePenalty = Math.max(0.3, 1 - speed * 0.02);
    const interceptChance = skill * pacePenalty * 0.5;
    const roll = Math.random();

    if (roll < interceptChance) {
      if (ball.isShot) {
        this._deflectBall(best); // 슛은 몸을 던져 블로킹
      } else {
        this._assignOwner(best); // 깔끔하게 가로채기 → 소유
        this.eventBus.emit('interception', { player: best });
      }
      return true;
    }
    if (roll < interceptChance + 0.2) {
      this._deflectBall(best); // 몸에 맞고 굴절
      return true;
    }
    return false; // 놓침 → 통과
  }

  /**
   * 공이 수비수 몸에 맞고 튕겨 나가는 굴절 물리.
   * 입사 벡터를 수비수 중심 기준 법선으로 반사하고 에너지를 감쇠시킨다.
   */
  _deflectBall(player) {
    const ball = this.ball;
    const speed = ball.speed();
    const dir = speed > 1e-3 ? ball.velocity.normalize() : Vector2D.fromAngle(Math.random() * Math.PI * 2);
    const n = ball.position.sub(player.position);
    const normal = n.length() > 1e-3 ? n.normalize() : Vector2D.fromAngle(dir.angle() + Math.PI / 2);
    const reflect = dir.sub(normal.scale(2 * dir.dot(normal)));
    ball.velocity = reflect
      .scale(speed * 0.55)
      .add(Vector2D.fromAngle((Math.random() - 0.5) * 0.6, speed * 0.2));
    ball.height = Math.max(0, ball.height * 0.4);
    ball.isShot = false;
    ball.owner = null;
    // 편향 후 루즈볼: 어느 팀도 점유하지 않은 상태로 전환
    ball.lastTouchedTeam = null;
    ball.passTargetPlayer = null;
    ball.kickLockTimer = Math.max(ball.kickLockTimer, 0.2);
    this.eventBus.emit('block', { player });
  }

  _segmentDistance(p, a, b) {
    const ab = b.sub(a);
    const lenSq = ab.lengthSq();
    let t = lenSq > 1e-6 ? p.sub(a).dot(ab) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const proj = a.add(ab.scale(t));
    return { dist: p.sub(proj).length(), t };
  }

  /**
   * Stage 4 결과 ③: 파울 선언 — 경기 중단 후 피해 팀에게 프리킥을 부여한다.
   */
  _triggerFoul(defender, fouledAttacker) {
    const attackingTeam = fouledAttacker.team;
    const spot = Pitch.clampInside(this.ball.position, 1.2);

    this.ball.reset(spot);
    const taker = this._nearestPlayer(attackingTeam, spot, true);
    taker.position = spot.clone();
    taker.velocity = Vector2D.zero();
    taker.desiredVelocity = Vector2D.zero();
    taker.facingAngle = attackingTeam.attackingDirection === 1 ? 0 : Math.PI;
    taker.desiredFacingAngle = taker.facingAngle;
    this._setOwner(taker);
    this.ball.position = spot.clone();

    this.matchState.phase = Phase.FREE_KICK;
    this.matchState.phaseTimer = 1.2;
    this.matchState.restartInfo = { type: 'FREE_KICK', team: attackingTeam, taker, spot };
    this.eventBus.emit('foul', { team: attackingTeam, by: defender, spot });
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
        // 파리 후 루즈볼: 어느 팀도 점유하지 않은 상태로 전환해 양팀이 볼을 쫓게 한다
        ball.lastTouchedTeam = null;
        ball.passTargetPlayer = null;
        this.eventBus.emit('save', { team: player.team, gk: player, held: false });
        return;
      } else {
        this._setOwner(player);
        ball.position = player.position.clone();
      }
    } else {
      this._setOwner(player);
    }

    // GK가 일반 플레이 중 공을 잡으면 → 선수 복귀 국면으로 전환
    if (player.role === 'GK' && this.matchState.phase === Phase.IN_PLAY) {
      this._setupGkPossession(player);
    }
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
    const targets = this._computeThrowInTargets(team, taker, spot);
    this.matchState.phase = Phase.SET_PIECE_SETUP;
    this.matchState.phaseTimer = 3.5; // 최대 배치 시간
    this.matchState.restartInfo = { type: 'THROW_IN', team, taker, spot, targets };
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
    const cornerPos = new Vector2D(cx, cy);
    this.ball.reset(cornerPos.clone());
    const taker = this._nearestPlayer(team, this.ball.position, true);
    taker.position = cornerPos.clone();
    taker.velocity = Vector2D.zero();
    taker.desiredVelocity = Vector2D.zero();
    taker.facingAngle = Pitch.goalCenter(isLeftGoal ? 'left' : 'right').sub(taker.position).angle();
    taker.desiredFacingAngle = taker.facingAngle;
    this._setOwner(taker);
    this.ball.position = cornerPos.clone(); // 코너 아크 위로 되돌린다
    const targets = this._computeCornerTargets(team, taker, isLeftGoal, y);
    this.matchState.phase = Phase.SET_PIECE_SETUP;
    this.matchState.phaseTimer = 4.0; // 코너킥은 배치 시간이 더 길다
    this.matchState.restartInfo = { type: 'CORNER', team, taker, spot: cornerPos, targets };
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
    this.ball.position = new Vector2D(gx, gy);
    this.matchState.phase = Phase.GOAL_KICK;
    // 골킥은 선수들이 제자리로 돌아올 수 있도록 3~5초 대기
    this.matchState.phaseTimer = 3.0 + Math.random() * 2.0;
    this.matchState.restartInfo = { type: 'GOAL_KICK', team, taker: gk };
    this.eventBus.emit('restart', { type: 'GOAL_KICK', team });
  }

  // ---------- 세트피스 배치 국면 ----------

  /**
   * SET_PIECE_SETUP: 선수들이 지정 위치로 이동하는 동안 공·테이커를 스팟에 고정한다.
   * 전체 선수의 90% 이상이 목표 2m 이내에 도달하거나 타임아웃 시 실제 세트피스 국면으로 전환.
   */
  _tickSetPieceSetup(dt) {
    const info = this.matchState.restartInfo;
    if (!info?.targets) {
      this.matchState.phase = Phase.IN_PLAY;
      return;
    }

    const allPlayers = [...this.homeTeam.players, ...this.awayTeam.players];
    const targets = info.targets;
    const spot = info.spot ?? this.ball.position.clone();

    let atTarget = 0;
    let totalTargeted = 0;

    for (const player of allPlayers) {
      if (player === info.taker) {
        // 테이커는 스팟에 고정
        player.position = spot.clone();
        player.velocity = Vector2D.zero();
        player.desiredVelocity = Vector2D.zero();
        atTarget++;
        totalTargeted++;
        continue;
      }

      if (player.role === 'GK') {
        // GK: 자기 골문으로 복귀
        const ownGoalSide = player.team.attackingDirection === 1 ? 'left' : 'right';
        const ownGoalX = ownGoalSide === 'left' ? 0 : Pitch.LENGTH;
        const outward = ownGoalSide === 'left' ? 1 : -1;
        ActionExecutor.execute(
          player,
          { type: 'MOVE', target: new Vector2D(ownGoalX + outward * 1.5, Pitch.WIDTH / 2), sprint: false },
          this.ball,
          this.eventBus
        );
        continue;
      }

      const target = targets.get(player.id);
      if (!target) continue;
      totalTargeted++;

      const dist = player.position.sub(target).length();
      if (dist <= 2.0) atTarget++;

      ActionExecutor.execute(
        player,
        { type: 'MOVE', target: target.clone(), sprint: dist > 8 },
        this.ball,
        this.eventBus
      );
    }

    // 공·테이커 고정
    this.ball.position = spot.clone();
    this.ball.velocity = Vector2D.zero();

    for (const p of allPlayers) PhysicsEngine.movePlayer(p, dt);
    Collision.resolvePlayerOverlap(allPlayers);
    Collision.clampPlayersToPitch(allPlayers);

    // 물리 이후 다시 고정
    info.taker.position = spot.clone();
    info.taker.velocity = Vector2D.zero();
    this.ball.position = spot.clone();
    this.ball.velocity = Vector2D.zero();

    this.matchState.phaseTimer -= dt;
    const completionRate = totalTargeted > 0 ? atTarget / totalTargeted : 1;

    if (completionRate >= 0.9 || this.matchState.phaseTimer <= 0) {
      switch (info.type) {
        case 'THROW_IN':
          this.matchState.phase = Phase.THROW_IN;
          this.matchState.phaseTimer = 1.0;
          break;
        case 'CORNER':
          this.matchState.phase = Phase.CORNER_KICK;
          this.matchState.phaseTimer = 1.6;
          break;
        default:
          this.matchState.phase = Phase.IN_PLAY;
          this.matchState.restartInfo = null;
      }
    }
  }

  /** 스로인 배치: 공격팀 4명이 터치라인 인근 볼 주변으로 모이고, 상대는 5m 거리 유지 */
  _computeThrowInTargets(team, taker, spot) {
    const targets = new Map();
    targets.set(taker.id, spot.clone());

    const opponentTeam = team === this.homeTeam ? this.awayTeam : this.homeTeam;
    const inward = Pitch.center().sub(spot).normalize();
    const along = new Vector2D(-inward.y, inward.x);

    // 가장 가까운 동료 4명이 터치라인 안쪽으로 달려와 수신 대기
    const supporters = team.outfieldPlayers
      .filter((p) => p !== taker)
      .sort((a, b) => a.position.sub(spot).length() - b.position.sub(spot).length())
      .slice(0, 4);

    supporters.forEach((p, i) => {
      const sign = i % 2 === 0 ? 1 : -1;
      const offset = inward.scale(5 + i * 2.5).add(along.scale(sign * (2 + i * 1.5)));
      targets.set(p.id, Pitch.clampInside(spot.add(offset), 1.5));
    });

    // 나머지 동료: 기본 포지션으로
    for (const p of team.outfieldPlayers) {
      if (!targets.has(p.id)) {
        targets.set(p.id, Pitch.clampInside(p.basePosition.clone(), 1.5));
      }
    }

    // 상대팀: 5m 규정 거리 확보, 이미 멀면 기본 포지션 유지
    for (const p of opponentTeam.outfieldPlayers) {
      const toSpot = p.position.sub(spot);
      const d = toSpot.length();
      if (d < 5) {
        const pushDir = d > 0.01 ? toSpot.normalize() : Vector2D.fromAngle(Math.random() * Math.PI * 2);
        targets.set(p.id, Pitch.clampInside(spot.add(pushDir.scale(5.5)), 0.5));
      } else {
        targets.set(p.id, Pitch.clampInside(p.basePosition.clone(), 1.5));
      }
    }

    return targets;
  }

  /** 코너킥 배치: 공격팀은 박스 안으로, 수비팀은 포스트·박스 안 마킹 위치로 */
  _computeCornerTargets(team, taker, isLeftGoal, cornerY) {
    const targets = new Map();
    const cx = isLeftGoal ? 0.4 : Pitch.LENGTH - 0.4;
    const cy = cornerY < Pitch.WIDTH / 2 ? 0.4 : Pitch.WIDTH - 0.4;
    targets.set(taker.id, new Vector2D(cx, cy));

    const opponentTeam = team === this.homeTeam ? this.awayTeam : this.homeTeam;
    const goalX = isLeftGoal ? 0 : Pitch.LENGTH;
    const intoField = isLeftGoal ? 1 : -1; // 골라인 → 필드 안쪽 방향
    const [topY, bottomY] = Pitch.goalYRange();
    const centerY = (topY + bottomY) / 2;
    const penEdgeX = goalX + intoField * Pitch.PENALTY_BOX_LENGTH;

    // 공격팀: 에어리얼 위협 역할(ST>CB>CM) 우선으로 박스 안쪽 스팟 배정
    const aerialRoles = ['ST', 'CB', 'CM'];
    const boxSpots = [
      new Vector2D(goalX + intoField * 5.5, centerY - 3.5),
      new Vector2D(goalX + intoField * 8.5, centerY + 4.5),
      new Vector2D(goalX + intoField * 11, centerY - 1),
    ];
    const sortedPlayers = [...team.outfieldPlayers]
      .filter((p) => p !== taker)
      .sort((a, b) => {
        const pri = (p) => aerialRoles.indexOf(p.role) < 0 ? 99 : aerialRoles.indexOf(p.role);
        return pri(a) - pri(b);
      });

    let boxIdx = 0;
    for (const p of sortedPlayers) {
      if (boxIdx < boxSpots.length && aerialRoles.includes(p.role)) {
        targets.set(p.id, Pitch.clampInside(boxSpots[boxIdx++], 0.5));
      } else if (p.role === 'LM' || p.role === 'RM') {
        const edgeY = p.role === 'LM' ? Math.max(1, topY - 2) : Math.min(Pitch.WIDTH - 1, bottomY + 2);
        targets.set(p.id, Pitch.clampInside(new Vector2D(penEdgeX, edgeY), 0.5));
      } else if (p.role === 'LB' || p.role === 'RB') {
        // 수비형 풀백: 하프라인에 남아 역습 대비
        targets.set(p.id, new Vector2D(Pitch.LENGTH / 2, p.basePosition.y));
      } else {
        // 나머지: 페널티 박스 가장자리
        targets.set(p.id, Pitch.clampInside(new Vector2D(penEdgeX, p.basePosition.y), 0.5));
      }
    }

    // 수비팀: LB/RB → 포스트, CB → 박스 안 존 수비, 나머지 → 박스 안 마킹
    const postPositions = [
      new Vector2D(goalX, topY + 0.5),
      new Vector2D(goalX, bottomY - 0.5),
    ];
    let postIdx = 0;
    let cbCount = 0;
    let defMidCount = 0;

    for (const p of opponentTeam.outfieldPlayers) {
      if ((p.role === 'LB' || p.role === 'RB') && postIdx < postPositions.length) {
        targets.set(p.id, postPositions[postIdx++]);
      } else if (p.role === 'CB') {
        const cbX = goalX + intoField * (4 + cbCount * 3);
        targets.set(p.id, Pitch.clampInside(
          new Vector2D(cbX, centerY + (cbCount++ % 2 === 0 ? -3.5 : 3.5)), 0.5
        ));
      } else {
        const markX = goalX + intoField * (7 + defMidCount * 3);
        targets.set(p.id, Pitch.clampInside(new Vector2D(markX, p.basePosition.y), 0.5));
        defMidCount++;
      }
    }

    return targets;
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
    const throwInMarkerToSupporter = new Map(); // 마커(상대) → 담당 서포터
    if (!isKickoff && this.matchState.restartInfo.type === 'THROW_IN') {
      const candidates = restartTeam.outfieldPlayers
        .filter((p) => p !== taker)
        .sort((a, b) => a.position.sub(taker.position).length() - b.position.sub(taker.position).length())
        .slice(0, 2);
      candidates.forEach((p) => throwInSupporters.add(p));

      // 각 서포터를 마크할 상대 1명씩 지목 (이미 지목된 마커는 제외)
      const usedMarkers = new Set();
      for (const supporter of throwInSupporters) {
        const opponentTeamForThrow = restartTeam === this.homeTeam ? this.awayTeam : this.homeTeam;
        let closestMarker = null;
        let closestDist = Infinity;
        for (const opp of opponentTeamForThrow.outfieldPlayers) {
          if (usedMarkers.has(opp)) continue;
          const d = opp.position.sub(supporter.position).length();
          if (d < closestDist) { closestDist = d; closestMarker = opp; }
        }
        if (closestMarker) {
          throwInMarkerToSupporter.set(closestMarker, supporter);
          usedMarkers.add(closestMarker);
        }
      }
    }

    const throwInSpot = (!isKickoff && this.matchState.restartInfo?.spot)
      ? this.matchState.restartInfo.spot : null;

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

      // 마커: 담당 서포터와 공 사이를 차단하는 위치로 이동
      if (throwInMarkerToSupporter.has(player)) {
        const assignedSupporter = throwInMarkerToSupporter.get(player);
        const ballToTarget = assignedSupporter.position.sub(this.ball.position).normalize();
        const markPos = assignedSupporter.position.add(ballToTarget.scale(-1.8));
        ActionExecutor.execute(
          player,
          { type: 'MOVE', target: Pitch.clampInside(markPos, 0.5), sprint: false, speedFactor: 0.65 },
          this.ball,
          this.eventBus
        );
        continue;
      }

      // 나머지: 기본 포지션으로 복귀 (스로인 지점 방향으로 약간 당긴다)
      let baseTarget = player.basePosition.clone();
      if (throwInSpot) {
        const toSpot = throwInSpot.sub(baseTarget);
        const pull = Math.min(toSpot.length() * 0.2, 7);
        if (pull > 0.5) baseTarget = baseTarget.add(toSpot.normalize().scale(pull));
      }
      const dist = player.position.sub(baseTarget).length();
      const sf = dist > 14 ? 0.75 : dist > 7 ? 0.55 : 0.4;
      ActionExecutor.execute(
        player,
        { type: 'MOVE', target: Pitch.clampInside(baseTarget, 1.2), sprint: false, speedFactor: sf },
        this.ball,
        this.eventBus
      );
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

    let receiver = null;
    let lofted = false;

    if (info.type === 'GOAL_KICK') {
      // 골킥: 35% 확률 단패스, 65% 롱볼
      const useShort = Math.random() < 0.35;
      if (useShort) {
        let bestScore = -Infinity;
        for (const p of team.outfieldPlayers) {
          const dist = p.position.sub(taker.position).length();
          if (dist < 3 || dist > 30) continue;
          const pressure = opponentTeam.players.filter((o) => o.position.sub(p.position).length() < 4).length;
          const score = -pressure * 10 - dist * 0.05;
          if (score > bestScore) { bestScore = score; receiver = p; }
        }
      }
      if (!receiver) receiver = this._chooseReceiver(taker, team, opponentTeam);
      if (!receiver) receiver = team.outfieldPlayers[0];
      lofted = !useShort;
    } else {
      receiver = this._chooseReceiver(taker, team, opponentTeam) ?? team.players.find((p) => p !== taker);
      lofted = info.type === 'CORNER' || info.type === 'GOAL_KICK';
    }

    ActionExecutor.execute(taker, { type: 'PASS', targetPlayer: receiver, lofted }, this.ball, this.eventBus);
    this.matchState.phase = Phase.IN_PLAY;
    this.matchState.restartInfo = null;
  }

  // ---------- GK 소유 국면 ----------

  /** GK가 공을 잡으면 모든 선수가 자기 포지션으로 복귀하는 국면을 시작한다 */
  _setupGkPossession(gk) {
    gk.brainMemory.gkHoldTimer = 0;
    this.matchState.phase = Phase.GK_POSSESSION;
    // 2.5~3.5초 후에 GK가 공을 찬다
    this.matchState.phaseTimer = 2.5 + Math.random();
    this.matchState.restartInfo = { type: 'GK_POSSESSION', taker: gk, team: gk.team };
  }

  _tickGkPossession(dt) {
    const info = this.matchState.restartInfo;
    if (!info || !info.taker.hasBall) {
      // GK가 공을 잃으면 즉시 IN_PLAY로 복귀
      this.matchState.phase = Phase.IN_PLAY;
      this.matchState.restartInfo = null;
      return;
    }

    const gk = info.taker;
    const gkTeam = info.team;
    const allPlayers = [...this.homeTeam.players, ...this.awayTeam.players];

    // GK는 제자리에서 공을 잡고 있는다
    gk.desiredVelocity = Vector2D.zero();
    this.ball.position = gk.position.add(Vector2D.fromAngle(gk.facingAngle).scale(0.6));
    this.ball.velocity = Vector2D.zero();

    for (const player of allPlayers) {
      if (player === gk) continue;

      if (player.role === 'GK') {
        // 상대 GK: 자기 골문으로 복귀
        const ownGoalSide = player.team.attackingDirection === 1 ? 'left' : 'right';
        const ownGoalX = ownGoalSide === 'left' ? 0 : Pitch.LENGTH;
        const outward = ownGoalSide === 'left' ? 1 : -1;
        const gkTarget = new Vector2D(ownGoalX + outward * 3, Pitch.WIDTH / 2);
        ActionExecutor.execute(player, { type: 'MOVE', target: gkTarget, sprint: false }, this.ball, this.eventBus);
        continue;
      }

      const target = this._getGkResetTarget(player, gkTeam);
      const dist = player.position.sub(target).length();
      const sf = dist > 16 ? 0.85 : dist > 8 ? 0.65 : 0.45;
      ActionExecutor.execute(player, { type: 'MOVE', target, sprint: false, speedFactor: sf }, this.ball, this.eventBus);
    }

    for (const p of allPlayers) PhysicsEngine.movePlayer(p, dt);
    Collision.resolvePlayerOverlap(allPlayers);
    Collision.clampPlayersToPitch(allPlayers);

    this.matchState.phaseTimer -= dt;
    if (this.matchState.phaseTimer <= 0) {
      this._executeGkDistribution(gk, gkTeam);
    }
  }

  /** GK 포지션 복귀 시 각 역할별 목표 X 위치를 반환한다 */
  _getGkResetTarget(player, gkTeam) {
    const isGkTeam = player.team === gkTeam;
    const attackDir = gkTeam.attackingDirection;
    const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
    const halfwayX = Pitch.LENGTH / 2;

    let targetX;
    if (isGkTeam) {
      // GK팀: 빌드업 대형 (전방으로 전개)
      switch (player.role) {
        case 'ST':  targetX = ownGoalX + attackDir * 58; break; // 하프라인 약간 위
        case 'LM':
        case 'RM':  targetX = ownGoalX + attackDir * 53; break; // 하프라인
        case 'CM':  targetX = ownGoalX + attackDir * 38; break; // 자기 진영 중앙
        default:    targetX = ownGoalX + attackDir * 25; break; // CB/LB/RB: 수비 3분의1
      }
    } else {
      // 상대팀: 수비 블록 구성 (뒤로 물러남)
      const theirOwnGoalX = attackDir === 1 ? Pitch.LENGTH : 0;
      const theirDir = -attackDir;
      switch (player.role) {
        case 'ST':  targetX = theirOwnGoalX + theirDir * 35; break; // 자기 진영 3분의1
        case 'LM':
        case 'RM':  targetX = theirOwnGoalX + theirDir * 47; break;
        case 'CM':  targetX = halfwayX;                       break; // 하프라인 부근
        default:    targetX = halfwayX + theirDir * 3;        break; // CB/LB/RB: 센터 선 부근
      }
    }

    const target = player.basePosition.clone();
    target.x = targetX;
    return Pitch.clampInside(target, 1.2);
  }

  /** GK가 공을 차는 시점: 단패스(35%)와 롱패스(65%)를 섞는다 */
  _executeGkDistribution(gk, gkTeam) {
    const opponentTeam = gkTeam === this.homeTeam ? this.awayTeam : this.homeTeam;
    const useShortPass = Math.random() < 0.35;
    let receiver = null;

    if (useShortPass) {
      let bestScore = -Infinity;
      for (const p of gkTeam.outfieldPlayers) {
        const dist = p.position.sub(gk.position).length();
        if (dist < 3 || dist > 28) continue;
        const pressure = opponentTeam.players.filter((o) => o.position.sub(p.position).length() < 4).length;
        const score = -pressure * 10 - dist * 0.05;
        if (score > bestScore) { bestScore = score; receiver = p; }
      }
    }

    if (!receiver) {
      receiver = this._chooseReceiver(gk, gkTeam, opponentTeam) ?? gkTeam.outfieldPlayers[0];
    }

    ActionExecutor.execute(
      gk,
      { type: 'PASS', targetPlayer: receiver, lofted: !useShortPass },
      this.ball,
      this.eventBus
    );
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
