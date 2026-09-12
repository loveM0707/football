-- K리그 경량 DB 스키마 (§26-§31). cards 테이블 없음(§31).
-- 운영 DB는 빈 상태에서 초기화한다(§1, §45).
PRAGMA foreign_keys = ON;

CREATE TABLE seasons (
    id      INTEGER PRIMARY KEY,
    year    INTEGER NOT NULL UNIQUE,
    name    TEXT NOT NULL
);

CREATE TABLE competitions (
    id          INTEGER PRIMARY KEY,
    season_id   INTEGER NOT NULL REFERENCES seasons(id),
    code        TEXT NOT NULL,
    name        TEXT NOT NULL,
    UNIQUE (season_id, code)
);

CREATE TABLE rounds (
    id              INTEGER PRIMARY KEY,
    season_id       INTEGER NOT NULL REFERENCES seasons(id),
    competition_id  INTEGER NOT NULL REFERENCES competitions(id),
    round_number    INTEGER NOT NULL,
    UNIQUE (season_id, competition_id, round_number)
);

CREATE TABLE teams (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    short_name  TEXT
);

CREATE TABLE stadiums (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE
);

CREATE TABLE players (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    name_en     TEXT,
    birth_date  TEXT,
    nationality TEXT,
    position    TEXT,
    height_cm   INTEGER,
    weight_kg   INTEGER
);
CREATE INDEX idx_players_name ON players(name);

CREATE TABLE matches (
    id              INTEGER PRIMARY KEY,
    season_id       INTEGER NOT NULL REFERENCES seasons(id),
    competition_id  INTEGER NOT NULL REFERENCES competitions(id),
    round_id        INTEGER NOT NULL REFERENCES rounds(id),
    match_date      TEXT NOT NULL,
    kickoff_time    TEXT,
    stadium_id      INTEGER REFERENCES stadiums(id),
    attendance      INTEGER,
    home_team_id    INTEGER NOT NULL REFERENCES teams(id),
    away_team_id    INTEGER NOT NULL REFERENCES teams(id),
    home_score      INTEGER NOT NULL,
    away_score      INTEGER NOT NULL,
    home_ht_score   INTEGER,
    away_ht_score   INTEGER,
    motm_player_id  INTEGER REFERENCES players(id),
    CHECK (home_team_id != away_team_id),
    CHECK (home_score >= 0 AND away_score >= 0),
    UNIQUE (round_id, home_team_id, away_team_id)
);
CREATE INDEX idx_matches_round ON matches(round_id);
CREATE INDEX idx_matches_teams ON matches(home_team_id, away_team_id);

CREATE TABLE match_player_records (
    id                      INTEGER PRIMARY KEY,
    match_id                INTEGER NOT NULL REFERENCES matches(id)
                            ON DELETE CASCADE,
    player_id               INTEGER NOT NULL REFERENCES players(id),
    team_id                 INTEGER NOT NULL REFERENCES teams(id),
    started                 INTEGER NOT NULL DEFAULT 0,
    substitute_appearance   INTEGER NOT NULL DEFAULT 0,
    UNIQUE (match_id, player_id)
);
CREATE INDEX idx_records_match ON match_player_records(match_id);
CREATE INDEX idx_records_player ON match_player_records(player_id);

CREATE TABLE goals (
    id              INTEGER PRIMARY KEY,
    match_id        INTEGER NOT NULL REFERENCES matches(id)
                    ON DELETE CASCADE,
    team_id         INTEGER NOT NULL REFERENCES teams(id),
    player_id       INTEGER NOT NULL REFERENCES players(id),
    assist_player_id INTEGER REFERENCES players(id),
    minute          TEXT,
    is_penalty      INTEGER NOT NULL DEFAULT 0,
    own_goal        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_goals_match ON goals(match_id);
CREATE INDEX idx_goals_player ON goals(player_id);
CREATE INDEX idx_goals_assist ON goals(assist_player_id);
