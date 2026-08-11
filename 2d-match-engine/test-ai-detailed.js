const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--headless=new'],
    headless: false,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:8843/index.html', { waitUntil: 'load' });

  // 6x 배속 (90분 경기 = ~60초)
  await page.selectOption('#speedSelect', '6');

  console.log('\n========== AI 개선사항 상세 분석 ==========\n');

  // 매 샘플링마다 선수 위치 추적
  const samples = [];
  const eventLog = [];

  await page.evaluate(() => {
    const { simulator } = window.__match;
    window.__events = { passes: [], shots: [], goals: [] };

    simulator.eventBus.on('pass', (e) => window.__events.passes.push(e.from.role + ' → ' + e.to.role));
    simulator.eventBus.on('shot', (e) => window.__events.shots.push(e.by.role));
    simulator.eventBus.on('goal', (e) => window.__events.goals.push(e.team.name));
  });

  // 10초마다 샘플링
  for (let i = 0; i < 9; i++) {
    await page.waitForTimeout(10000);
    const sample = await page.evaluate(() => {
      const { simulator, homeTeam, awayTeam } = window.__match;
      const homeOF = homeTeam.outfieldPlayers.map(p => p.position.x);
      const awayOF = awayTeam.outfieldPlayers.map(p => p.position.x);

      return {
        time: `${simulator.matchState.displayMinute}:${Math.floor(simulator.matchState.displaySecond)}`,
        homeAvgX: Math.round(homeOF.reduce((a,b) => a+b) / homeOF.length),
        awayAvgX: Math.round(awayOF.reduce((a,b) => a+b) / awayOF.length),
        score: simulator.matchState.score,
        phase: simulator.matchState.phase,
        passes: window.__events.passes.length,
        shots: window.__events.shots.length,
      };
    });
    samples.push(sample);
    console.log(`[${sample.time}] Home avg X: ${sample.homeAvgX}m, Away avg X: ${sample.awayAvgX}m | Passes: ${sample.passes}, Shots: ${sample.shots} | Score: ${sample.score.home}-${sample.score.away}`);
  }

  // 경기 종료까지 대기 또는 타임아웃
  await page.waitForTimeout(60000);

  const finalData = await page.evaluate(() => {
    const { simulator, homeTeam, awayTeam } = window.__match;
    const homeOF = homeTeam.outfieldPlayers.map(p => p.position.x);
    const awayOF = awayTeam.outfieldPlayers.map(p => p.position.x);

    return {
      clock: `${simulator.matchState.displayMinute}:${Math.floor(simulator.matchState.displaySecond)}`,
      score: simulator.matchState.score,
      passes: window.__events.passes.length,
      shots: window.__events.shots.length,
      goals: window.__events.goals.length,
      homeAvgX: Math.round(homeOF.reduce((a,b) => a+b) / homeOF.length),
      awayAvgX: Math.round(awayOF.reduce((a,b) => a+b) / awayOF.length),
      passLog: window.__events.passes.slice(0, 20),
      shotLog: window.__events.shots.slice(0, 10),
    };
  });

  console.log(`\n========== 최종 결과 ==========`);
  console.log(`경기 시간: ${finalData.clock}`);
  console.log(`최종 스코어: ${finalData.score.home} - ${finalData.score.away}`);
  console.log(`\n📊 공격 플레이 통계:`);
  console.log(`  패스: ${finalData.passes}회`);
  console.log(`  슈팅: ${finalData.shots}회`);
  console.log(`  골: ${finalData.goals}회`);
  console.log(`\n🎯 진영 분석:`);
  console.log(`  홈팀 평균 X: ${finalData.homeAvgX}m`);
  console.log(`  어웨이팀 평균 X: ${finalData.awayAvgX}m`);
  console.log(`\n📋 초기 패스 시퀀스 (처음 20회):`);
  finalData.passLog.slice(0, 10).forEach((p, i) => console.log(`  ${i+1}. ${p}`));

  if (finalData.shots > 0) {
    console.log(`\n🎯 슈팅 기록:`);
    finalData.shotLog.forEach((role, i) => console.log(`  ${i+1}. ${role}이 슈팅`));
  } else {
    console.log(`\n⚠️  슈팅 기록 없음 - 공격 범위가 부족하거나 패스 중심 플레이`);
  }

  await browser.close();
})();
