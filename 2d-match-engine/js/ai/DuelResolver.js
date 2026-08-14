/**
 * 두 선수가 경합할 때(태클 vs 드리블) 능력치와 난수를 기반으로 승자를 결정한다.
 * 로지스틱 함수로 능력치 차이를 0~1 확률로 매핑한다.
 */
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export const DuelResolver = {
  /** 볼 소유자가 충돌 시 공을 지킬 확률 (0~1) */
  computeShieldChance(holder, challenger) {
    const holderStr = holder.attributes.strength ?? holder.attributes.power ?? 70;
    const holderDrib = holder.attributes.dribbling ?? 70;
    const holderAgility = holder.attributes.agility ?? 70;
    const shieldScore = holderDrib * 0.40 + holderStr * 0.40 + holderAgility * 0.20;
    const challPower = challenger.attributes.power ?? challenger.attributes.strength ?? 70;
    const challTackle =
      (challenger.attributes.tackling ?? 60) * 0.55 +
      (challenger.attributes.interception ?? challenger.attributes.positioning ?? 60) * 0.15 +
      (challenger.attributes.positioning ?? 60) * 0.15 +
      challPower * 0.15;
    const staminaFactor = 0.7 + 0.3 * (holder.stamina / 100);
    return sigmoid((shieldScore * staminaFactor - challTackle) / 18);
  },

  /** 공중볼 경합: jumping 능력치 기반으로 헤딩 승자 결정 */
  resolveAerialDuel(player1, player2) {
    const j1 = player1.attributes.jumping ?? 65;
    const j2 = player2.attributes.jumping ?? 65;
    const p = sigmoid((j1 - j2 + (Math.random() - 0.5) * 16) / 14);
    return Math.random() < p ? player1 : player2;
  },

  /** @returns {Player} 태클을 시도하는 challenger 또는 공을 지키는 holder 중 승자 */
  resolveTackle(challenger, holder) {
    const power = challenger.attributes.power ?? challenger.attributes.strength;
    const tackleSkill =
      challenger.attributes.tackling * 0.55 +
      (challenger.attributes.interception ?? challenger.attributes.positioning) * 0.15 +
      challenger.attributes.positioning * 0.15 +
      power * 0.15;
    const agility = holder.attributes.agility ?? holder.attributes.acceleration;
    const holderPower = holder.attributes.power ?? holder.attributes.strength;
    const defend =
      holder.attributes.dribbling * 0.55 +
      agility * 0.2 +
      holderPower * 0.25;
    const staminaFactor = 0.7 + 0.3 * (challenger.stamina / 100);
    // divisor를 22로 높여 시그모이드를 완만하게 → 능력치 차이가 크지 않으면 드리블러 생존 확률 상승
    // holder에 +6 보너스: 드리블 중 움직임으로 얻는 물리적 이점 반영
    const p = sigmoid((tackleSkill * staminaFactor - (defend + 6)) / 22);
    return Math.random() < p ? challenger : holder;
  },
};
