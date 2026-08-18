/**
 * 두 선수가 경합할 때(태클 vs 드리블, 실딩, 공중볼) 능력치, 각도, 속도, 체력 및 난수를 기반으로 승자를 결정한다.
 * 로지스틱 함수로 능력치 차이를 0~1 확률로 매핑한다.
 */
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export const DuelResolver = {
  /** 볼 소유자가 충돌/압박 시 공을 지킬 확률 (0~1) */
  computeShieldChance(holder, challenger) {
    const holderStr = holder.attributes.strength ?? holder.attributes.power ?? 70;
    const holderDrib = holder.attributes.dribbling ?? 70;
    const holderAgility = holder.attributes.agility ?? 70;
    const holderBalance = holder.attributes.agility ?? 70;
    const shieldScore = holderDrib * 0.35 + holderStr * 0.35 + holderAgility * 0.15 + holderBalance * 0.15;

    const challPower = challenger.attributes.power ?? challenger.attributes.strength ?? 70;
    const challTackle =
      (challenger.attributes.tackling ?? 60) * 0.50 +
      (challenger.attributes.interception ?? challenger.attributes.positioning ?? 60) * 0.15 +
      (challenger.attributes.positioning ?? 60) * 0.15 +
      challPower * 0.20;

    const staminaFactor = 0.75 + 0.25 * (holder.stamina / 100);
    const challStaminaFactor = 0.75 + 0.25 * (challenger.stamina / 100);

    return sigmoid((shieldScore * staminaFactor - challTackle * challStaminaFactor + 4) / 16);
  },

  /** 공중볼 경합: jumping 능력치 기반으로 헤딩 승자 결정 (favored = 패스 수신자 우대) */
  resolveAerialDuel(player1, player2, favored = null) {
    const j1 = player1.attributes.jumping ?? 65;
    const j2 = player2.attributes.jumping ?? 65;
    const s1 = player1.attributes.strength ?? 65;
    const s2 = player2.attributes.strength ?? 65;
    // 패스 수신자는 타이밍을 맞춰 뛰어오르므로 경합 우위를 부여 —
    // 로빙 스루패스/크로스가 헤딩 경합에서 더 자주 연결된다
    const FAVORED_BONUS = 6;
    const score1 = j1 * 0.7 + s1 * 0.3 + (favored === player1 ? FAVORED_BONUS : 0);
    const score2 = j2 * 0.7 + s2 * 0.3 + (favored === player2 ? FAVORED_BONUS : 0);
    // 랜덤 노이즈 축소(±7 → ±5): 능력치 우위가 결과에 더 잘 반영된다
    const p = sigmoid((score1 - score2 + (Math.random() - 0.5) * 10) / 14);
    return Math.random() < p ? player1 : player2;
  },

  /**
   * 충돌 및 태클 시 드리블 경합 상세 판정
   * @param {Player} challenger 수비수
   * @param {Player} holder 공을 소유한 공격수
   * @param {Ball} ball
   * @returns {{
   *   winner: Player,
   *   outcome: 'DRIBBLE_BEAT'|'DRIBBLE_SHIELD'|'DISPOSSESSED'|'LOOSE_BALL'|'FOUL',
   *   escapeDir: Vector2D|null,
   *   foul: boolean,
   *   loose: boolean
   * }}
   */
  resolveDribbleDuel(challenger, holder, ball = null) {
    const holderAttrs = holder.attributes;
    const challAttrs = challenger.attributes;

    // 공격수 능력치: 드리블, 민첩성, 가속도, 힘, 밸런스
    const dribbling = holderAttrs.dribbling ?? 70;
    const agility = holderAttrs.agility ?? holderAttrs.acceleration ?? 70;
    const accel = holderAttrs.acceleration ?? holderAttrs.pace ?? 70;
    const pace = holderAttrs.pace ?? 70;
    const holderStr = holderAttrs.strength ?? holderAttrs.power ?? 70;
    const holderBalance = holderAttrs.agility ?? holderStr;
    const holderDecision = holderAttrs.decisionMaking ?? 70;

    // 수비수 능력치: 태클, 힘, 위치선정, 인터셉트, 가속도
    const tackling = challAttrs.tackling ?? 70;
    const challStr = challAttrs.strength ?? challAttrs.power ?? 70;
    const positioning = challAttrs.positioning ?? 70;
    const interception = challAttrs.interception ?? positioning;
    const challAgility = challAttrs.agility ?? 65;

    // 스태미나 팩터
    const holderStamina = 0.8 + 0.2 * (holder.stamina / 100);
    const challStamina = 0.8 + 0.2 * (challenger.stamina / 100);

    // ── 축구 물리 및 상황 분석 ──
    // 1. 상대 각도 및 바디 포지셔닝:
    //    공격수 진행 방향과 수비수 위치 사이의 관계.
    //    수비수가 공격수 뒤나 옆에 있으면 공격수가 등을 지거나(Shielding) 쳐놓고 달리기 유리.
    const toChallenger = challenger.position.sub(holder.position);
    const dist = Math.max(0.1, toChallenger.length());
    const dirToChallenger = toChallenger.scale(1 / dist);

    // 공격수가 바라보는 방향 (또는 이동 방향)
    const holderSpeed = holder.velocity.length();
    const holderDir = holderSpeed > 0.5
      ? holder.velocity.scale(1 / holderSpeed)
      : { x: Math.cos(holder.facingAngle), y: Math.sin(holder.facingAngle) };

    // dot > 0.5: 정면 충돌, dot < -0.3: 뒤에서 태클/압박, dot ≈ 0: 측면 어깨싸움
    const angleDot = holderDir.x * dirToChallenger.x + holderDir.y * dirToChallenger.y;

    // 뒤나 옆에서 압박해올 때 등지기(Shield) 보너스 (+8~+14)
    let bodyPositionBonus = 0;
    if (angleDot < 0.2) {
      // 수비수가 측면 또는 후방에 위치: 드리블러가 몸으로 공을 가리기 쉬움
      bodyPositionBonus = (0.2 - angleDot) * 10;
    } else {
      // 정면 충돌: 기술적인 드리블(알까기, 페인트, 넉온) 또는 수비수의 정면 태클 경합
      bodyPositionBonus = -2;
    }

    // 모멘텀 팩터 (스피드가 붙은 드리블러는 수비수를 스피드로 제치기 유리)
    const speedAdvantage = clamp((holderSpeed - challenger.velocity.length()) * 2.5, -6, 8);

    // ── 점수 산출 ──
    // 드리블러 총 스코어 (드리블 돌파형 스코어 + 피지컬 실딩 스코어)
    const dribbleScore =
      (dribbling * 0.40 + agility * 0.25 + accel * 0.15 + holderStr * 0.15 + holderDecision * 0.05) * holderStamina +
      bodyPositionBonus +
      speedAdvantage +
      8; // 드리블러 기본 이점 (공을 먼저 쥐고 주도권을 가짐)

    // 수비수 태클 스코어 — 팀 전술(태클: 신중하게~헌신적)에 따라 소폭 가감된다.
    // 헌신적일수록 더 과감하게 발을 뻗어 성공 시도가 늘지만, 그만큼 파울 위험도 커진다.
    const tackleCommitBonus = challenger.team?.tactics?.tackleCommitBonus ?? 0;
    const tackleFoulMul = challenger.team?.tactics?.tackleFoulRiskMultiplier ?? 1.0;
    const tackleScore =
      (tackling * 0.45 + challStr * 0.22 + positioning * 0.15 + interception * 0.10 + challAgility * 0.08) * challStamina +
      tackleCommitBonus;

    // 승리 확률 계산 (Logistic Sigmoid)
    // pTackle: 수비수가 태클/볼 탈취에 성공할 확률
    const diff = tackleScore - dribbleScore;
    const pTackle = sigmoid(diff / 18);

    const roll = Math.random();

    // ── 수비수 파울 확률 계산 ──
    // 뒤에서 무리하게 태클하거나, 공격수가 빠른데 수비수 태클 능력이 낮을 때 파울 증가
    const foulRisk = clamp(
      (0.04 + (1 - tackling / 100) * 0.08 + (angleDot < -0.2 ? 0.06 : 0) + (challStr > holderStr + 15 ? 0.03 : 0)) * tackleFoulMul,
      0.02,
      0.30
    );

    if (roll < pTackle) {
      // ── 수비수 승리 (볼 탈취 or 루즈볼 or 파울) ──
      if (Math.random() < foulRisk) {
        return {
          winner: holder,
          outcome: 'FOUL',
          escapeDir: null,
          foul: true,
          loose: false,
        };
      }

      // 깔끔한 탈취(Dispossessed) vs 튕겨나가는 루즈볼(Loose Ball)
      const cleanTackleChance = 0.50 + (tackling / 100) * 0.35 - (holderStr / 100) * 0.15;
      if (Math.random() < cleanTackleChance) {
        return {
          winner: challenger,
          outcome: 'DISPOSSESSED',
          escapeDir: null,
          foul: false,
          loose: false,
        };
      } else {
        return {
          winner: challenger,
          outcome: 'LOOSE_BALL',
          escapeDir: null,
          foul: false,
          loose: true,
        };
      }
    } else {
      // ── 공격수 승리 (드리블 성공: 돌파 or 실딩) ──
      // 민첩/스피드 비율이 높으면 DRIBBLE_BEAT(제치고 돌파), 피지컬/힘 비율이 높으면 DRIBBLE_SHIELD(등지고 지키기)
      const beatWeight = dribbling * 0.5 + agility * 0.3 + accel * 0.2;
      const shieldWeight = holderStr * 0.55 + dribbling * 0.3 + holderBalance * 0.15;

      // 수비수를 회피할 탈출 방향 계산 (수비수 반대 방향 + 전진 방향의 조합)
      const escapeX = -dirToChallenger.y * (Math.random() > 0.5 ? 1 : -1) * 0.6 + holderDir.x * 0.8;
      const escapeY = dirToChallenger.x * (Math.random() > 0.5 ? 1 : -1) * 0.6 + holderDir.y * 0.8;
      const escapeLen = Math.hypot(escapeX, escapeY) || 1;
      const escapeDir = { x: escapeX / escapeLen, y: escapeY / escapeLen };

      if (beatWeight >= shieldWeight || Math.random() < 0.55) {
        return {
          winner: holder,
          outcome: 'DRIBBLE_BEAT',
          escapeDir,
          foul: false,
          loose: false,
        };
      } else {
        return {
          winner: holder,
          outcome: 'DRIBBLE_SHIELD',
          escapeDir,
          foul: false,
          loose: false,
        };
      }
    }
  },

  /** 기존 코드 호환용 래퍼: @returns {Player} 태클을 시도하는 challenger 또는 공을 지키는 holder 중 승자 */
  resolveTackle(challenger, holder, ball = null) {
    const duelResult = this.resolveDribbleDuel(challenger, holder, ball);
    return duelResult.winner;
  },
};

