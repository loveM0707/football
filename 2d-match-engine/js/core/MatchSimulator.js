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

    // 1.8m(선수 키) 이상이면 소유 불가. 0.8m~1.8m는 가슴/헤더 트래핑 가능 영역이므로
    // _setOwner에서 height와 verticalVelocity를 즉시 0으로 초기화해 발밑에 내려앉힌다.
    if (ball.height > 1.8) {
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
   * 9.15m 수비벽과 선수 재배치를 포함한 SET_PIECE_SETUP으로 진입한다.
   */
  _triggerFoul(defender, fouledAttacker) {
    const attackingTeam = fouledAttacker.team;
    const spot = Pitch.clampInside(this.ball.position, 1.2);

    this.ball.reset(spot);
    const taker = this._nearestPlayer(attackingTeam, spot, true);
    this._setOwner(taker);
    this.ball.position = spot.clone();

    const targets = this._computeFreeKickTargets(attackingTeam, spot);
    this.matchState.phase = Phase.SET_PIECE_SETUP;
    this.matchState.phaseTimer = 5.0;
    this.matchState.restartInfo = { type: 'FREE_KICK', team: attackingTeam, taker, spot, targets, preSetupTimer: 2.0, waitTimer: 1.5 };
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
      // 볼을 잡으면 잠깐 컨트롤(주위 살피기) → 곧바로 되받아 차는 탁구 패스 방지
      player.brainMemory.controlTimer = 0.35 + Math.random() * 0.35;
      player.brainMemory.possessionTimer = 0;
      player.brainMemory.decisionCooldown = 0;
      player.brainMemory.lastIntent = null;
      // 볼 소유 최소 보유 시간 (1.0~1.5s) — 매 소유마다 새로 뽑아 단조로움 방지
      player.brainMemory.tMin = 1.0 + Math.random() * 0.5;
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
    const spot = new Vector2D(x, y);
    this.ball.reset(spot.clone());
    const taker = this._nearestPlayer(team, this.ball.position, true);
    this._setOwner(taker);
    this.ball.position = spot.clone();

    const targets = this._computeThrowInTargets(team, taker, spot);
    this.matchState.phase = Phase.SET_PIECE_SETUP;
    this.matchState.phaseTimer = 5.0;
    this.matchState.restartInfo = { type: 'THROW_IN', team, taker, spot, targets, preSetupTimer: 2.0, waitTimer: 1.5 };
    this.eventBus.emit('restart', { type: 'THROW_IN', team });
  }

  /** 스로인 규정: 상대 선수는 공에서 2m 밖으로 물러나야 한다 */
  _enforceThrowInDistance() {
    const info = this.matchState.restartInfo;
    if (!info || info.type !== 'THROW_IN') return;
    const opponents = info.team === this.homeTeam ? this.awayTeam.players : this.homeTeam.players;
    const MIN_DIST = 2;
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
    this._setOwner(taker);
    this.ball.position = cornerPos.clone();

    const targets = this._computeCornerTargets(team, taker, isLeftGoal, y);
    this.matchState.phase = Phase.SET_PIECE_SETUP;
    this.matchState.phaseTimer = 5.0;
    this.matchState.restartInfo = { type: 'CORNER', team, taker, spot: cornerPos, targets, isLeftGoal, preSetupTimer: 2.0, waitTimer: 1.5 };
    this.eventBus.emit('restart', { type: 'CORNER', team });
  }

  _setupGoalKick(team, isLeftGoal) {
    const gx = isLeftGoal ? Pitch.GOAL_BOX_LENGTH : Pitch.LENGTH - Pitch.GOAL_BOX_LENGTH;
    const gy = Pitch.WIDTH / 2;
    const spot = new Vector2D(gx, gy);
    this.ball.reset(spot.clone());
    const gk = team.goalkeeper;
    this._setOwner(gk);
    this.ball.position = spot.clone();

    const targets = this._computeGoalKickTargets(team, gk, spot);
    this.matchState.phase = Phase.SET_PIECE_SETUP;
    this.matchState.phaseTimer = 5.0;
    this.matchState.restartInfo = { type: 'GOAL_KICK', team, taker: gk, spot, targets, preSetupTimer: 2.0, waitTimer: 1.5 };
    this.eventBus.emit('restart', { type: 'GOAL_KICK', team });
  }

  // ---------- 세트피스 배치 국면 ----------

  /**
   * 킥오프와 동일하게 전 선수를 목표 위치로 즉시(순간이동) 재배치한다.
   * GK는 목표 맵에 없으므로 자기 골문 앞으로 보낸다.
   */
  _applySetPieceTargets(targets, taker, spot) {
    const allPlayers = [...this.homeTeam.players, ...this.awayTeam.players];
    for (const p of allPlayers) {
      // 테이커는 호출부에서 이미 스팟·바라보는 방향까지 세팅했으므로 건드리지 않는다
      if (p === taker) continue;
      let target = null;
      if (p.role === 'GK') {
        const ownGoalX = p.team.attackingDirection === 1 ? 0 : Pitch.LENGTH;
        const outward = p.team.attackingDirection === 1 ? 1 : -1;
        target = new Vector2D(ownGoalX + outward * 1.8, Pitch.WIDTH / 2);
      } else {
        target = targets.get(p.id);
      }
      if (!target) continue;
      p.reset(Pitch.clampInside(target, 0.5));
    }
    Collision.resolvePlayerOverlap(allPlayers);
    Collision.clampPlayersToPitch(allPlayers);

    // 겹침 해소로 밀렸을 수 있으므로 테이커·공을 다시 스팟에 고정하고 소유권 복원
    taker.position = spot.clone();
    taker.velocity = Vector2D.zero();
    taker.desiredVelocity = Vector2D.zero();
    this._setOwner(taker);
    this.ball.position = spot.clone();
    this.ball.velocity = Vector2D.zero();
    this.ball.height = 0;
    this.ball.verticalVelocity = 0;
  }

  /**
   * SET_PIECE_SETUP: 2단계 경기 중단 연출
   *   Phase 1 (preSetupTimer > 0): 모든 선수가 현재 위치에서 정지 (심판 휘슬 연출)
   *   Phase 2 (preSetupTimer <= 0): 선수를 세트피스 포지션으로 순간이동 후 대기
   */
  _tickSetPieceSetup(dt) {
    const info = this.matchState.restartInfo;
    if (!info?.targets) {
      this.matchState.phase = Phase.IN_PLAY;
      return;
    }

    const allPlayers = [...this.homeTeam.players, ...this.awayTeam.players];

    // Phase 1: 현재 위치에서 정지 (preSetupTimer 카운트다운)
    if (info.preSetupTimer > 0) {
      for (const p of allPlayers) {
        p.velocity = Vector2D.zero();
        p.desiredVelocity = Vector2D.zero();
      }
      this.ball.position = info.spot.clone();
      this.ball.velocity = Vector2D.zero();
      info.preSetupTimer -= dt;

      if (info.preSetupTimer <= 0) {
        // 순간이동: 테이커를 스팟에 세우고 나머지를 목표 위치로 재배치
        const taker = info.taker;
        taker.position = info.spot.clone();
        taker.velocity = Vector2D.zero();
        taker.desiredVelocity = Vector2D.zero();

        // 테이커가 상대 골문 방향을 바라보도록 설정
        const oppGoalSide = taker.team.attackingDirection === 1 ? 'right' : 'left';
        const oppGoalCenter = Pitch.goalCenter(oppGoalSide);
        taker.facingAngle = oppGoalCenter.sub(taker.position).angle();
        taker.desiredFacingAngle = taker.facingAngle;

        this._setOwner(taker);
        this.ball.position = info.spot.clone();
        this._applySetPieceTargets(info.targets, taker, info.spot);

        if (info.type === 'THROW_IN') this._enforceThrowInDistance();
      }
      return;
    }

    // Phase 2: 재배치 완료 후 정지 대기 (waitTimer 카운트다운)
    for (const p of allPlayers) {
      p.velocity = Vector2D.zero();
      p.desiredVelocity = Vector2D.zero();
    }
    if (info.taker) info.taker.position = info.spot.clone();
    this.ball.position = info.spot.clone();
    this.ball.velocity = Vector2D.zero();

    info.waitTimer -= dt;
    if (info.waitTimer > 0) return;

    switch (info.type) {
      case 'THROW_IN':
        this.matchState.phase = Phase.THROW_IN;
        this.matchState.phaseTimer = 0.6;
        break;
      case 'CORNER':
        this.matchState.phase = Phase.CORNER_KICK;
        this.matchState.phaseTimer = 0.8;
        break;
      case 'GOAL_KICK':
        this.matchState.phase = Phase.GOAL_KICK;
        this.matchState.phaseTimer = 0.6;
        break;
      case 'FREE_KICK':
        this.matchState.phase = Phase.FREE_KICK;
        this.matchState.phaseTimer = 0.8;
        break;
      default:
        this.matchState.phase = Phase.IN_PLAY;
        this.matchState.restartInfo = null;
    }
  }

  /**
   * 스로인 배치: 볼 사이드 오버로드(Ball-side Overload) 전술
   *
   * - 2m 규정: 수비팀 모든 선수는 공에서 최소 2m 이격
   * - 볼 사이드 오버로드: 팀 전체 Y축 중심을 스로인 지점 방향으로 강하게 당긴다.
   *   공 반경 15m 이내에 양팀 합산 4~5명이 밀집하는 실제 경합 상황 연출.
   * - 수신자 3명(가장 가까운 팀원): 스팟 기준 필드 안쪽 부채꼴에 배치
   * - 수비 마크: 수신자에게 1:1 골 사이드 마킹 (공에서 2m 보장)
   * - 나머지: 스로인 Y 방향으로 50% 강도로 끌어당겨 볼 사이드 오버로드 형성
   */
  _computeThrowInTargets(team, taker, spot) {
    const targets = new Map();
    const opponentTeam = team === this.homeTeam ? this.awayTeam : this.homeTeam;
    const THROW_IN_MIN_OPP_DIST = 2;

    // 포메이션 형태를 유지하면서 spot 주변으로 압축 이동
    // base 의 중앙 기준 오프셋에 scaleX/Y 를 곱한 뒤 spot + offsetX 에 붙인다
    const shiftAndCompress = (p, scaleX, scaleY, offsetX = 0) => {
      const base = p.basePosition;
      const shiftX = (base.x - Pitch.LENGTH / 2) * scaleX;
      const shiftY = (base.y - Pitch.WIDTH  / 2) * scaleY;
      return new Vector2D(spot.x + shiftX + offsetX, spot.y + shiftY);
    };

    // 필드 중앙 방향(inward) + 터치라인 방향(along)
    const inward = Pitch.center().sub(spot).normalize();
    const along  = new Vector2D(-inward.y, inward.x);

    // ── 공격팀: 수신자 3명 부채꼴 배치 + 나머지 Shift & Compress ──
    const RECEIVER_COUNT = 3;
    const RECV_ANGLES = [0, Math.PI / 3, -Math.PI / 3];
    const RECV_DISTS  = [5, 6, 7];

    const attackers = [...team.outfieldPlayers.filter((p) => p !== taker)]
      .sort((a, b) => a.position.sub(spot).length() - b.position.sub(spot).length());

    const receiverTargets = [];
    attackers.forEach((p, i) => {
      let target;
      if (i < RECEIVER_COUNT) {
        const ang       = RECV_ANGLES[i];
        const radialDir = inward.scale(Math.cos(ang)).add(along.scale(Math.sin(ang)));
        target = Pitch.clampInside(spot.add(radialDir.scale(RECV_DISTS[i])), 0.5);
        receiverTargets.push(target);
      } else {
        target = Pitch.clampInside(shiftAndCompress(p, 0.35, 0.40), 1.2);
      }
      targets.set(p.id, target);
    });

    // ── 수비팀: 수신자 3명 골사이드 마킹 + 나머지 Compress + 6m 후퇴 ─
    const defDir     = opponentTeam.attackingDirection;
    const ownGoalPos = Pitch.goalCenter(defDir === 1 ? 'right' : 'left');
    const defenders  = [...opponentTeam.outfieldPlayers]
      .sort((a, b) => a.position.sub(spot).length() - b.position.sub(spot).length());

    defenders.forEach((p, i) => {
      let target;
      if (i < receiverTargets.length) {
        const recv   = receiverTargets[i];
        const toGoal = ownGoalPos.sub(recv).normalize();
        target = recv.add(toGoal.scale(1.5));
      } else {
        // X 30%, Y 40% 압축 + 자기 골문 방향 6m 후퇴
        target = shiftAndCompress(p, 0.30, 0.40, -defDir * 6);
      }
      // 2m 규정 강제 적용
      const toSpot = target.sub(spot);
      if (toSpot.length() < THROW_IN_MIN_OPP_DIST) {
        const dir = toSpot.length() > 1e-6 ? toSpot.normalize() : inward;
        target = spot.add(dir.scale(THROW_IN_MIN_OPP_DIST));
      }
      targets.set(p.id, Pitch.clampInside(target, 1.0));
    });

    return targets;
  }

  /**
   * 골킥 배치: 현대 축구 빌드업 대형
   *
   * 공격팀(킥하는 팀):
   *   - CB: 페널티 박스 내 골 에어리어 측면으로 깊숙이 내려와 빌드업 기점 역할
   *   - LB/RB: 터치라인 양 끝으로 크게 벌려 전진 (넓이 확보)
   *   - 나머지: 기본 포지션 유지
   *
   * 수비팀:
   *   - 규정상 골킥 처리 전 페널티 박스 밖에 있어야 함
   *   - 박스 내 포진 선수는 박스 경계 바깥으로 강제 이격
   *   - Y축을 중앙으로 좁혀 대기
   */
  _computeGoalKickTargets(team, taker, spot) {
    const targets = new Map();
    const opponentTeam = team === this.homeTeam ? this.awayTeam : this.homeTeam;
    const attackDir = team.attackingDirection;
    const ownGoalX = attackDir === 1 ? 0 : Pitch.LENGTH;
    const penBoxEdgeX = ownGoalX + attackDir * Pitch.PENALTY_BOX_LENGTH;
    const centerY = Pitch.WIDTH / 2;

    // 공격팀: 현대 빌드업 대형
    for (const p of team.outfieldPlayers) {
      let target;
      switch (p.role) {
        case 'CB': {
          // 골 에어리어 측면으로 내려와 GK 빌드업 옵션 제공
          const cbYOffset = p.basePosition.y < centerY ? -8 : 8;
          const cbY = Math.max(2, Math.min(Pitch.WIDTH - 2, centerY + cbYOffset));
          target = new Vector2D(ownGoalX + attackDir * (Pitch.GOAL_BOX_LENGTH + 3), cbY);
          break;
        }
        case 'LB':
          // 좌측 터치라인 쪽으로 넓게 벌리고 전진
          target = new Vector2D(ownGoalX + attackDir * 28, Math.max(1.5, Pitch.WIDTH * 0.07));
          break;
        case 'RB':
          // 우측 터치라인 쪽으로 넓게 벌리고 전진
          target = new Vector2D(ownGoalX + attackDir * 28, Math.min(Pitch.WIDTH - 1.5, Pitch.WIDTH * 0.93));
          break;
        default:
          target = p.basePosition.clone();
      }
      targets.set(p.id, Pitch.clampInside(target, 1.0));
    }

    // 수비팀: 역할별 포지셔닝 (페널티 박스 밖 강제)
    const oppDir = opponentTeam.attackingDirection;
    const oppHalfX = Pitch.LENGTH / 2;
    for (const p of opponentTeam.outfieldPlayers) {
      let target;
      switch (p.role) {
        case 'ST':
          // 스트라이커: 페널티 박스 경계선 앞에서 빌드업 압박
          target = new Vector2D(penBoxEdgeX + attackDir * 3, centerY + (p.basePosition.y < centerY ? -5 : 5));
          break;
        case 'CM':
        case 'LM':
        case 'RM':
          // 미드필더: 하프라인과 페널티 박스 사이 중간
          target = new Vector2D(
            penBoxEdgeX + attackDir * ((Pitch.LENGTH / 2 - Math.abs(penBoxEdgeX)) * 0.4 + 5),
            p.basePosition.y
          );
          break;
        default:
          // CB/LB/RB: 하프라인 부근 대기
          target = new Vector2D(oppHalfX + oppDir * 3, p.basePosition.y);
      }
      // 페널티 박스 내부면 강제 이격
      const insideBoxX = attackDir === 1 ? target.x < penBoxEdgeX : target.x > penBoxEdgeX;
      const insideBoxY = target.y >= centerY - Pitch.PENALTY_BOX_WIDTH / 2 &&
                         target.y <= centerY + Pitch.PENALTY_BOX_WIDTH / 2;
      if (insideBoxX && insideBoxY) {
        target = new Vector2D(penBoxEdgeX + attackDir * 2, target.y);
      }
      targets.set(p.id, Pitch.clampInside(target, 1.0));
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
    const intoField = isLeftGoal ? 1 : -1;
    const [goalTop, goalBottom] = Pitch.goalYRange();
    const centerY = Pitch.WIDTH / 2;
    const penEdgeX = goalX + intoField * Pitch.PENALTY_BOX_LENGTH;
    const boxTop    = centerY - Pitch.PENALTY_BOX_WIDTH / 2 + 1.5;
    const boxBottom = centerY + Pitch.PENALTY_BOX_WIDTH / 2 - 1.5;

    // === 공격팀: 무작위 그리드 스팟 배정 ===
    // 3열(골 거리) × 4행(Y축) = 12개 그리드 생성 후 셔플
    const gridSpots = [];
    for (const dDist of [5, 9, 13]) {
      for (const dY of [-9, -3, 3, 9]) {
        const sx = goalX + intoField * dDist;
        const sy = Math.max(boxTop, Math.min(boxBottom, centerY + dY));
        gridSpots.push(new Vector2D(sx, sy));
      }
    }
    for (let i = gridSpots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [gridSpots[i], gridSpots[j]] = [gridSpots[j], gridSpots[i]];
    }

    // 헤더 우선순위: CB > ST > CM, 최대 4명 박스 안 그리드 배정
    const HEADER_ROLES = ['CB', 'ST', 'CM'];
    const atkOutfield = [...team.outfieldPlayers]
      .filter(p => p !== taker)
      .sort((a, b) => {
        const ai = HEADER_ROLES.indexOf(a.role);
        const bi = HEADER_ROLES.indexOf(b.role);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });

    let gridIdx = 0;
    const boxHeaderIds = new Set();

    for (const p of atkOutfield) {
      if (gridIdx < 4 && HEADER_ROLES.includes(p.role)) {
        targets.set(p.id, Pitch.clampInside(gridSpots[gridIdx++], 0.5));
        boxHeaderIds.add(p.id);
      } else if (p.role === 'LM' || p.role === 'RM') {
        // 윙어: 박스 측면 외곽 (컷백/리바운드 대비)
        const edgeY = p.role === 'LM'
          ? Math.max(1.5, centerY - Pitch.PENALTY_BOX_WIDTH / 2 - 2)
          : Math.min(Pitch.WIDTH - 1.5, centerY + Pitch.PENALTY_BOX_WIDTH / 2 + 2);
        targets.set(p.id, Pitch.clampInside(new Vector2D(penEdgeX - intoField * 4, edgeY), 0.5));
      } else if (p.role === 'LB' || p.role === 'RB') {
        // 풀백: 하프라인 부근에서 카운터 방어 대기
        const halfX = Pitch.LENGTH / 2;
        const edgeY = p.role === 'LB'
          ? Math.max(3, Pitch.WIDTH * 0.2)
          : Math.min(Pitch.WIDTH - 3, Pitch.WIDTH * 0.8);
        targets.set(p.id, Pitch.clampInside(new Vector2D(halfX + intoField * -5, edgeY), 0.5));
      } else {
        // 기타: 페널티 박스 외곽 엣지 (리바운드)
        targets.set(p.id, Pitch.clampInside(new Vector2D(penEdgeX, p.basePosition.y), 0.5));
      }
    }

    // === 수비팀: 지역 방어 + 대인 마크 혼합 ===
    // 존 스팟: 니어포스트, 파포스트, 6야드박스 좌우, 페널티 스팟 앞
    const zoneSpots = [
      new Vector2D(goalX + intoField * 1.2, goalTop  + 0.5),
      new Vector2D(goalX + intoField * 1.2, goalBottom - 0.5),
      new Vector2D(goalX + intoField * 6,   centerY - 2),
      new Vector2D(goalX + intoField * 6,   centerY + 2),
      new Vector2D(goalX + intoField * 11,  centerY),
    ];

    // 박스 내 공격 위협 목록 (대인마크 대상)
    const boxThreats = atkOutfield.filter(p => boxHeaderIds.has(p.id));

    // 수비 배치 우선순위: LB/RB(포스트) → CB(6야드존) → CM/LM/RM(마크) → ST(카운터)
    const DEF_ORDER = ['LB', 'RB', 'CB', 'CM', 'LM', 'RM', 'ST'];
    const defOutfield = [...opponentTeam.outfieldPlayers]
      .sort((a, b) => {
        const ai = DEF_ORDER.indexOf(a.role);
        const bi = DEF_ORDER.indexOf(b.role);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });

    let zoneIdx = 0;
    let manIdx  = 0;
    let counterCount = 0;

    for (const p of defOutfield) {
      if (p.role === 'ST' && counterCount < 1) {
        // 공격수 1명: 하프라인 카운터 대기
        targets.set(p.id, new Vector2D(Pitch.LENGTH / 2, p.basePosition.y));
        counterCount++;
      } else if (zoneIdx < zoneSpots.length) {
        // 존 수비: 포스트 및 박스 내 고정 스팟
        targets.set(p.id, Pitch.clampInside(zoneSpots[zoneIdx++], 0.5));
      } else if (manIdx < boxThreats.length) {
        // 밀착 대인 마크: 공격수와 골 사이 0.9m — 헤더 경합 차단
        const threat = boxThreats[manIdx++];
        const threatPos = targets.get(threat.id);
        if (threatPos) {
          const toGoalCenter = new Vector2D(goalX, centerY).sub(threatPos);
          const d = toGoalCenter.length();
          const TIGHT_MARK = 0.9;
          const offset = d > 0.1
            ? toGoalCenter.normalize().scale(TIGHT_MARK)
            : new Vector2D(intoField * -TIGHT_MARK, 0);
          targets.set(p.id, Pitch.clampInside(threatPos.add(offset), 0.5));
        } else {
          targets.set(p.id, Pitch.clampInside(new Vector2D(goalX + intoField * 10, p.basePosition.y), 0.5));
        }
      } else {
        // 나머지: 페널티 박스 내부 밀집 (리바운드/세컨볼 차단)
        targets.set(p.id, Pitch.clampInside(
          new Vector2D(penEdgeX - intoField * 3, p.basePosition.y), 0.5
        ));
      }
    }

    // 9.15m 규정: 수비팀 선수가 코너 아크에서 9.15m 미만이면 밀어낸다
    const cornerArc = new Vector2D(cx, cy);
    const MIN_CORNER_DIST = Pitch.CENTER_CIRCLE_RADIUS; // 9.15m
    for (const p of defOutfield) {
      const t = targets.get(p.id);
      if (!t) continue;
      const distFromCorner = t.sub(cornerArc).length();
      if (distFromCorner < MIN_CORNER_DIST) {
        const awayDir = distFromCorner > 1e-6
          ? t.sub(cornerArc).normalize()
          : new Vector2D(intoField, 0);
        targets.set(p.id, Pitch.clampInside(cornerArc.add(awayDir.scale(MIN_CORNER_DIST)), 0.5));
      }
    }

    return targets;
  }

  /**
   * 프리킥 선수 배치 — 전술보드와 동일한 현실적 배치
   *
   * 수비팀: 9.15m 수비벽(2~5명) + 수비 라인(페널티 박스 선) + 나머지 커버
   * 공격팀: 키커 주변 패싱 옵션 + 박스 내 위협 + 후방 카운터 방어
   */
  _computeFreeKickTargets(attackingTeam, spot) {
    const targets = new Map();
    const defendingTeam = attackingTeam === this.homeTeam ? this.awayTeam : this.homeTeam;
    const atkDir = attackingTeam.attackingDirection;
    const defDir = defendingTeam.attackingDirection;
    const WALL_DIST = Pitch.CENTER_CIRCLE_RADIUS; // 9.15m
    const centerY = Pitch.WIDTH / 2;

    // 수비팀 골문 방향
    const defOwnGoal = Pitch.goalCenter(defDir === 1 ? 'left' : 'right');
    const toGoal = defOwnGoal.sub(spot);
    const distToGoal = toGoal.length();
    const goalDir = distToGoal > 1e-3 ? toGoal.normalize() : new Vector2D(atkDir, 0);
    const perpDir = new Vector2D(-goalDir.y, goalDir.x);

    // 프리킥 위치 분류: 자기 진영 / 중앙 / 위험 거리
    const isDangerous = distToGoal < 35;
    const defGoalX = defOwnGoal.x;
    const penLineX = defGoalX === 0 ? Pitch.PENALTY_BOX_LENGTH : Pitch.LENGTH - Pitch.PENALTY_BOX_LENGTH;
    const atkOwnGoalX = atkDir === 1 ? 0 : Pitch.LENGTH;
    const halfX = Pitch.LENGTH / 2;

    // 수비팀 페널티 박스 경계 X (너무 깊이 물러나지 않도록 제한)
    const defPenLimitX = defGoalX === 0
      ? Pitch.PENALTY_BOX_LENGTH + 2      // 좌골문 팀: 이 값 이상으로 유지
      : Pitch.LENGTH - Pitch.PENALTY_BOX_LENGTH - 2; // 우골문 팀: 이 값 이하로 유지

    // ── 수비팀 배치 ──
    if (!isDangerous) {
      // 먼 거리: 3선 미드 블록 (공 기준 동적 X + Y 압축)
      //
      // 핵심 방향 수학:
      //   defDir = 수비팀 공격 방향 = -atkDir
      //   수비팀 자기 골문 방향 = atkDir (= -defDir)
      //   따라서 towardDefGoal = atkDir 이 올바른 후퇴 방향이다.
      const towardDefGoal = atkDir;

      // 3선 수비 라인 X (페널티 박스 안쪽 클램프)
      const defLineRaw = spot.x + towardDefGoal * 28;
      const defLineX = defGoalX === 0
        ? Math.max(defLineRaw, Pitch.PENALTY_BOX_LENGTH + 2)
        : Math.min(defLineRaw, Pitch.LENGTH - Pitch.PENALTY_BOX_LENGTH - 2);

      for (const p of defendingTeam.outfieldPlayers) {
        // Y 압축: 중앙으로 60% 좁혀 블록 밀집
        const compactY = centerY + (p.basePosition.y - centerY) * 0.6;
        let targetX;
        switch (p.role) {
          case 'ST':
            targetX = spot.x + towardDefGoal * 10; // 1차 저지선
            break;
          case 'CM':
          case 'LM':
          case 'RM':
            targetX = spot.x + towardDefGoal * 18; // 2선 미드필드 라인
            break;
          default: // CB, LB, RB
            targetX = defLineX;                     // 3선 일자 수비 라인
        }
        let target = new Vector2D(targetX, compactY);
        if (target.sub(spot).length() < WALL_DIST) {
          const dir = target.sub(spot).length() > 1e-6 ? target.sub(spot).normalize() : goalDir;
          target = spot.add(dir.scale(WALL_DIST + 0.5));
        }
        targets.set(p.id, Pitch.clampInside(target, 1.0));
      }
    } else {
      // 위험 거리: 수비벽 + 조직적 수비 라인
      const wallCount = distToGoal < 18 ? 5 : distToGoal < 25 ? 4 : distToGoal < 30 ? 3 : 2;
      const wallCenter = spot.add(goalDir.scale(WALL_DIST));

      // 벽에 넣을 선수: 공에 가까운 순 (CM/LM/RM 우선, CB는 수비 라인 유지)
      const DEF_WALL_PRIORITY = ['CM', 'LM', 'RM', 'ST', 'LB', 'RB', 'CB'];
      const defOutfield = [...defendingTeam.outfieldPlayers].sort((a, b) => {
        const ai = DEF_WALL_PRIORITY.indexOf(a.role);
        const bi = DEF_WALL_PRIORITY.indexOf(b.role);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });

      const wallPlayers = defOutfield.slice(0, wallCount);
      const nonWallDef = defOutfield.slice(wallCount);

      // 벽 배치 (0.6m 간격, 어깨 맞대기)
      wallPlayers.forEach((p, i) => {
        const offset = (i - (wallCount - 1) / 2) * 0.6;
        targets.set(p.id, Pitch.clampInside(wallCenter.add(perpDir.scale(offset)), 0.5));
      });

      // 나머지 수비수: CB/LB/RB는 수비 라인, MF/ST는 볼과 수비 라인 사이
      nonWallDef.forEach((p) => {
        let target;
        if (p.role === 'CB' || p.role === 'LB' || p.role === 'RB') {
          // 수비 라인: 페널티 박스 경계를 따라 Y축으로 펼쳐서 배치
          const spreadY = p.basePosition.y;
          target = new Vector2D(penLineX, Math.max(4, Math.min(Pitch.WIDTH - 4, spreadY)));
        } else if (p.role === 'ST') {
          // 공격수: 하프라인 부근에서 카운터 대기
          target = new Vector2D(halfX + defDir * 5, p.basePosition.y);
        } else {
          // 미드필더: 벽과 수비 라인 사이 중간에서 커버
          const midX = (wallCenter.x + penLineX) / 2;
          target = new Vector2D(midX, Math.max(5, Math.min(Pitch.WIDTH - 5, p.basePosition.y)));
        }
        // 9.15m 규정
        if (target.sub(spot).length() < WALL_DIST) {
          const dir = target.sub(spot).length() > 1e-6 ? target.sub(spot).normalize() : goalDir;
          target = spot.add(dir.scale(WALL_DIST + 0.5));
        }
        targets.set(p.id, Pitch.clampInside(target, 0.5));
      });
    }

    // ── 공격팀 배치 ──
    if (!isDangerous) {
      // 먼 거리: 4-2-4 빌드업 대형
      // towardDefGoal = atkDir: 전진 방향 = 수비팀 자기 골문 방향
      const towardDefGoal = atkDir;
      // 상대 3선 수비 라인 참조 좌표 (공격팀 전방 선수 핀(Pin) 위치 계산용)
      const defLineRaw = spot.x + towardDefGoal * 28;
      const defLineX = defGoalX === 0
        ? Math.max(defLineRaw, Pitch.PENALTY_BOX_LENGTH + 2)
        : Math.min(defLineRaw, Pitch.LENGTH - Pitch.PENALTY_BOX_LENGTH - 2);

      for (const p of attackingTeam.outfieldPlayers) {
        let target;
        switch (p.role) {
          case 'CB': {
            // 후방 빌드업 기점: 공 뒤 5m, 좌우 12m 넓게
            const cbYOff = p.basePosition.y < centerY ? -12 : 12;
            target = new Vector2D(spot.x - towardDefGoal * 5, centerY + cbYOff);
            break;
          }
          case 'LB':
            // 전진 + 좌측 터치라인 최대 폭
            target = new Vector2D(spot.x + towardDefGoal * 10, 4);
            break;
          case 'RB':
            // 전진 + 우측 터치라인 최대 폭
            target = new Vector2D(spot.x + towardDefGoal * 10, Pitch.WIDTH - 4);
            break;
          case 'CM':
            // 공 살짝 뒤에서 짧은 패스 대기
            target = new Vector2D(spot.x - towardDefGoal * 2, p.basePosition.y);
            break;
          default: { // ST, LM, RM
            // 상대 3선 수비 라인 바로 앞 핀(Pin) — 수비 라인을 뒤로 밀어냄
            target = new Vector2D(defLineX - towardDefGoal * 1.5, p.basePosition.y);
            break;
          }
        }
        if (target.sub(spot).length() < WALL_DIST) {
          const dir = target.sub(spot).length() > 1e-6 ? target.sub(spot).normalize() : new Vector2D(-atkDir, 0);
          target = spot.add(dir.scale(WALL_DIST + 0.5));
        }
        targets.set(p.id, Pitch.clampInside(target, 1.0));
      }
    } else {
      // 위험 거리: 역할별 전술적 배치
      for (const p of attackingTeam.outfieldPlayers) {
        let target;
        switch (p.role) {
          case 'ST': {
            // 스트라이커: 수비 라인 근처에서 골문 노리기 (오프사이드 경계)
            const stY = centerY + (p.basePosition.y < centerY ? -5 : 5);
            target = new Vector2D(penLineX - atkDir * 1, stY);
            break;
          }
          case 'CM': {
            // 중앙 미드필더: 페널티 박스 경계 외곽에서 세컨볼/패싱 옵션
            const cmY = centerY + (p.basePosition.y < centerY ? -10 : 10);
            target = new Vector2D(penLineX - atkDir * 4, cmY);
            break;
          }
          case 'LM':
          case 'RM': {
            // 윙어: 터치라인 쪽 넓게 벌려서 크로스/패싱 옵션
            const wideY = p.role === 'LM'
              ? Math.max(3, Pitch.WIDTH * 0.1)
              : Math.min(Pitch.WIDTH - 3, Pitch.WIDTH * 0.9);
            target = new Vector2D(spot.x + atkDir * 8, wideY);
            break;
          }
          case 'CB': {
            // 센터백: 볼 뒤쪽에서 세컨볼 대비 + 카운터 방어
            const cbX = spot.x - atkDir * 15;
            target = new Vector2D(cbX, p.basePosition.y);
            break;
          }
          case 'LB':
          case 'RB': {
            // 풀백: 자기 진영에서 카운터 방어
            const fbY = p.role === 'LB'
              ? Math.max(4, Pitch.WIDTH * 0.15)
              : Math.min(Pitch.WIDTH - 4, Pitch.WIDTH * 0.85);
            target = new Vector2D(spot.x - atkDir * 20, fbY);
            break;
          }
          default: {
            target = new Vector2D(spot.x + atkDir * 5, p.basePosition.y);
          }
        }
        // 9.15m 규정
        if (target.sub(spot).length() < WALL_DIST) {
          const dir = target.sub(spot).length() > 1e-6 ? target.sub(spot).normalize() : new Vector2D(-atkDir, 0);
          target = spot.add(dir.scale(WALL_DIST + 0.5));
        }
        targets.set(p.id, Pitch.clampInside(target, 1.0));
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

    // SET_PIECE_SETUP에서 이미 순간 재배치가 끝난 세트피스는 배치를 그대로 유지한다
    const preplaced = !isKickoff ? this.matchState.restartInfo.targets : null;
    if (preplaced) {
      const spot = this.matchState.restartInfo.spot;
      for (const p of allPlayers) {
        p.velocity = Vector2D.zero();
        p.desiredVelocity = Vector2D.zero();
      }
      if (spot) {
        taker.position = spot.clone();
        this.ball.position = spot.clone();
        this.ball.velocity = Vector2D.zero();
      }
      this.matchState.phaseTimer -= dt;
      if (this.matchState.phaseTimer <= 0) this._executeSetPieceRestart();
      return;
    }

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

    // 스로인: 공과 스로어를 터치라인 위 지점에 고정(드리블 불가), 상대는 2m 밖으로
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
    } else if (info.type === 'THROW_IN') {
      // 스로인: 80% 근거리(스팟 5m 이내 대기 중인 수신자), 20% 원거리
      const NEAR_RADIUS = 5;
      const mates = team.outfieldPlayers.filter((p) => p !== taker);
      const near = mates.filter((p) => p.position.sub(taker.position).length() <= NEAR_RADIUS);
      const far = mates.filter((p) => p.position.sub(taker.position).length() > NEAR_RADIUS);
      const wantNear = Math.random() < 0.8;
      let pool = wantNear ? near : far;
      if (pool.length === 0) pool = near.length > 0 ? near : far;

      // 후보 중 상대 압박이 가장 적은 선수 선택
      let bestScore = -Infinity;
      for (const p of pool) {
        const pressure = opponentTeam.players.filter(
          (o) => o.position.sub(p.position).length() < 4
        ).length;
        const forward = (p.position.x - taker.position.x) * team.attackingDirection;
        const score = -pressure * 10 + forward * 0.4;
        if (score > bestScore) { bestScore = score; receiver = p; }
      }
      if (!receiver) receiver = this._chooseReceiver(taker, team, opponentTeam) ?? mates[0];
      lofted = receiver.position.sub(taker.position).length() > 18;
    } else if (info.type === 'CORNER') {
      receiver = this._chooseReceiver(taker, team, opponentTeam) ?? team.players.find((p) => p !== taker);
      lofted = true;
    } else if (info.type === 'FREE_KICK') {
      // 프리킥: 25m 이내에서 30% 직접 슛, 나머지는 패스
      const defGoal = Pitch.goalCenter(opponentTeam.attackingDirection === 1 ? 'left' : 'right');
      const distFK = taker.position.sub(defGoal).length();
      if (distFK < 25 && Math.random() < 0.30) {
        ActionExecutor.execute(taker, { type: 'SHOOT' }, this.ball, this.eventBus);
        this.matchState.phase = Phase.IN_PLAY;
        this.matchState.restartInfo = null;
        return;
      }
      receiver = this._chooseReceiver(taker, team, opponentTeam) ?? team.players.find((p) => p !== taker);
      lofted = distFK < 30;
    } else {
      receiver = this._chooseReceiver(taker, team, opponentTeam) ?? team.players.find((p) => p !== taker);
      lofted = false;
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
