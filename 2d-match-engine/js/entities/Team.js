import { Vector2D } from './Vector2D.js';
import { TeamInstructions } from '../tactics/TeamInstructions.js';
import { getFormationPositions, getNormalizedFormationSlots } from '../tactics/Formation.js';

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

    // 전술 변경 지연 적용(감독 지시 전달 시간) 관련 상태
    this._pendingTacticsPatch = null;
    this._tacticsApplyTimer = null;
  }

  /**
   * 감독이 전술을 변경하면 즉시 반영하지 않고 2~5초 뒤에 실제 경기에 적용한다
   * (지시가 그라운드에 전달되는 시간을 흉내낸다). 대기 중 다시 변경하면 최신
   * 값으로 병합하고 지연 타이머를 새로 시작한다.
   */
  applyTacticsChange(patch) {
    this._pendingTacticsPatch = { ...(this._pendingTacticsPatch ?? {}), ...patch };
    if (this._tacticsApplyTimer) clearTimeout(this._tacticsApplyTimer);
    const delayMs = 2000 + Math.random() * 3000;
    this._tacticsApplyTimer = setTimeout(() => {
      Object.assign(this.tactics, this._pendingTacticsPatch);
      this._pendingTacticsPatch = null;
      this._tacticsApplyTimer = null;
    }, delayMs);
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
    const normSlots = getNormalizedFormationSlots(this.formationName);
    this.players.forEach((player, idx) => {
      const slot = slots[idx] ?? slots[slots.length - 1];
      const normSlot = normSlots[idx] ?? normSlots[normSlots.length - 1];
      player.role = slot.role;
      player.basePosition = slot.position.clone();
      player.normalizedBase = new Vector2D(normSlot.nx, normSlot.ny);
    });
  }
}
