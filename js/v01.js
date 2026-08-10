const canvas = document.getElementById('field');
const ctx = canvas.getContext('2d');
const btnPlay = document.getElementById('btnPlay');
const btnReset = document.getElementById('btnReset');
const statusText = document.getElementById('status');

let isRunning = true;

// 공 객체
const ball = {
  x: canvas.width / 2,
  y: canvas.height / 2,
  vx: 0,
  vy: 0,
  radius: 5,
  color: '#ffffff',
  owner: null
};

// 포메이션 좌표 (상대 좌표 0~1)
const homeFormation = [
  { x: 0.05, y: 0.5, pos: 'GK' },
  { x: 0.2, y: 0.2, pos: 'LB' }, { x: 0.2, y: 0.4, pos: 'CB' }, { x: 0.2, y: 0.6, pos: 'CB' }, { x: 0.2, y: 0.8, pos: 'RB' },
  { x: 0.35, y: 0.2, pos: 'LM' }, { x: 0.35, y: 0.4, pos: 'CM' }, { x: 0.35, y: 0.6, pos: 'CM' }, { x: 0.35, y: 0.8, pos: 'RM' },
  { x: 0.45, y: 0.35, pos: 'ST' }, { x: 0.45, y: 0.65, pos: 'ST' }
];

const awayFormation = [
  { x: 0.95, y: 0.5, pos: 'GK' },
  { x: 0.8, y: 0.2, pos: 'RB' }, { x: 0.8, y: 0.4, pos: 'CB' }, { x: 0.8, y: 0.6, pos: 'CB' }, { x: 0.8, y: 0.8, pos: 'LB' },
  { x: 0.65, y: 0.2, pos: 'RM' }, { x: 0.65, y: 0.4, pos: 'CM' }, { x: 0.65, y: 0.6, pos: 'CM' }, { x: 0.65, y: 0.8, pos: 'LM' },
  { x: 0.55, y: 0.35, pos: 'ST' }, { x: 0.55, y: 0.65, pos: 'ST' }
];

const players = [];

class Player {
  constructor(id, team, baseX, baseY, number, color) {
    this.id = id;
    this.team = team;
    this.baseX = baseX;
    this.baseY = baseY;
    this.x = baseX;
    this.y = baseY;
    this.number = number;
    this.color = color;
    this.radius = 10;
    this.speed = 1.8 + Math.random() * 0.4;
  }

  update() {
    const dx = ball.x - this.x;
    const dy = ball.y - this.y;
    const distToBall = Math.hypot(dx, dy);

    let targetX = this.baseX;
    let targetY = this.baseY;

    if (distToBall < 150) {
      targetX = ball.x;
      targetY = ball.y;
    }

    if (distToBall < this.radius + ball.radius) {
      const angle = Math.atan2(dy, dx) + (Math.random() - 0.5);
      const force = 4 + Math.random() * 4;
      ball.vx = Math.cos(angle) * force;
      ball.vy = Math.sin(angle) * force;
    }

    const moveDx = targetX - this.x;
    const moveDy = targetY - this.y;
    const moveDist = Math.hypot(moveDx, moveDy);

    if (moveDist > 2) {
      this.x += (moveDx / moveDist) * this.speed;
      this.y += (moveDy / moveDist) * this.speed;
    }
  }

  draw() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.number, this.x, this.y);
  }
}

function init() {
  players.length = 0;

  homeFormation.forEach((f, idx) => {
    const x = f.x * canvas.width;
    const y = f.y * canvas.height;
    players.push(new Player(idx, 'home', x, y, idx + 1, '#d32f2f'));
  });

  awayFormation.forEach((f, idx) => {
    const x = f.x * canvas.width;
    const y = f.y * canvas.height;
    players.push(new Player(idx + 11, 'away', x, y, idx + 1, '#1976d2'));
  });

  ball.x = canvas.width / 2;
  ball.y = canvas.height / 2;
  ball.vx = (Math.random() - 0.5) * 6;
  ball.vy = (Math.random() - 0.5) * 6;
}

function updateBall() {
  ball.x += ball.vx;
  ball.y += ball.vy;

  ball.vx *= 0.98;
  ball.vy *= 0.98;

  if (ball.x < 10 || ball.x > canvas.width - 10) ball.vx *= -1;
  if (ball.y < 10 || ball.y > canvas.height - 10) ball.vy *= -1;
}

function drawField() {
  const margin = 25; // 경기장 테두리 여백
  const pitchW = canvas.width - margin * 2;
  const pitchH = canvas.height - margin * 2;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  // 1. 잔디 줄무늬 배경 (FM 스타일 교차 패턴)
  const numStripes = 10;
  const stripeWidth = pitchW / numStripes;
  const darkGreen = '#317327';
  const lightGreen = '#38832c';

  ctx.fillStyle = darkGreen;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < numStripes; i++) {
    if (i % 2 === 0) {
      ctx.fillStyle = lightGreen;
      ctx.fillRect(margin + i * stripeWidth, margin, stripeWidth, pitchH);
    }
  }

  // 2. 라인 스타일 설정
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.lineWidth = 2;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';

  // 터치라인 & 골라인
  ctx.strokeRect(margin, margin, pitchW, pitchH);

  // 하프라인
  ctx.beginPath();
  ctx.moveTo(centerX, margin);
  ctx.lineTo(centerX, canvas.height - margin);
  ctx.stroke();

  // 센터 서클 & 센터 스팟
  const centerRadius = 55;
  ctx.beginPath();
  ctx.arc(centerX, centerY, centerRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(centerX, centerY, 3, 0, Math.PI * 2);
  ctx.fill();

  // 페널티 박스, 골 박스 규격
  const pBoxW = 120;
  const pBoxH = 220;
  const gBoxW = 40;
  const gBoxH = 100;
  const pSpotDist = 80;

  // --- 페널티 아크 각도 정밀 계산 ---
  // 페널티 스팟에서 페널티 박스 선까지의 거리는 (pBoxW - pSpotDist)
  // cos(각도) = 밑변 / 반지름 (centerRadius)
  const distToLine = pBoxW - pSpotDist; // 120 - 80 = 40
  const arcAngle = Math.acos(distToLine / centerRadius); // 선과 원이 만나는 수학적 시작 각도

  // --- 좌측 (홈) 영역 ---
  ctx.strokeRect(margin, centerY - pBoxH / 2, pBoxW, pBoxH);
  ctx.strokeRect(margin, centerY - gBoxH / 2, gBoxW, gBoxH);
  
  // 좌측 페널티 스팟
  ctx.beginPath();
  ctx.arc(margin + pSpotDist, centerY, 2.5, 0, Math.PI * 2);
  ctx.fill();
  
  // 좌측 페널티 아크 (라인과 완전 밀착)
  ctx.beginPath();
  ctx.arc(margin + pSpotDist, centerY, centerRadius, -arcAngle, arcAngle);
  ctx.stroke();

  // --- 우측 (원정) 영역 ---
  ctx.strokeRect(canvas.width - margin - pBoxW, centerY - pBoxH / 2, pBoxW, pBoxH);
  ctx.strokeRect(canvas.width - margin - gBoxW, centerY - gBoxH / 2, gBoxW, gBoxH);
  
  // 우측 페널티 스팟
  ctx.beginPath();
  ctx.arc(canvas.width - margin - pSpotDist, centerY, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // 우측 페널티 아크 (라인과 완전 밀착)
  ctx.beginPath();
  ctx.arc(canvas.width - margin - pSpotDist, centerY, centerRadius, Math.PI - arcAngle, Math.PI + arcAngle);
  ctx.stroke();

  // --- 코너킥 아크 (4개 모퉁이) ---
  const cornerR = 12;
  ctx.beginPath(); ctx.arc(margin, margin, cornerR, 0, Math.PI / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(margin, canvas.height - margin, cornerR, -Math.PI / 2, 0); ctx.stroke();
  ctx.beginPath(); ctx.arc(canvas.width - margin, margin, cornerR, Math.PI / 2, Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.arc(canvas.width - margin, canvas.height - margin, cornerR, Math.PI, -Math.PI / 2); ctx.stroke();

  // --- 골대 그물 연출 ---
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  const goalH = 60;
  const goalDepth = 12;
  ctx.strokeRect(margin - goalDepth, centerY - goalH / 2, goalDepth, goalH);
  ctx.strokeRect(canvas.width - margin, centerY - goalH / 2, goalDepth, goalH);
}

function drawBall() {
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
  ctx.fillStyle = ball.color;
  ctx.fill();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function loop() {
  if (isRunning) {
    updateBall();
    players.forEach(p => p.update());
  }

  drawField();
  players.forEach(p => p.draw());
  drawBall();

  requestAnimationFrame(loop);
}

btnPlay.addEventListener('click', () => {
  isRunning = !isRunning;
  btnPlay.textContent = isRunning ? '일시정지' : '재생';
  statusText.textContent = isRunning ? '상태: 경기 진행 중' : '상태: 일시정지됨';
});

btnReset.addEventListener('click', () => {
  init();
});

init();
loop();
