import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

/**
 * 포메이션 좌표는 "홈팀이 오른쪽(x=1)을 공격한다"는 기준의 정규화 좌표(x,y: 0~1)다.
 * away 팀(왼쪽 공격)에는 x를 1-x로 뒤집어 적용한다. y는 0(위쪽 터치라인)~1(아래쪽 터치라인).
 */
const FORMATIONS = {
  '4-4-2': [
    { role: 'GK', x: 0.06, y: 0.5 },
    { role: 'LB', x: 0.2, y: 0.15 },
    { role: 'CB', x: 0.16, y: 0.38 },
    { role: 'CB', x: 0.16, y: 0.62 },
    { role: 'RB', x: 0.2, y: 0.85 },
    { role: 'LM', x: 0.45, y: 0.15 },
    { role: 'CM', x: 0.4, y: 0.4 },
    { role: 'CM', x: 0.4, y: 0.6 },
    { role: 'RM', x: 0.45, y: 0.85 },
    { role: 'ST', x: 0.68, y: 0.4 },
    { role: 'ST', x: 0.68, y: 0.6 },
  ],
  '4-3-3': [
    { role: 'GK', x: 0.06, y: 0.5 },
    { role: 'LB', x: 0.2, y: 0.15 },
    { role: 'CB', x: 0.16, y: 0.38 },
    { role: 'CB', x: 0.16, y: 0.62 },
    { role: 'RB', x: 0.2, y: 0.85 },
    { role: 'CM', x: 0.38, y: 0.3 },
    { role: 'CM', x: 0.34, y: 0.5 },
    { role: 'CM', x: 0.38, y: 0.7 },
    { role: 'LM', x: 0.65, y: 0.18 },
    { role: 'ST', x: 0.72, y: 0.5 },
    { role: 'RM', x: 0.65, y: 0.82 },
  ],
  '4-2-3-1': [
    { role: 'GK', x: 0.06, y: 0.5 },
    { role: 'LB', x: 0.2, y: 0.15 },
    { role: 'CB', x: 0.16, y: 0.38 },
    { role: 'CB', x: 0.16, y: 0.62 },
    { role: 'RB', x: 0.2, y: 0.85 },
    { role: 'CM', x: 0.34, y: 0.4 },
    { role: 'CM', x: 0.34, y: 0.6 },
    { role: 'LM', x: 0.55, y: 0.2 },
    { role: 'CM', x: 0.58, y: 0.5 },
    { role: 'RM', x: 0.55, y: 0.8 },
    { role: 'ST', x: 0.75, y: 0.5 },
  ],
};

export const FORMATION_NAMES = Object.keys(FORMATIONS);

/**
 * @returns {Array<{role:string, position:Vector2D}>} 실제 경기장 미터 좌표
 */
export function getFormationPositions(name, side) {
  const template = FORMATIONS[name] ?? FORMATIONS['4-4-2'];
  return template.map((slot) => {
    const nx = side === 'home' ? slot.x : 1 - slot.x;
    return {
      role: slot.role,
      position: new Vector2D(nx * Pitch.LENGTH, slot.y * Pitch.WIDTH),
    };
  });
}
