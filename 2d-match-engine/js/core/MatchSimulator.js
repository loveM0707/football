import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';
import { Ball } from '../entities/Ball.js';
import { MatchState, Phase } from './MatchState.js';
import { ActionExecutor } from './ActionExecutor.js';
import { PhysicsEngine } from '../physics/PhysicsEngine.js';
import { Collision } from '../physics/Collision.js';
import { DuelResolver } from '../ai/DuelResolver.js';
import { decidePlayerIntent, decideHeaderIntent } from '../ai/PlayerBrain.js';
import { computeSupportPosition } from '../ai/OffTheBallMovement.js';
import { updateTeamTempo } from '../ai/TeamTempo.js';

/** 크로스바 높이(m) — 이보다 높이 골라인을 넘으면 골이 아니라 골킥 */
const CROSSBAR_HEIGHT = 2.44;
/** 골대(포스트/크로스바) 두께 판정 여유(m) */
const WOODWORK_MARGIN = 0.34;

/**
 * 오프사이드 판정 헬퍼
 * @returns {boolean} true = 오프사이드 반칙
 */
function checkOffside(player, ball, allPlayers) {
  const team = player.team;
  let opponentTeam = null;
  if (allPlayers.length > 0 && allPlayers[0].team) {
    const firstTeam = allPlayers[0].team;
    if (team !== firstTeam) {
      opponentTeam = firstTeam;
    } else {
      const other = allPlayers.find(p => p.team !== team);
      opponentTeam = other ? other.team : null;
    }
  }
  if (!opponentTeam) return false;
  
  const attackDir = team.attackingDirection;
  // 골키퍼 포함 모든 상대 선수 (오프사이드 기준: 상대 골문 방향에서 2번째로 뒤에 있는 상대)
  const oppPlayers = allPlayers.filter(p => p.team === opponentTeam);
  if (oppPlayers.length < 2) return false;
  
  // 상대 골문 방향의 두 번째로 가까운 상대(골키퍼 포함) 찾기
  const oppXs = oppPlayers.map(p => p.position.x).sort((a, b) => attackDir === 1 ? b - a : a - b);
  const secondLastOppX = oppXs[1];
  
  // 공격수가 상대 골문 방향에 있고, 공보다 앞서 있고, 두 번째 마지막 상대보다 앞서 있으면 오프사이드
  const isInOppHalf = attackDir === 1
    ? player.position.x > Pitch.LENGTH / 2
    : player.position.x < Pitch.LENGTH / 2;
  
  const aheadOfBall = attackDir === 1
    ? player.position.x > ball.position.x
    : player.position.x < ball.position.x;
  
  // 부동소수점 정밀도 문제로 동일 선상인데 오프사이드 판정되는 것 방지 (1cm 허용오차)
  const EPSILON = 0.01;
  const aheadOfSecondLast = attackDir === 1
    ? player.position.x > secondLastOppX + EPSILON
    : player.position.x < secondLastOppX - EPSILON;
  
  return isInOppHalf && aheadOfBall && aheadOfSecondLast;
}

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
    // 0.02s(=50Hz) 이하로 잘게 쪼갠다. 0.12s 서브스텝은 20m/s 슛이 한 스텝에
    // 2.4m를 이동해 BALL_CONTROL_RADIUS(1.15m)를 그대로 통과했고, 그 결과
    // 배속(2x~8x)에서 패스 수신·선방 판정이 누락되어 1배속과 경기 양상이
    // 달라졌다. 스텝을 고정해 재생 속도와 무관하게 동일한 경기가 되게 한다.
    const MAX_STEP = 0.02;
    let remaining = dt;
    while (remaining > 1e-6) {
      const step = Math.min(MAX_STEP, remaining);
      this._tickOnce(step);
      remaining -= step;
    }
  }

  _tickOnce(dt) {
    try {
      this.matchState.advanceClock(dt);

      // 펀칭 직후 비상 후퇴 타이머 — 경기 국면과 무관하게 흘러야 한다
      for (const t of [this.homeTeam, this.awayTeam]) {
        if ((t.emergencyDropTimer ?? 0) > 0) {
          t.emergencyDropTimer = Math.max(0, t.emergencyDropTimer - dt);
        }
      }

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
    } catch (e) {
      console.error('MatchSimulator tick error:', e);
      // 치명적 에러 시에도 경기 강제 진행
      if (this.matchState.phase !== Phase.IN_PLAY) {
        this.matchState.phase = Phase.IN_PLAY;
        this.matchState.restartInfo = null;
      }
    }
  }

  // ---------- 정상 플레이 ----------

  _tickInPlay(dt) {
    const allPlayers = [...this.homeTeam.players, ...this.awayTeam.players];
    this._tickContestTimers(allPlayers, dt);

    // 완급 조절: 의사결정 전에 팀 국면(빌드업/탐색/역습/파이널서드)을 갱신한다
    updateTeamTempo(this.homeTeam, this.awayTeam, this.ball, dt);
    updateTeamTempo(this.awayTeam, this.homeTeam, this.ball, dt);

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

      // 오프사이드는 "패스가 발을 떠나는 순간"의 위치로 판정한다(수신 시점 아님).
      // 실제 축구 규칙과 동일하게, 패스 시점에 온사이드였던 선수가 상대 수비
      // 라인보다 앞서 침투해 받는 것은 합법이다. 패스가 실행된 이 시점(선수
      // 위치가 아직 이번 틱 물리 이동 전)에 오프사이드 여부를 미리 판정해
      // 스냅샷으로 저장해 두고, 수신 시점에는 이 값을 그대로 사용한다.
      if ((intent.type === 'PASS' || intent.type === 'HEAD_PASS') && this.ball.passTargetPlayer) {
        this.ball.receiverOffsideAtKick = checkOffside(this.ball.passTargetPlayer, this.ball, allPlayers);
      }
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
    const ball = this.ball;
    if (!ball.isShot || ball.gkBeaten) return false;
    for (const team of [this.homeTeam, this.awayTeam]) {
      const gk = team.goalkeeper;
      if (gk === ball.owner) continue;
      const dist = gk.position.sub(ball.position).length();
      if (dist < 2.2) {
        // 뚫렸으면(BEATEN) 소유권을 넘기지 않고 공이 그대로 지나간다
        return this._attemptGkSave(gk) !== 'BEATEN';
      }
    }
    return false;
  }

  /**
   * 골키퍼 선방 판정 — 잡기(HELD) / 쳐내기(PARRIED) / 뚫림(BEATEN).
   *
   * 기존에는 슛이 골키퍼 반경 안에 들어오면 100% 저지되어 유효 슈팅이
   * 거의 득점으로 이어지지 않았다. 슛 속도·높이와 반사신경으로 선방 확률을
   * 산출하고, 실패하면 공이 그대로 지나가 골로 연결되게 한다.
   */
  _attemptGkSave(gk) {
    const ball = this.ball;
    const speed = ball.velocity.length();
    const reflexes = gk.attributes.reflexes ?? 65;

    // 빠른 슛(15m/s 초과)일수록, 높은 슛일수록 막기 어렵다
    const speedPenalty = Math.max(0.58, Math.min(1, 1 - (speed - 15) * 0.017));
    const heightPenalty = ball.height > 1.2 ? 0.86 : 1;
    let saveChance = Math.max(
      0.28,
      Math.min(0.88, (reflexes / 100) * 1.00 * speedPenalty * heightPenalty)
    );

    // ── 약한 슛 하한선 ────────────────────────────────────────────
    // 느린 슛은 골키퍼가 제자리에서 받아낼 수 있어야 한다. 속도 18m/s 아래부터
    // 선방 확률에 하한을 두고, 10m/s 이하의 힘없는 슛은 사실상 전부 막는다.
    // (이 하한이 없으면 툭 찬 공도 반사신경 확률로 뚫려 실점한다)
    if (speed < 18) {
      const weakFloor = 0.72 + Math.max(0, (18 - speed) / 8) * 0.26; // 0.72 → 0.98
      saveChance = Math.max(saveChance, Math.min(0.98, weakFloor));
    }

    const roll = Math.random();
    if (roll < saveChance * 0.45) {
      // 캐치 — 공을 잡아 소유
      this._setOwner(gk);
      ball.position = gk.position.clone();
      this.eventBus.emit('save', { team: gk.team, gk, held: true });
      if (this.matchState.phase === Phase.IN_PLAY) this._setupGkPossession(gk);
      return 'HELD';
    }
    if (roll < saveChance) {
      // ── 펀칭/쳐내기 ──────────────────────────────────────────────
      // 골키퍼는 위험 지역(골문 정면)으로 흘리지 않고 밖으로 걷어낸다.
      //   ① 골대 위로 넘겨 쳐내기(55%) — 골라인 밖으로 나가 코너킥
      //   ② 골대 옆(측면)으로 강하게 쳐내기(45%) — 측면 아웃 또는 세컨볼
      // lastTouchedTeam = 수비팀이므로 골라인 아웃 시 코너킥으로 판정된다.
      const ownGoalSide = gk.team.attackingDirection === 1 ? 'left' : 'right';
      const goalCenter = Pitch.goalCenter(ownGoalSide);
      const outward = ownGoalSide === 'left' ? -1 : 1; // 골라인 바깥 방향

      if (Math.random() < 0.55) {
        // ① 크로스바 위로 넘겨 쳐내기 — 높이 띄워 골라인 밖으로 보낸다.
        //    _checkBoundaries가 "크로스바 초과 + 골라인 통과"를 코너킥으로 처리한다.
        const lateral = (Math.random() - 0.5) * 3.0;
        ball.velocity = new Vector2D(outward * (5 + Math.random() * 3), lateral);
        ball.height = Math.max(ball.height, 1.6);
        ball.verticalVelocity = 6.5 + Math.random() * 2.5; // 크로스바(2.44m)를 확실히 넘긴다
      } else {
        // ② 골대 옆으로 쳐내기 — 골문 정면을 피해 측면으로 강하게 밀어낸다
        const away = ball.position.sub(goalCenter).normalize();
        const perp = new Vector2D(-away.y, away.x).scale(Math.random() < 0.5 ? 1 : -1);
        ball.velocity = perp.scale(7 + Math.random() * 5).add(away.scale(3));
        ball.height = Math.max(0, ball.height * 0.5);
        ball.verticalVelocity = 1.5 + Math.random() * 2;
      }

      ball.isShot = false;
      ball.owner = null;
      ball.lastTouchedBy = gk;
      ball.lastTouchedTeam = gk.team; // 골라인 아웃 시 코너킥으로 판정
      ball.passTargetPlayer = null;
      ball.isThroughPass = false;
      // 펀칭 직후 수비 라인 전체가 골문 쪽으로 내려와 세컨볼을 정리한다
      gk.team.emergencyDropTimer = 3.5;
      this.eventBus.emit('save', { team: gk.team, gk, held: false });
      return 'PARRIED';
    }

    // 뚫림 — 이 비행 동안 다시 선방 판정을 하지 않으며,
    // 뚫린 골키퍼는 지나가는 공을 주워 담을 수도 없다 (_updatePossession에서 제외)
    ball.gkBeaten = true;
    ball.gkBeatenBy = gk;
    return 'BEATEN';
  }

  _updatePossession(allPlayers, dt = 0) {
    const ball = this.ball;
    ball.kickLockTimer = Math.max(0, ball.kickLockTimer - dt);
    ball.headingCooldown = Math.max(0, (ball.headingCooldown ?? 0) - dt);
    if (ball.contest) {
      ball.contest.timer = Math.max(0, ball.contest.timer - dt);
      if (ball.contest.timer <= 0) ball.contest = null;
    }

    // ── Stage 5: 가로채기/블로킹 — 패스·슛 궤적 위 수비수의 차단 판정 ──
    // 비행(킥)당 1회만 판정해 매 틱 반복되며 공이 떨어지는 것을 방지한다
    if (!ball.owner && !ball.interceptionDone && ball.speed() > 6 && ball.height < 3.2) {
      ball.interceptionDone = true;
      if (this._tryInterception(allPlayers)) return;
    }

    // ── 헤딩 존 (0.7m ~ 1.8m, 하강 중): 공중볼 경합 ─────────────────
    // 낙하 중(verticalVelocity ≤ 1.0)이고 머리 높이에 있을 때만 헤딩 판정
    if (!ball.owner && ball.height >= 0.7 && ball.height <= 1.8 &&
        ball.verticalVelocity <= 1.0 && ball.headingCooldown <= 0 && ball.kickLockTimer <= 0) {
      const HEADING_RADIUS = 2.2;
      // GK 우선 처리: 박스 안 공중볼을 GK가 먼저 처리
      for (const t of [this.homeTeam, this.awayTeam]) {
        const gk = t.goalkeeper;
        if (gk && gk.role === 'GK' && !gk.hasBall &&
            gk.position.sub(ball.position).length() < HEADING_RADIUS) {
          ball.headingCooldown = 0.5;
          this._assignOwner(gk);
          return;
        }
      }
      // 아웃필드 선수 헤딩 경합
      const headingCandidates = allPlayers.filter(p =>
        p.role !== 'GK' && p.position.sub(ball.position).length() < HEADING_RADIUS
      );
      if (headingCandidates.length > 0) {
        // 수신 예정 선수만 있고 근처에 상대 없으면 → 일반 소유(트래핑)
        const passTarget = ball.passTargetPlayer;
        if (passTarget && headingCandidates.includes(passTarget)) {
          const hasOpponentCandidate = headingCandidates.some(p => p.team !== passTarget.team);
          const hasNearOpponent = hasOpponentCandidate || allPlayers.some(p =>
            p.team !== passTarget.team && p.role !== 'GK' &&
            p.position.sub(passTarget.position).length() < 3.0
          );
          if (!hasNearOpponent) {
            // 오프사이드 판정: 패스가 나간 순간 기준 스냅샷을 사용한다(수신 시점 아님)
            if (ball.receiverOffsideAtKick) {
              this._awardOffsideFreeKick(passTarget, ball);
              return;
            }
            this._assignOwner(passTarget);
            ball.headingCooldown = 0.3;
            return;
          }
        }
        this._resolveAerialHeader(headingCandidates);
        ball.headingCooldown = 0.8; // 헤딩 실행 후 설정 (ball.kick() 리셋 이후)
        return;
      }
    }

    // 2.0m 이상이면 소유 불가 (선수 키 상한)
    if (ball.height > 2.0) {
      if (ball.owner) {
        ball.owner.hasBall = false;
        ball.owner = null;
      }
      return;
    }

    const DRIBBLE_KEEP_RADIUS = 2.8;
    const inRange = Collision.playersWithinRadiusOfBall(allPlayers, ball, Collision.BALL_CONTROL_RADIUS);

    if (ball.owner) {
      const ownerDist = ball.owner.position.sub(ball.position).length();
      if (ownerDist <= DRIBBLE_KEEP_RADIUS) {
        ball.duelCooldown = Math.max(0, (ball.duelCooldown ?? 0) - dt);
        if (ball.duelCooldown <= 0) {
          const challenger = this._findCollisionChallenger(ball.owner, allPlayers);
          if (challenger) {
            ball.duelCount = (ball.duelCount ?? 0) + 1;
            const holder = ball.owner;
            this._startContest(holder, challenger);
            const duel = DuelResolver.resolveDribbleDuel(challenger, holder, ball);
            this._finishContest(holder, challenger, duel.outcome);

            if (duel.foul) {
              // 파울 발생
              ball.duelCount = 0;
              ball.duelCooldown = 1.5;
              this._triggerFoul(challenger, holder);
              return;
            }

            if (duel.winner === challenger) {
              // ── 수비수 승리: 태클 탈취 or 루즈볼 ──
              ball.duelCount = 0;
              ball.duelCooldown = 1.0;
              if (duel.loose) {
                holder.hasBall = false;
                const dir = Vector2D.fromAngle(challenger.facingAngle + (Math.random() - 0.5) * 1.5);
                ball.owner = null;
                ball.kicker = challenger;
                ball.kickLockTimer = 0.25;
                ball.velocity = dir.scale(4 + Math.random() * 3);
                ball.isShot = false;
                this.eventBus.emit('tackle', { winner: challenger, loose: true, outcome: 'LOOSE_BALL' });
              } else {
                holder.hasBall = false;
                this._assignOwner(challenger);
                this.eventBus.emit('tackle', { winner: challenger, loose: false, outcome: 'DISPOSSESSED' });
              }
            } else {
              // ── 공격수 승리: 확률적 드리블 성공 (돌파 또는 실딩) ──
              if (duel.outcome === 'DRIBBLE_BEAT') {
                // (A) 드리블 돌파(Beating Defender): 수비수 역동작/스턴 + 공격수 순간 탈출 가속
                challenger.brainMemory.stunTimer = 0.5 + Math.random() * 0.4;
                challenger.velocity = challenger.velocity.scale(0.2);

                const esc = duel.escapeDir
                  ? new Vector2D(duel.escapeDir.x, duel.escapeDir.y)
                  : Vector2D.fromAngle(holder.facingAngle);
                
                holder.desiredVelocity = esc.scale(holder.maxSpeed * 1.1);
                holder.velocity = esc.scale(holder.maxSpeed * 0.9);
                holder.brainMemory.dribbleBurstTimer = 0.6;
                ball.duelCooldown = 1.2;
                ball.duelCount = 0;
                this.eventBus.emit('dribble', { winner: holder, challenger, outcome: 'DRIBBLE_BEAT' });
              } else {
                // (B) 몸싸움 실딩(Body Shielding): 피지컬로 버텨내며 수비수 밀어내기
                const pushDir = challenger.position.sub(holder.position).normalize();
                challenger.position = Pitch.clampInside(
                  challenger.position.add(pushDir.scale(1.4)), 0.5
                );
                challenger.velocity = pushDir.scale(1.8);
                challenger.brainMemory.stunTimer = 0.35;

                ball.duelCooldown = 1.0;
                ball.duelCount = 0;
                this.eventBus.emit('dribble', { winner: holder, challenger, outcome: 'DRIBBLE_SHIELD' });
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

    // 패스 수신 예정자가 컨트롤 범위 안에 있으면 우선권을 준다 (오프사이드 제외)
    const passTarget = ball.passTargetPlayer;
    if (passTarget && !ball.owner) {
      const passTargetDist = passTarget.position.sub(ball.position).length();
      if (passTargetDist <= Collision.BALL_CONTROL_RADIUS) {
        // 오프사이드 판정: 패스가 나간 순간 기준 스냅샷을 사용한다(수신 시점 아님)
        if (ball.receiverOffsideAtKick) {
          this._awardOffsideFreeKick(passTarget, ball);
          return;
        }
        this._assignOwner(passTarget);
        return;
      }
    }

    let claimable = ball.kickLockTimer > 0
      ? inRange.filter((p) => p !== ball.kicker)
      : inRange;

    // 스루패스 통과 보정: 빠르게 굴러가는 땅볼 스루패스는 목표 수신자가 아닌
    // 상대 수비수의 몸에 살짝 스쳐도 곧바로 커트되지 않고(가랑이 사이·아슬아슬한
    // 통과), 훨씬 좁은 반경에 실제로 들어와야만 인터셉트를 허용한다.
    // 수신자(패스 타겟)만 확실하게 받을 수 있도록, 같은 팀 동료(키커 포함)는 인터셉트 불가.
    if (ball.isThroughPass && ball.height < 1.0 && ball.speed() > 3.5) {
      const NARROW_INTERCEPT_RADIUS = 0.5;
      claimable = claimable.filter((p) => {
        if (p === ball.passTargetPlayer) return true; // 의도된 수신자만 허용
        return p.position.sub(ball.position).length() <= NARROW_INTERCEPT_RADIUS; // 상대만 좁은 반경으로
      });
    }

    // 선방에 실패(뚫림)한 골키퍼는 빠르게 지나가는 공을 다시 주워 담을 수 없다
    if (ball.gkBeatenBy && ball.speed() > 5) {
      claimable = claimable.filter((p) => p !== ball.gkBeatenBy);
    }

    if (claimable.length === 0) return;
    this._assignOwner(claimable[0]);
  }

  _findCollisionChallenger(holder, allPlayers) {
    return allPlayers
      .filter((p) => p.team !== holder.team && p.position.sub(holder.position).length() <= Collision.PLAYER_CONTACT_RADIUS)
      .sort((a, b) => a.position.sub(holder.position).length() - b.position.sub(holder.position).length())[0] ?? null;
  }

  _tickContestTimers(players, dt) {
    for (const player of players) {
      const mem = player.brainMemory;
      if (!mem?.contestTimer) continue;
      mem.contestTimer = Math.max(0, mem.contestTimer - dt);
      if (mem.contestTimer <= 0) {
        mem.contestOpponent = null;
        mem.contestOutcome = null;
      }
    }
  }

  _startContest(holder, challenger) {
    this.ball.contest = { holder, challenger, timer: 0.35, outcome: 'CONTEST' };
    for (const [player, opponent] of [[holder, challenger], [challenger, holder]]) {
      player.state = 'CONTEST';
      player.brainMemory.contestTimer = 0.35;
      player.brainMemory.contestOpponent = opponent;
      player.brainMemory.contestOutcome = 'CONTEST';
    }
    this.eventBus.emit('contest', { holder, challenger, outcome: 'CONTEST' });
  }

  _finishContest(holder, challenger, outcome) {
    if (this.ball.contest) {
      this.ball.contest.outcome = outcome;
      this.ball.contest.timer = Math.max(this.ball.contest.timer, 0.25);
    }
    holder.brainMemory.contestOutcome = outcome;
    challenger.brainMemory.contestOutcome = outcome;
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

    // 슛은 수비수가 몸을 던져 막으므로 판정 반경이 더 넓다 (1.25 → 1.9m)
    const reach = ball.isShot ? 1.9 : 1.25;

    let best = null;
    let bestT = Infinity;
    for (const p of allPlayers) {
      if (p.role === 'GK') continue;
      if (ball.kickLockTimer > 0 && p === ball.kicker) continue;
      const { dist, t } = this._segmentDistance(p.position, ball.position, trajEnd);
      if (t > 0.03 && t < 0.8 && dist < reach && t < bestT) {
        bestT = t;
        best = p;
      }
    }
    if (!best) return false;

    const skill = (best.attributes.interception ?? 50) / 100;
    // 빠른 공일수록 가로채기 어렵다 — 완화: 빠른 스루패스가 수비 라인을 뚫도록
    const pacePenalty = Math.max(0.35, 1 - speed * 0.015);
    const interceptChance = skill * pacePenalty * 0.45;
    // 몸에 맞고 굴절될 확률 — 슛은 블록/굴절이 훨씬 자주 나온다
    const deflectChance = ball.isShot ? 0.34 : 0.12;
    const roll = Math.random();

    if (roll < interceptChance) {
      if (ball.isShot) {
        this._deflectBall(best); // 슛은 몸을 던져 블로킹
      } else {
        this._rememberCutPass();  // 패서에게 "이 길은 막혔다"를 기억시킨다
        this._assignOwner(best);  // 깔끔하게 가로채기 → 소유
        this.eventBus.emit('interception', { player: best });
      }
      return true;
    }
    if (roll < interceptChance + deflectChance) {
      if (!ball.isShot) this._rememberCutPass();
      this._deflectBall(best);
      return true;
    }
    return false; // 놓침 → 통과
  }

  /**
   * 패스가 커트당하면 패서에게 "그 방향/그 수신자는 막혔다"를 일정 시간 기억시킨다.
   * 다시 볼을 잡았을 때 같은 길로 또 찔러 넣지 않고 다른 선택지를 살피게 된다.
   */
  _rememberCutPass() {
    const ball = this.ball;
    const passer = ball.kicker;
    if (!passer?.brainMemory) return;
    const mem = passer.brainMemory;
    mem.cutPassTimer = 6.0;
    mem.cutPassTarget = ball.passTargetPlayer ?? null;
    const v = ball.velocity;
    mem.cutPassDir = v.length() > 0.5 ? v.normalize() : null;
  }

  /**
   * 공이 수비수 몸에 맞고 튕겨 나가는 굴절 물리.
   * 입사 벡터를 수비수 중심 기준 법선으로 반사하고 에너지를 감쇠시킨다.
   */
  _deflectBall(player) {
    const ball = this.ball;
    const wasShot = ball.isShot;
    const speed = ball.speed();
    const dir = speed > 1e-3 ? ball.velocity.normalize() : Vector2D.fromAngle(Math.random() * Math.PI * 2);

    // ── 굴절 슛(Deflected Shot): 완전히 막히지 않고 방향만 꺾여 계속 날아간다 ──
    // 수비수 발/몸에 살짝 맞아 굴절된 슛은 골키퍼를 속이거나 코너킥으로 이어진다.
    if (wasShot && Math.random() < 0.38) {
      const skew = (Math.random() - 0.5) * 0.9; // ±약 26도
      ball.velocity = dir.rotate(skew).scale(speed * (0.62 + Math.random() * 0.25));
      ball.height = Math.max(0, ball.height * 0.6) + Math.random() * 0.4;
      ball.verticalVelocity += Math.random() * 2.2;
      ball.owner = null;
      ball.isShot = true;             // 여전히 슛 — 골키퍼 선방 판정 유지
      ball.lastTouchedBy = player;    // 마지막 터치는 수비수 → 라인 아웃 시 코너킥
      ball.lastTouchedTeam = null;    // 루즈볼로 취급해 양 팀이 다툰다
      ball.passTargetPlayer = null;
      ball.isThroughPass = false;
      ball.kickLockTimer = Math.max(ball.kickLockTimer, 0.15);
      // 궤도가 바뀌었으므로 골키퍼는 다시 선방을 시도할 수 있다
      ball.gkBeaten = false;
      ball.gkBeatenBy = null;
      this.eventBus.emit('block', { player, deflected: true });
      return;
    }

    const n = ball.position.sub(player.position);
    const normal = n.length() > 1e-3 ? n.normalize() : Vector2D.fromAngle(dir.angle() + Math.PI / 2);
    const reflect = dir.sub(normal.scale(2 * dir.dot(normal)));
    ball.velocity = reflect
      .scale(speed * 0.55)
      .add(Vector2D.fromAngle((Math.random() - 0.5) * 0.6, speed * 0.2));

    // ── 박스 안 블로킹은 종종 골라인 밖으로 튄다 (코너킥 유발) ──
    // 자기 페널티 박스 안에서 슛을 막은 수비수는 몸에 맞은 공을 뒤로 흘리는
    // 경우가 많다. 이 처리가 없으면 코너킥이 거의 나오지 않는다.
    if (wasShot) {
      const ownGoalX = player.team.attackingDirection === 1 ? 0 : Pitch.LENGTH;
      const inOwnBox = Math.abs(player.position.x - ownGoalX) < Pitch.PENALTY_BOX_LENGTH + 4;
      if (inOwnBox && Math.random() < 0.30) {
        const behind = new Vector2D(ownGoalX === 0 ? -1 : 1, (Math.random() - 0.5) * 1.2).normalize();
        ball.velocity = behind.scale(speed * (0.30 + Math.random() * 0.30));
      }
    }
    ball.height = Math.max(0, ball.height * 0.4);
    ball.isShot = false;
    ball.owner = null;
    // 편향 후 루즈볼: 어느 팀도 점유하지 않은 상태로 전환
    ball.lastTouchedBy = player;
    ball.lastTouchedTeam = null;
    ball.passTargetPlayer = null;
    ball.isThroughPass = false;
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

  _awardOffsideFreeKick(offsidePlayer, ball) {
    const defendingTeam = offsidePlayer.team === this.homeTeam ? this.awayTeam : this.homeTeam;
    const spot = Pitch.clampInside(ball.position.clone(), 1.2);
    
    this.ball.reset(spot);
    const taker = this._nearestPlayer(defendingTeam, spot, true);
    this._setOwner(taker);
    this.ball.position = spot.clone();
    
    // 프리킥과 동일하게 타겟 계산 (수비팀이 프리킥을 얻으므로 defendingTeam이 attackingTeam 역할)
    const targets = this._computeFreeKickTargets(defendingTeam, spot);
    
    this.matchState.phase = Phase.SET_PIECE_SETUP;
    this.matchState.phaseTimer = 5.0;
    this.matchState.restartInfo = { type: 'FREE_KICK', team: defendingTeam, taker, spot, targets, preSetupTimer: 2.0, waitTimer: 1.5 };
    this.eventBus.emit('offside', { player: offsidePlayer, team: offsidePlayer.team, spot });
  }

  _assignOwner(player) {
    const ball = this.ball;
    if (player.role === 'GK' && ball.isShot && !ball.gkBeaten && ball.velocity.length() > 7) {
      // 슛 저지는 선방 판정으로 일원화한다 (뚫리면 공이 그대로 지나간다).
      // HELD일 때의 GK 소유 국면 전환도 _attemptGkSave 안에서 처리한다.
      this._attemptGkSave(player);
      return;
    }
    this._setOwner(player);

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
    ball.contest = null;
    player.hasBall = true;
    ball.lastTouchedBy = player;
    ball.lastTouchedTeam = player.team;
    ball.isShot = false;
    ball.passTargetPlayer = null; // 소유권이 결정되면 패스 수신자 정보 초기화
    ball.isThroughPass = false;

    // 공을 잡는 순간 공을 완전히 멈춰 발밑에 놓는다(트래핑). 굴러가던 관성이 남아
    // 곧바로 흘러나가는 현상을 막는다.
    ball.velocity = Vector2D.zero();
    ball.height = 0;
    ball.verticalVelocity = 0;
    ball.position = player.position.add(Vector2D.fromAngle(player.facingAngle).scale(0.85));

    if (isNewController && player.role !== 'GK') {
      // ── 완급 조절: 팀 템포(긴급도)에 따라 볼 처리 속도가 달라진다 ──
      // 빌드업(느림)에서는 여유롭게 잡아 두고, 역습 창에서는 짧게 끊어 처리한다.
      const urgency = player.team?.tempo?.urgency ?? 0.5;
      const tempoScale = 1.35 - urgency * 0.62; // urgency 0.24→1.20, 0.95→0.76

      // ── 패스 템포 지시에 따른 볼 처리 시간 ────────────────────
      // 빠름: 논스톱(원터치)이거나 소유 후 0.5~3초 안에 처리
      // 느림: 소유 후 2~4초 동안 살피며 볼을 소유
      const tempoTactic = player.team?.tactics?.tempo ?? 0.5;
      const holdMin = 2.0 - tempoTactic * 1.5;   // 느림 2.0s ~ 빠름 0.5s
      const holdMax = 4.0 - tempoTactic * 1.0;   // 느림 4.0s ~ 빠름 3.0s
      let tMin = holdMin + Math.random() * Math.max(0.1, holdMax - holdMin);

      // 논스톱(원터치) 패스: 템포가 빠를수록 자주 나온다 (빠름 최대 28%)
      const oneTouchChance = Math.max(0, (tempoTactic - 0.35) * 0.43);
      const oneTouch = Math.random() < oneTouchChance;

      // 볼을 잡으면 잠깐 컨트롤(주위 살피기) → 곧바로 되받아 차는 탁구 패스 방지
      // (논스톱 패스는 이 컨트롤 자체를 생략한다)
      player.brainMemory.controlTimer = oneTouch
        ? 0
        : (0.40 + Math.random() * 0.40) * tempoScale;
      player.brainMemory.possessionTimer = 0;
      player.brainMemory.decisionCooldown = 0;
      player.brainMemory.lastIntent = null;
      player.brainMemory.oneTouch = oneTouch;
      player.brainMemory.tMin = oneTouch ? 0 : tMin * (0.75 + tempoScale * 0.25);
      // 새 소유 → 스캔(주위 살피기) 판정을 다시 수행한다
      player.brainMemory.scanDone = false;
      player.brainMemory.scanTimer = 0;
      // 침투(PENETRATING)·측면(FLANKING)·박스쇄도(BOX_CRASHING) 러너가
      // 패스를 받으면 컨트롤 홀드를 건너뛰고 곧바로 전방 드리블로 이어간다.
      const receiveBehavior = player.brainMemory.offBallBehavior;
      player.brainMemory.firstTouchCarry =
        receiveBehavior === 'PENETRATING' || receiveBehavior === 'FLANKING' || receiveBehavior === 'BOX_CRASHING';
      // 후방→전방 드리블 거리 측정 기준점 (소유 시작 위치)
      player.brainMemory.dribbleOriginX = player.position.x;
    }
  }

  // ---------- 아웃오브플레이 판정 ----------

  _checkBoundaries() {
    const ball = this.ball;
    const { x, y } = ball.position;
    if (x <= 0 || x >= Pitch.LENGTH) {
      if (Pitch.isGoal(x, y)) {
        const [topY, bottomY] = Pitch.goalYRange();
        const height = ball.height ?? 0;

        // ── 크로스바 강타: 골대 상단을 맞고 튕겨 나온다 ──
        if (Math.abs(height - CROSSBAR_HEIGHT) < WOODWORK_MARGIN) {
          this._woodworkRebound(x <= 0, 'CROSSBAR');
          return;
        }
        // ── 골대 위로 넘어감: 골이 아니라 골킥 ──
        if (height > CROSSBAR_HEIGHT) {
          this._handleGoalLineOut(x, y);
          return;
        }
        // ── 골포스트 강타: 좌우 기둥을 맞고 튕겨 나온다 ──
        if (Math.min(Math.abs(y - topY), Math.abs(y - bottomY)) < WOODWORK_MARGIN) {
          this._woodworkRebound(x <= 0, 'POST');
          return;
        }
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

  /**
   * 골대(크로스바/포스트) 강타 — 공이 경기장 안으로 튕겨 나오고 플레이가 계속된다.
   * 리바운드된 공은 소유자가 없는 루즈볼이므로 양 팀이 다투게 된다.
   */
  _woodworkRebound(isLeftGoal, part) {
    const ball = this.ball;
    const inward = isLeftGoal ? 1 : -1;
    const speed = Math.max(4, ball.speed());

    // 골라인 안쪽 1.2m 지점으로 되돌리고 X 속도를 반전시킨다
    ball.position = new Vector2D(
      isLeftGoal ? 1.2 : Pitch.LENGTH - 1.2,
      Math.max(1, Math.min(Pitch.WIDTH - 1, ball.position.y))
    );
    const outDir = new Vector2D(inward, (Math.random() - 0.5) * 1.1).normalize();
    ball.velocity = outDir.scale(speed * (0.42 + Math.random() * 0.25));

    if (part === 'CROSSBAR') {
      // 크로스바를 맞으면 아래로 떨어진다
      ball.height = CROSSBAR_HEIGHT * 0.85;
      ball.verticalVelocity = -1.5 - Math.random() * 2;
    } else {
      ball.height = Math.max(0, ball.height * 0.5);
      ball.verticalVelocity = 0;
    }

    ball.isShot = false;
    ball.owner = null;
    ball.passTargetPlayer = null;
    ball.isThroughPass = false;
    ball.lastTouchedTeam = null;      // 루즈볼 — 양 팀이 세컨볼을 다툰다
    ball.kickLockTimer = Math.max(ball.kickLockTimer, 0.2);
    ball.interceptionDone = false;
    this.eventBus.emit('woodwork', { part });
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

    // 굴절/블록으로 lastTouchedTeam이 비어 있으면 마지막으로 몸에 맞은 선수의
    // 팀을 기준으로 판정한다 (수비수 맞고 나간 슛 → 코너킥).
    const lastTeam = this.ball.lastTouchedTeam ?? this.ball.lastTouchedBy?.team ?? null;

    if (lastTeam === defendingTeam) {
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
   * 스로인 배치: 필드 절반 폭(Y축 68m의 ~34m)까지 넓게 분산
   *
   * - 2m 규정: 수비팀 모든 선수는 공에서 최소 2m 이격
   * - 수신자 3명(가장 가까운 팀원): 스팟 기준 필드 안쪽 부채꼴에 배치
   * - 수비 마크: 수신자에게 1:1 골 사이드 마킹 (공에서 2m 보장)
   * - 나머지: 터치라인(스팟)에서 필드 중앙(절반 폭)까지 Y축에 균등 분산해
   *   좁은 구역에 뭉치지 않게 펼친다. X축도 스팟 기준으로 완만하게 확산.
   */
  _computeThrowInTargets(team, taker, spot) {
    const targets = new Map();
    const opponentTeam = team === this.homeTeam ? this.awayTeam : this.homeTeam;
    const THROW_IN_MIN_OPP_DIST = 2;

    // 필드 중앙 방향(inward) + 터치라인 방향(along)
    const inward = Pitch.center().sub(spot).normalize();
    const along  = new Vector2D(-inward.y, inward.x);

    // 터치라인(spot.y)에서 필드 중앙(Pitch.WIDTH/2, 절반 폭)까지 Y축에 균등 분산
    // 스로인 지점 주변으로 뭉치지 않게 팀 전체를 절반 폭까지 펼친다
    const centerY = Pitch.WIDTH / 2;
    const spreadY = (slot, total) => {
      const f = total <= 1 ? 0.5 : (slot + 1) / (total + 1);
      return spot.y + (centerY - spot.y) * f;
    };

    // ── 공격팀: 수신자 3명 부채꼴 배치 + 나머지는 필드 절반 폭까지 분산 ──
    // 수신자 간 거리·각도를 넓혀 스로인 지점 주변이 좁게 뭉치지 않게 한다
    const RECEIVER_COUNT = 3;
    const RECV_ANGLES = [0, Math.PI / 3, -Math.PI / 3];
    const RECV_DISTS  = [6, 8.5, 10.5];

    const attackers = [...team.outfieldPlayers.filter((p) => p !== taker)]
      .sort((a, b) => a.position.sub(spot).length() - b.position.sub(spot).length());

    const receiverTargets = [];
    const nonReceiverCount = Math.max(1, attackers.length - RECEIVER_COUNT);
    attackers.forEach((p, i) => {
      let target;
      if (i < RECEIVER_COUNT) {
        const ang       = RECV_ANGLES[i];
        const radialDir = inward.scale(Math.cos(ang)).add(along.scale(Math.sin(ang)));
        target = Pitch.clampInside(spot.add(radialDir.scale(RECV_DISTS[i])), 0.5);
        receiverTargets.push(target);
      } else {
        // Y: 터치라인 → 필드 중앙(절반 폭)까지 균등 분산
        const y = spreadY(i - RECEIVER_COUNT, nonReceiverCount);
        // X: 수신자가 아닌 선수들은 상대 진영 깊숙이 전진 배치해
        // 스로인 지점 주변의 수비 밀집을 깨고 공격 옵션을 늘린다.
        // CB는 자기 위치 유지, 그 외 포지션은 공격 방향으로 18~25m 전진.
        const atkDir = team.attackingDirection;
        const isDeepDefender = p.role === 'CB' || p.role === 'LB' || p.role === 'RB';
        const forwardOffset = isDeepDefender ? 7 : (p.role === 'CM' ? 18 : 22);
        const forwardBase = p.basePosition.x + atkDir * forwardOffset;
        // 스팟 쪽으로의 당김을 12% → 5%로 줄여 전방 위치 강제 유지
        const x = forwardBase + (spot.x - forwardBase) * 0.05;
        target = Pitch.clampInside(new Vector2D(x, y), 1.0);
      }
      targets.set(p.id, target);
    });

    // ── 수비팀: 수신자 3명 골사이드 마킹 + 나머지는 절반 폭 분산 + 골문 방향 6m 후퇴 ─
    const defDir     = opponentTeam.attackingDirection;
    const ownGoalPos = Pitch.goalCenter(defDir === 1 ? 'right' : 'left');
    const defenders  = [...opponentTeam.outfieldPlayers]
      .sort((a, b) => a.position.sub(spot).length() - b.position.sub(spot).length());

    const markerCount = receiverTargets.length;
    const nonMarkerCount = Math.max(1, defenders.length - markerCount);
    defenders.forEach((p, i) => {
      let target;
      if (i < markerCount) {
        const recv   = receiverTargets[i];
        const toGoal = ownGoalPos.sub(recv).normalize();
        target = recv.add(toGoal.scale(1.5));
      } else {
        const y = spreadY(i - markerCount, nonMarkerCount);
        const x = spot.x + (p.basePosition.x - spot.x) * 0.4 - defDir * 6;
        target = Pitch.clampInside(new Vector2D(x, y), 1.0);
      }
      // 2m 규정 강제 적용
      const toSpot = target.sub(spot);
      if (toSpot.length() < THROW_IN_MIN_OPP_DIST) {
        const dir = toSpot.length() > 1e-6 ? toSpot.normalize() : inward;
        target = spot.add(dir.scale(THROW_IN_MIN_OPP_DIST));
      }
      targets.set(p.id, Pitch.clampInside(target, 1.0));
    });

    // ── 스로인 응집 박스 (Throw-in Compaction Box) ────────────────
    // 경합에 직접 참여하지 않는 선수들이 자기 기본 라인까지 내려가 버리면
    // 스로인 지점만 덩그러니 남아 경기가 늘어진다. 양 팀 전원을 볼 기준
    // x ±50m, y ±40m 박스 안으로 끌어와 실제 경기처럼 밀집시킨다.
    const BOX_X = 50;
    const BOX_Y = 40;
    for (const [id, t] of targets) {
      targets.set(id, Pitch.clampInside(new Vector2D(
        Math.max(spot.x - BOX_X, Math.min(spot.x + BOX_X, t.x)),
        Math.max(spot.y - BOX_Y, Math.min(spot.y + BOX_Y, t.y))
      ), 1.0));
    }

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

    // ── 수비팀(골킥을 받지 않는 팀): 하이 블록 전진 압박 대형 ──
    // CB만 하프라인 8m 후방, 나머지는 하프라인을 넘어 상대 진영으로 크게 전진
    //   · CB           : 하프라인 8m 후방
    //   · LB/RB        : 하프라인 2m 후방
    //   · CM           : 상대 진영 20m 전진 (골킥 출구 차단)
    //   · LM/RM        : 상대 진영 28m 전진 (측면 압박)
    //   · ST           : 상대 진영 28m (골라인에서 약 24m 지점, 페널티박스 밖)
    //   · 폭           : 중앙으로 좁혀 짧은 골킥 전개 차단
    const halfX = Pitch.LENGTH / 2;
    const oppDir = opponentTeam.attackingDirection; // 이 팀이 공격하는 방향
    // 역할별 블록 내 깊이(m): 양수 = 상대 진영 쪽(압박), 음수 = 자기 진영 쪽(수비)
    // 하이 블록 전진 압박: 수비수만 살짝 후방, 나머지는 모두 상대 진영으로
    const GOAL_KICK_BLOCK = {
      CB: -8, LB: -2, RB: -2, CM: 20, LM: 28, RM: 28, ST: 28,
    };
    const NARROW = 0.70; // 폭 압축률 (중앙 기준)

    for (const p of opponentTeam.outfieldPlayers) {
      const depth = GOAL_KICK_BLOCK[p.role] ?? 0;
      const bx = halfX + oppDir * depth;
      const by = centerY + (p.basePosition.y - centerY) * NARROW;
      let target = new Vector2D(bx, by);

      // 페널티 박스 내부면 강제 이격 (규정: 골킥 처리 전 박스 밖)
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

  /**
   * 공중볼 헤딩 경합: 양팀 후보 중 jumping 능력치 기반으로 승자를 결정하고
   * 승자가 헤딩 의도(HEAD_SHOT / HEAD_PASS / HEAD_CLEAR)를 실행한다.
   */
  _resolveAerialHeader(candidates) {
    const ball = this.ball;

    const homeCandidates = candidates.filter(p => p.team === this.homeTeam);
    const awayCandidates = candidates.filter(p => p.team === this.awayTeam);

    // 패스 수신 예정 선수가 경합권 안에 있으면 그 선수를 우선한다 —
    // 수신자 아닌 동료가 대신 헤딩하는 혼선을 줄인다
    const pickCandidate = (players) => {
      if (players.length === 0) return null;
      const passTarget = this.ball.passTargetPlayer;
      if (passTarget && players.includes(passTarget)) return passTarget;
      return players.reduce((best, p) =>
        p.position.sub(ball.position).length() < best.position.sub(ball.position).length() ? p : best
      );
    };

    const homeCandidate = pickCandidate(homeCandidates);
    const awayCandidate = pickCandidate(awayCandidates);

    let winner;
    if (homeCandidate && awayCandidate) {
      // 패스 수신자를 우대해 로빙 스루패스/크로스가 헤딩 경합에서 더 자주 연결되게 한다
      const passTarget = this.ball.passTargetPlayer;
      const favored = (passTarget === homeCandidate || passTarget === awayCandidate) ? passTarget : null;
      winner = DuelResolver.resolveAerialDuel(homeCandidate, awayCandidate, favored);
    } else {
      winner = homeCandidate ?? awayCandidate;
    }

    if (!winner) return;

    const opponentTeam = winner.team === this.homeTeam ? this.awayTeam : this.homeTeam;
    const intent = decideHeaderIntent(winner, ball, opponentTeam, winner.team);
    ActionExecutor.execute(winner, intent, ball, this.eventBus);
    this.eventBus.emit('header', { by: winner, team: winner.team });

    // 헤더 패스도 일반 패스와 동일하게 "볼이 발(머리)을 떠나는 순간" 기준으로
    // 오프사이드 스냅샷을 남긴다.
    if ((intent.type === 'PASS' || intent.type === 'HEAD_PASS') && ball.passTargetPlayer) {
      const allPlayers = [...this.homeTeam.players, ...this.awayTeam.players];
      ball.receiverOffsideAtKick = checkOffside(ball.passTargetPlayer, ball, allPlayers);
    }
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
        // 테이커가 공을 소유하도록 보장 (골킥 등에서 공 소유권 유지)
        this._setOwner(taker);
      }
      this.matchState.phaseTimer -= dt;
      if (this.matchState.phaseTimer <= 0) this._executeSetPieceRestart();
      return;
    }

    // 킥오프: 선수 이동 없이 타이머만 카운트다운 후 실행
    if (isKickoff) {
      this.matchState.phaseTimer -= dt;
      if (this.matchState.phaseTimer <= 0) this._executeKickoff();
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
          .add(inward.scale(7 + idx * 2.5))
          .add(along.scale(spread * (5 + idx * 3)));
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
        const pull = Math.min(toSpot.length() * 0.15, 5);
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

  /**
   * 수비벽이 서 있는 프리킥을 직접 슈팅한다. 벽 지점에서 확실히 높이(약 2.3m)를
   * 넘도록 궤도를 계산하고, 목표 지점(골문 안)에서 다시 지면 높이로 가라앉는
   * 대칭 포물선을 사용해 "벽을 넘겨 골문으로 감아 들어가는" 궤적을 만든다.
   * h(t) = v_vert·t − ½g·t²,  대칭 낙하 가정 시 v_vert = g·t_total/2
   * 벽 통과 시점 높이는 h(t_wall) = ½g·t_wall·(t_total−t_wall) 이며, 이는
   * power(수평 속도)의 제곱에 반비례하므로 power 상한을 역산해 벽 클리어를 보장한다.
   */
  _executeFreeKickOverWall(taker, defGoalCenter, wallPlayers) {
    const GRAVITY_FK = 9.8;
    const ball = this.ball;
    const [topY, bottomY] = Pitch.goalYRange();
    const accuracy = (taker.attributes.shooting ?? 65) / 100;
    const spread = 0.12 + (1 - accuracy) * 0.5;
    const targetY = topY + (bottomY - topY) * (0.5 + (Math.random() - 0.5) * spread);
    const targetPoint = new Vector2D(defGoalCenter.x, targetY);
    const toTarget = targetPoint.sub(taker.position);
    const dist = Math.max(8, toTarget.length());
    const dir = toTarget.normalize();

    const wallCenter = wallPlayers
      .reduce((acc, p) => acc.add(p.position), Vector2D.zero())
      .scale(1 / wallPlayers.length);
    const dWall = Math.max(4, Math.min(dist - 3, wallCenter.sub(taker.position).length()));

    const H_CLEAR = 2.2 + Math.random() * 0.3; // 수비벽 점프 리치를 넘기는 목표 높이
    const maxPower = Math.sqrt(Math.max(1, (0.5 * GRAVITY_FK * dWall * Math.max(1, dist - dWall)) / H_CLEAR));
    const power = Math.max(13, Math.min(23, maxPower * (0.86 + Math.random() * 0.08)));
    const tTotal = dist / power;
    const vertical = GRAVITY_FK * tTotal / 2;

    ball.kick(dir.scale(power), vertical, taker);
    ball.isShot = true;

    taker.hasBall = false;
    taker.desiredVelocity = Vector2D.zero();
    taker.state = 'SHOOT';
    taker.facingAngle = dir.angle();
    taker.desiredFacingAngle = taker.facingAngle;
    const onTarget = targetY >= topY && targetY <= bottomY;
    this.eventBus.emit('shot', { by: taker, team: taker.team, onTarget, src: 'FREE_KICK_WALL' });
  }

  _executeSetPieceRestart() {
    const info = this.matchState.restartInfo;
    const taker = info.taker;
    const team = info.team;
    const opponentTeam = team === this.homeTeam ? this.awayTeam : this.homeTeam;

    let receiver = null;
    let lofted = false;
    let throwTargetPos = null;

    if (info.type === 'GOAL_KICK') {
      // 골킥: 수신자가 충분히 열려 있을 때만 단패스, 아니면 롱볼
      // (수신자 압박 판정이 동작하도록 let으로 선언 — const였으면 재할당 오류)
      // 골키퍼 배급 지시(짧은 패스~긴 패스)를 반영한다.
      let useShort = Math.random() < (team.tactics?.gkShortPassChance ?? 0.30);
      if (useShort) {
        // 단패스 수신자 선택: 상대 압박·최근접 수비수를 함께 반영해
        // 빼앗길 위험이 적은 공간으로 연결한다.
        let bestScore = -Infinity;
        for (const p of team.outfieldPlayers) {
          const dist = p.position.sub(taker.position).length();
          if (dist < 3 || dist > 30) continue;
          const closeOpps = opponentTeam.players.filter((o) => {
            if (o.role === 'GK') return false;
            return o.position.sub(p.position).length() < 5;
          });
          const nearestOpp = opponentTeam.players
            .filter((o) => o.role !== 'GK')
            .reduce((a, o) => (!a || o.position.sub(p.position).length() < a.position.sub(p.position).length() ? o : a), null);
          const nearestDist = nearestOpp ? nearestOpp.position.sub(p.position).length() : 99;
          const score = -closeOpps.length * 12 - Math.max(0, 5 - nearestDist) * 8 - dist * 0.05;
          if (score > bestScore) { bestScore = score; receiver = p; }
        }
        // 단패스 수신자가 압박(5m 내 상대 2명 이상 또는 3m 내 상대 존재)받으면
        // 안전하게 롱볼로 전환한다.
        if (receiver) {
          const pressCount = opponentTeam.players.filter((o) => {
            if (o.role === 'GK') return false;
            return o.position.sub(receiver.position).length() < 5;
          }).length;
          const nearestOpp = opponentTeam.players
            .filter((o) => o.role !== 'GK')
            .reduce((a, o) => (!a || o.position.sub(receiver.position).length() < a.position.sub(receiver.position).length() ? o : a), null);
          const nearestDist = nearestOpp ? nearestOpp.position.sub(receiver.position).length() : 99;
          if (pressCount >= 2 || nearestDist < 3.0) {
            useShort = false;
            receiver = null;
          }
        }
      }
      if (!receiver) receiver = this._chooseReceiver(taker, team, opponentTeam);
      if (!receiver) receiver = team.outfieldPlayers[0];
      // 안전장치: 수신자가 없거나 GK면 첫 번째 필드 플레이어 사용
      if (!receiver || receiver.role === 'GK') {
        receiver = team.outfieldPlayers.find(p => p !== taker) || team.players.find(p => p.role !== 'GK');
      }
      // 최종 폴백: 여전히 없으면 킥 실행 안 함 (무한 루프 방지)
      if (!receiver) {
        this.matchState.phase = Phase.IN_PLAY;
        this.matchState.restartInfo = null;
        return;
      }
      lofted = !useShort;
    } else if (info.type === 'THROW_IN') {
      // 스로인: 80% 근거리(스팟 8m 이내 대기 중인 수신자), 20% 원거리
      const NEAR_RADIUS = 8;
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
      // 안전장치: 수신자 검증
      if (!receiver || receiver.role === 'GK') {
        receiver = team.outfieldPlayers.find(p => p !== taker) || team.players.find(p => p.role !== 'GK');
      }
      // 최종 폴백: 여전히 없으면 킥 실행 안 함
      if (!receiver) {
        this.matchState.phase = Phase.IN_PLAY;
        this.matchState.restartInfo = null;
        return;
      }
      
      // 스로인 거리 20m 제한 (규정: 20m 이내)
      // 수신자 객체를 교체하지 않고 targetPos로 제한된 위치를 전달
      const throwDist = receiver.position.sub(taker.position).length();
      if (throwDist > 20) {
        const dir = receiver.position.sub(taker.position).normalize();
        throwTargetPos = taker.position.add(dir.scale(20));
      }
      
      lofted = receiver.position.sub(taker.position).length() > 18;
    } else if (info.type === 'CORNER') {
      // 코너킥: 80%는 박스 안으로 크로스, 20%는 짧은 패스로 빌드업을 시작한다.
      const wantShortCorner = Math.random() < 0.20;
      if (wantShortCorner) {
        const shortMates = team.outfieldPlayers
          .filter((p) => p !== taker)
          .map((p) => ({ p, dist: p.position.sub(taker.position).length() }))
          .filter((e) => e.dist >= 2 && e.dist <= 12)
          .sort((a, b) => a.dist - b.dist);
        if (shortMates.length > 0) receiver = shortMates[0].p;
      }
      if (!receiver) {
        // 크로스: 박스 안 헤더 위협(공격 배치상 골문에 가장 가까운 동료)을 우선한다.
        const goalXCorner = opponentTeam.attackingDirection === 1 ? 0 : Pitch.LENGTH;
        const boxMates = team.outfieldPlayers.filter((p) =>
          p !== taker && Math.abs(p.position.x - goalXCorner) < Pitch.PENALTY_BOX_LENGTH + 4
        );
        if (boxMates.length > 0) {
          receiver = boxMates.reduce((a, b) =>
            Math.abs(b.position.x - goalXCorner) < Math.abs(a.position.x - goalXCorner) ? b : a
          );
        }
      }
      if (!receiver) receiver = this._chooseReceiver(taker, team, opponentTeam) ?? team.players.find((p) => p !== taker);
      if (!receiver || receiver.role === 'GK') {
        receiver = team.outfieldPlayers.find(p => p !== taker) || team.players.find(p => p.role !== 'GK');
      }
      if (!receiver) {
        this.matchState.phase = Phase.IN_PLAY;
        this.matchState.restartInfo = null;
        return;
      }
      lofted = !wantShortCorner;
    } else if (info.type === 'FREE_KICK') {
      // 프리킥: 위험 거리(25m 이내)에서는 상대 수비벽 유무와 관계없이 직접 슈팅을
      // 적극적으로 시도한다. 수비벽이 서 있으면 벽을 넘기는 궤적으로 감아 찬다.
      const defGoal = Pitch.goalCenter(opponentTeam.attackingDirection === 1 ? 'left' : 'right');
      const distFK = taker.position.sub(defGoal).length();
      const wallPlayers = opponentTeam.players.filter((p) => {
        if (p.role === 'GK') return false;
        const { dist, t } = this._segmentDistance(p.position, taker.position, defGoal);
        return dist < 2.5 && t > 0.15 && t < 0.75;
      });
      const hasWall = wallPlayers.length >= 2;
      const directShotChance = hasWall ? 0.45 : 0.30;
      if (distFK < 25 && Math.random() < directShotChance) {
        if (hasWall) {
          // 수비벽을 넘기는 궤적: 벽 지점에서 확실히 넘도록 띄우고 골문 앞에서
          // 가라앉는 감아차기 궤적으로 킥한다.
          this._executeFreeKickOverWall(taker, defGoal, wallPlayers);
        } else {
          ActionExecutor.execute(taker, { type: 'SHOOT' }, this.ball, this.eventBus);
        }
        this.matchState.phase = Phase.IN_PLAY;
        this.matchState.restartInfo = null;
        return;
      }
      receiver = this._chooseReceiver(taker, team, opponentTeam) ?? team.players.find((p) => p !== taker);
      if (!receiver || receiver.role === 'GK') {
        receiver = team.outfieldPlayers.find(p => p !== taker) || team.players.find(p => p.role !== 'GK');
      }
      if (!receiver) {
        this.matchState.phase = Phase.IN_PLAY;
        this.matchState.restartInfo = null;
        return;
      }
      lofted = distFK < 30;
    } else {
      receiver = this._chooseReceiver(taker, team, opponentTeam) ?? team.players.find((p) => p !== taker);
      if (!receiver || receiver.role === 'GK') {
        receiver = team.outfieldPlayers.find(p => p !== taker) || team.players.find(p => p.role !== 'GK');
      }
      if (!receiver) {
        this.matchState.phase = Phase.IN_PLAY;
        this.matchState.restartInfo = null;
        return;
      }
      lofted = false;
    }

    try {
      ActionExecutor.execute(taker, { type: 'PASS', targetPlayer: receiver, targetPos: throwTargetPos, lofted }, this.ball, this.eventBus);
      this.matchState.phase = Phase.IN_PLAY;
      this.matchState.restartInfo = null;
    } catch (e) {
      console.error('Set piece restart error:', e);
      // 에러 발생 시에도 경기 진행을 위해 강제 전환
      this.matchState.phase = Phase.IN_PLAY;
      this.matchState.restartInfo = null;
    }
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
      // 상대팀: GK가 공을 잡는 동안 하프라인 20m 아래까지 백코트한 수비 블록 구성.
      // 공수 간격을 좁게 유지해서 GK가 찬 뒤에도 전환 거리를 줄인다.
      const theirDir = -attackDir;
      const defLineX = halfwayX - theirDir * 20; // 수비 라인: 하프라인에서 자팀 골 쪽 20m
      switch (player.role) {
        case 'ST':  targetX = defLineX + theirDir * 14; break; // 라인 위 ~14m
        case 'LM':
        case 'RM':  targetX = defLineX + theirDir * 8;  break; // 라인 위 ~8m
        case 'CM':  targetX = defLineX + theirDir * 5;  break; // 라인 위 ~5m
        default:    targetX = defLineX;                 break; // CB/LB/RB: 수비 라인
      }
    }

    const target = player.basePosition.clone();
    target.x = targetX;
    return Pitch.clampInside(target, 1.2);
  }

  /** GK가 공을 차는 시점: 단패스(35%)와 롱패스(65%)를 섞는다 */
  _executeGkDistribution(gk, gkTeam) {
    const opponentTeam = gkTeam === this.homeTeam ? this.awayTeam : this.homeTeam;
    // 골키퍼 배급 지시(짧은 패스~긴 패스)에 따라 단패스 확률을 조절한다.
    const useShortPass = Math.random() < (gkTeam.tactics?.gkShortPassChance ?? 0.35);
    let receiver = null;

    if (useShortPass) {
      // 짧은 패스 지시: 가까이 있으면서 "상대 선수가 가까이 있지 않은" 동료를 고른다.
      // 가장 가까운 상대와의 거리를 크게 가중해, 압박받는 선수에게 주지 않는다.
      const shortRange = gkTeam.tactics?.gkShortRange ?? 26;
      let bestScore = -Infinity;
      for (const p of gkTeam.outfieldPlayers) {
        const dist = p.position.sub(gk.position).length();
        if (dist < 3 || dist > shortRange) continue;
        const nearestOppDist = opponentTeam.players.reduce(
          (m, o) => (o.role === 'GK' ? m : Math.min(m, o.position.sub(p.position).length())),
          Infinity
        );
        // 상대가 8m 안에 있으면 급격히 감점, 완전히 자유로우면 가점
        const safety = Math.min(nearestOppDist, 18) * 6;
        const laneBlocked = opponentTeam.players.some((o) => {
          if (o.role === 'GK') return false;
          const { dist: d, t } = this._segmentDistance(o.position, gk.position, p.position);
          return d < 2.5 && t > 0.1 && t < 0.9;
        });
        const score = safety - dist * 0.6 - (laneBlocked ? 45 : 0);
        if (score > bestScore) { bestScore = score; receiver = p; }
      }
      // 안전한 짧은 패스 상대가 전혀 없으면 길게 처리한다
      if (receiver && bestScore < 25) receiver = null;
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
