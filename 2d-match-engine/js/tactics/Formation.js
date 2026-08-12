import { Vector2D } from '../entities/Vector2D.js';
import { Pitch } from '../entities/Pitch.js';

/**
 * 포메이션 좌표는 "홈팀이 오른쪽(x=1)을 공격한다"는 기준의 정규화 좌표(x,y: 0~1)다.
 * away 팀(왼쪽 공격)에는 x를 1-x로 뒤집어 적용한다. y는 0(위쪽 터치라인)~1(아래쪽 터치라인).
 * 모든 x는 0.46 이하로 제한해, 킥오프 시 양팀 선수 전원이 하프라인(0.5)을 넘지 않도록 한다.
 */
const FORMATIONS = {
  '4-4-2': [
    { role: 'GK', x: 0.05, y: 0.5 },
    { role: 'LB', x: 0.16, y: 0.15 },
    { role: 'CB', x: 0.13, y: 0.38 },
    { role: 'CB', x: 0.13, y: 0.62 },
    { role: 'RB', x: 0.16, y: 0.85 },
    { role: 'LM', x: 0.32, y: 0.15 },
    { role: 'CM', x: 0.28, y: 0.4 },
    { role: 'CM', x: 0.28, y: 0.6 },
    { role: 'RM', x: 0.32, y: 0.85 },
    { role: 'ST', x: 0.45, y: 0.4 },
    { role: 'ST', x: 0.45, y: 0.6 },
  ],
  '4-3-3': [
    { role: 'GK', x: 0.05, y: 0.5 },
    { role: 'LB', x: 0.16, y: 0.15 },
    { role: 'CB', x: 0.13, y: 0.38 },
    { role: 'CB', x: 0.13, y: 0.62 },
    { role: 'RB', x: 0.16, y: 0.85 },
    { role: 'CM', x: 0.27, y: 0.3 },
    { role: 'CM', x: 0.24, y: 0.5 },
    { role: 'CM', x: 0.27, y: 0.7 },
    { role: 'LM', x: 0.43, y: 0.18 },
    { role: 'ST', x: 0.46, y: 0.5 },
    { role: 'RM', x: 0.43, y: 0.82 },
  ],
  '4-2-3-1': [
    { role: 'GK', x: 0.05, y: 0.5 },
    { role: 'LB', x: 0.16, y: 0.15 },
    { role: 'CB', x: 0.13, y: 0.38 },
    { role: 'CB', x: 0.13, y: 0.62 },
    { role: 'RB', x: 0.16, y: 0.85 },
    { role: 'CM', x: 0.24, y: 0.4 },
    { role: 'CM', x: 0.24, y: 0.6 },
    { role: 'LM', x: 0.38, y: 0.2 },
    { role: 'CM', x: 0.4, y: 0.5 },
    { role: 'RM', x: 0.38, y: 0.8 },
    { role: 'ST', x: 0.46, y: 0.5 },
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

/**
 * 정규화된 좌표(0~1)를 그대로 반환한다. x=0은 자기 골문, x=1은 상대 골문.
 * @returns {Array<{role:string, nx:number, ny:number}>}
 */
export function getNormalizedFormationSlots(name) {
  const template = FORMATIONS[name] ?? FORMATIONS['4-4-2'];
  return template.map((slot) => ({
    role: slot.role,
    nx: slot.x,
    ny: slot.y,
  }));
}
