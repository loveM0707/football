import { TeamInstructions } from '../tactics/TeamInstructions.js';
import { getFormationPositions } from '../tactics/Formation.js';

export class Team {
  constructor({ name, side, color, formationName = '4-4-2', players, tacticsOptions = {} }) {
    this.name = name;
    this.side = side; // 'home' | 'away'
    this.color = color;
    this.formationName = formationName;
    this.players = players; // Player[] (11명)
    this.players.forEach((p) => (p.team = this));

    // side==='home' -> 오른쪽(x 증가) 공격, side==='away' -> 왼쪽(x 감소) 공격
    this.attackingDirection = side === 'home' ? 1 : -1;
    this.tactics = new TeamInstructions(tacticsOptions);

    this.score = 0;
    this.possessionSeconds = 0;
  }

  get goalkeeper() {
    return this.players.find((p) => p.role === 'GK');
  }

  get outfieldPlayers() {
    return this.players.filter((p) => p.role !== 'GK');
  }

  /** 하프타임에 공격 방향을 반전시킨다 */
  flipAttackingDirection() {
    this.attackingDirection *= -1;
  }

  /** 현재 공격 방향 기준 포메이션 기준 위치(base position)를 재계산해 선수에 반영 */
  applyFormationBasePositions() {
    const effectiveSide = this.attackingDirection === 1 ? 'home' : 'away';
    const slots = getFormationPositions(this.formationName, effectiveSide);
    this.players.forEach((player, idx) => {
      const slot = slots[idx] ?? slots[slots.length - 1];
      player.role = slot.role;
      player.basePosition = slot.position.clone();
    });
  }
}
