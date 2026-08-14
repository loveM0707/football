/**
 * 두 선수가 경합할 때(태클 vs 드리블) 능력치와 난수를 기반으로 승자를 결정한다.
 * 로지스틱 함수로 능력치 차이를 0~1 확률로 매핑한다.
 */
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export const DuelResolver = {
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
