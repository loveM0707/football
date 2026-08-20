/**
 * main.js — 엔티티 초기화 및 배치
 *
 * 추후 추가 예정:
 *  - PlayerMovement: 선수 이동 로직
 *  - BallMovement: 공 이동 로직
 *  - 양팀 22명 선수 배치
 */
import { Player } from './entities/Player.js';
import { Ball } from './entities/Ball.js';

const layer = document.getElementById('entities-layer');

// 공 — 필드 센터에 배치
const ball = new Ball(525, 340).render(layer);

// 홈팀 선수 — 9번, 센터서클 근처 (약간 왼쪽)
const player = new Player({
    x: 480,
    y: 320,
    team: 'home',
    number: 9,
    angle: 20,  // 공 방향을 향해 약간 기울어짐
}).render(layer);
