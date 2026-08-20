// 새 엔진(js/match/core/MatchState.js)의 Phase 값과 맞춘다.
const PHASE_LABELS = {
  PRE_MATCH: '경기 준비',
  KICKOFF: '킥오프 준비',
  IN_PLAY: '경기 중',
  BALL_OUT: '아웃',
  OFFSIDE: '오프사이드',
  FOUL_STOP: '파울',
  THROW_IN: '스로인 준비',
  CORNER_KICK: '코너킥 준비',
  GOAL_KICK: '골킥 준비',
  DIRECT_FREE_KICK: '직접 프리킥 준비',
  INDIRECT_FREE_KICK: '간접 프리킥 준비',
  PENALTY: '페널티킥 준비',
  GOAL: '득점!',
  HALF_TIME: '하프타임',
  FULL_TIME: '경기 종료',
};

// 새 엔진(js/match/rules/RestartEngine.js)의 restart type 값과 맞춘다.
const RESTART_LABELS = {
  KICKOFF: '킥오프',
  THROW_IN: '스로인',
  CORNER_KICK: '코너킥',
  GOAL_KICK: '골킥',
  DIRECT_FREE_KICK: '직접 프리킥',
  INDIRECT_FREE_KICK: '간접 프리킥',
  PENALTY: '페널티킥',
};

const STAT_LABELS = {
  shots: '슈팅',
  shotsOnTarget: '유효슈팅',
  passes: '패스',
  tackles: '태클',
  fouls: '파울',
  offsides: '오프사이드',
  goalKicks: '골킥',
  corners: '코너킥',
};

/** Canvas 밖 HTML/CSS 기반 UI(스코어보드, 시계, 이벤트 로그)를 갱신하는 역할만 담당한다 */
export class UIManager {
  constructor({ eventBus, homeTeam, awayTeam }) {
    this.homeTeam = homeTeam;
    this.awayTeam = awayTeam;

    this.el = {
      clock: document.getElementById('clock'),
      scoreHome: document.getElementById('scoreHome'),
      scoreAway: document.getElementById('scoreAway'),
      nameHome: document.getElementById('teamNameHome'),
      nameAway: document.getElementById('teamNameAway'),
      phase: document.getElementById('phaseIndicator'),
      possessionHome: document.getElementById('possessionHome'),
      possessionAway: document.getElementById('possessionAway'),
      log: document.getElementById('eventLog'),
      stats: document.getElementById('matchStats'),
    };

    try {
      if (this.el.nameHome) this.el.nameHome.textContent = homeTeam.name;
      if (this.el.nameAway) this.el.nameAway.textContent = awayTeam.name;
    } catch (e) {
      console.warn('UIManager: 팀명 설정 실패', e);
    }

    this.stats = {
      home: { shots: 0, shotsOnTarget: 0, passes: 0, tackles: 0, fouls: 0, offsides: 0, goalKicks: 0, corners: 0 },
      away: { shots: 0, shotsOnTarget: 0, passes: 0, tackles: 0, fouls: 0, offsides: 0, goalKicks: 0, corners: 0 },
    };

    this._initStatsPanel();

    eventBus.on('goal', (e) => {
      this._log(`⚽ 골! ${e.team.name}`);
      // 득점으로 이어진 슛은 항상 유효슈팅이다 (MatchStatistics와 같은 판정 기준)
      this._incStat(e.team, 'shotsOnTarget');
    });
    eventBus.on('shot', (e) => {
      this._log(`슈팅 - ${e.by.name} (${e.team.name})`);
      this._incStat(e.team, 'shots');
    });
    eventBus.on('save', (e) => {
      this._log(e.held ? `🧤 선방! ${e.gk.name}` : `🧤 쳐내기 - ${e.gk.name}`);
      // 슛을 막은 세이브만 유효슈팅으로 집계한다 (루즈볼·크로스 처리는 제외)
      if (e.shot) this._incStat(e.gk.team.opponent, 'shotsOnTarget');
    });
    eventBus.on('restart', (e) => {
      this._log(`${(RESTART_LABELS[e.type] || e.type)} - ${e.team.name}`);
      if (e.type === 'GOAL_KICK') this._incStat(e.team, 'goalKicks');
      if (e.type === 'CORNER_KICK') this._incStat(e.team, 'corners');
    });
    eventBus.on('foul', (e) => {
      this._log(`🟨 파울! 프리킥 - ${e.team.name}`);
      this._incStat(e.team, 'fouls');
    });
    eventBus.on('tackle', (e) => {
      this._log(`태클 성공 - ${e.winner.name}${e.loose ? ' (루즈볼)' : ''}`);
      this._incStat(e.winner.team, 'tackles');
    });
    eventBus.on('offside', (e) => {
      this._log(`🚩 오프사이드 - ${e.player.name} (${e.team.name})`);
      // e.team은 오프사이드를 "범한"(공격) 팀이다 — 그 팀에 집계한다
      this._incStat(e.team, 'offsides');
    });
    eventBus.on('pass', (e) => this._incStat(e.team, 'passes'));
    eventBus.on('halftime', () => this._log('--- 전반 종료 ---'));
    eventBus.on('fulltime', (e) => this._log(`--- 경기 종료 ${e.score.home} : ${e.score.away} ---`));
  }

  _initStatsPanel() {
    try {
      if (!this.el.stats) return;
      const rows = Object.entries(STAT_LABELS).map(([key, label]) => `
        <div class="stat-row" data-key="${key}">
          <span class="stat-label">${label}</span>
          <div class="stat-bar-wrap">
            <span class="stat-value stat-value-home" data-team="home" data-key="${key}">0</span>
            <div class="stat-bar">
              <div class="stat-bar-fill home" data-team="home" data-key="${key}"></div>
              <div class="stat-bar-fill away" data-team="away" data-key="${key}"></div>
            </div>
            <span class="stat-value stat-value-away" data-team="away" data-key="${key}">0</span>
          </div>
        </div>
      `).join('');
      this.el.stats.innerHTML = `
        <div class="stat-header">
          <span class="stat-label"></span>
          <div class="stat-bar-wrap-header">
            <span class="stat-team stat-team-home">${this.homeTeam.name}</span>
            <span class="stat-team stat-team-away">${this.awayTeam.name}</span>
          </div>
        </div>
        ${rows}
      `;
    } catch (e) {
      console.warn('UIManager: 통계 패널 초기화 실패', e);
    }
  }

  _incStat(team, key) {
    try {
      const side = team === this.homeTeam ? 'home' : 'away';
      if (this.stats[side] && this.stats[side][key] !== undefined) {
        this.stats[side][key]++;
        this._updateStatBar(key);
      }
    } catch (e) {
      console.warn('UIManager: 통계 증가 실패', e);
    }
  }

  _updateStatBar(key) {
    try {
      const homeVal = this.stats.home[key] || 0;
      const awayVal = this.stats.away[key] || 0;
      const total = homeVal + awayVal;
      if (total === 0) return;
      const homePct = (homeVal / total) * 100;
      const awayPct = 100 - homePct;

      const homeFill = this.el.stats?.querySelector(`.stat-bar-fill.home[data-key="${key}"]`);
      const awayFill = this.el.stats?.querySelector(`.stat-bar-fill.away[data-key="${key}"]`);
      const homeValEl = this.el.stats?.querySelector(`.stat-value-home[data-key="${key}"]`);
      const awayValEl = this.el.stats?.querySelector(`.stat-value-away[data-key="${key}"]`);

      if (homeFill) homeFill.style.width = `${homePct}%`;
      if (awayFill) awayFill.style.width = `${awayPct}%`;
      if (homeValEl) homeValEl.textContent = homeVal;
      if (awayValEl) awayValEl.textContent = awayVal;
    } catch (e) {
      console.warn('UIManager: 통계 바 업데이트 실패', e);
    }
  }

  _log(message) {
    try {
      const div = document.createElement('div');
      div.className = 'log-entry';
      div.textContent = message;
      this.el.log?.prepend(div);
      while (this.el.log && this.el.log.children.length > 40) {
        this.el.log.removeChild(this.el.log.lastChild);
      }
    } catch (e) {
      console.warn('UIManager: 로그 추가 실패', e);
    }
  }

  update(matchState) {
    try {
      const minute = Math.min(matchState.displayMinute, 90);
      const mm = String(minute).padStart(2, '0');
      const ss = String(matchState.displaySecond).padStart(2, '0');
      if (this.el.clock) this.el.clock.textContent = `${mm}:${ss}`;

      if (this.el.scoreHome) this.el.scoreHome.textContent = matchState.score.home;
      if (this.el.scoreAway) this.el.scoreAway.textContent = matchState.score.away;
      if (this.el.phase) this.el.phase.textContent = PHASE_LABELS[matchState.phase] || matchState.phase;

      const totalPossession = this.homeTeam.possessionSeconds + this.awayTeam.possessionSeconds;
      const homePct = totalPossession > 0 ? Math.round((this.homeTeam.possessionSeconds / totalPossession) * 100) : 50;
      if (this.el.possessionHome) {
        this.el.possessionHome.style.width = `${homePct}%`;
        this.el.possessionHome.textContent = `${homePct}%`;
      }
      if (this.el.possessionAway) {
        this.el.possessionAway.style.width = `${100 - homePct}%`;
        this.el.possessionAway.textContent = `${100 - homePct}%`;
      }
    } catch (e) {
      console.warn('UIManager: update 실패', e);
    }
  }
}
