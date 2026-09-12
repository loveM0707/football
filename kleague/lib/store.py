"""관리자 저장 로직 + 검증 (§37, §38). 라우트에서 직접 호출.

규칙:
- hard error: 구조 오류(팀 부재/동일팀/음수 스코어/라운드 중복/득점팀 불일치/
  출전 중복). 저장 차단.
- warning: 기록이 존재하는데 득점·도움 선수가 출전 명단에 없음.
  부분 입력(§17, §33)은 허용하므로 저장하되 표시한다.
- 경기 일관성 상태: 미입력(득점 0건) / 정상 / 불일치 (§38).
"""
import os

from . import db


def _one(con, sql, args=()):
    return con.execute(sql, args).fetchone()


def _all(con, sql, args=()):
    return con.execute(sql, args).fetchall()


def _to_int(raw, field, errors, required=True):
    if raw is None or str(raw).strip() == "":
        if required:
            errors.append("%s: 필수 입력" % field)
        return None
    try:
        v = int(str(raw).strip())
    except ValueError:
        errors.append("%s: 숫자 입력" % field)
        return None
    return v


# ---- 마스터 ----
def create_season(con, year, name):
    errors = []
    year = _to_int(year, "시즌 연도", errors)
    name = (name or "").strip()
    if not name:
        errors.append("시즌명: 필수 입력")
    if errors:
        return None, errors
    try:
        cur = con.execute("INSERT INTO seasons(year, name) VALUES(?, ?)",
                          (year, name))
        con.commit()
        return cur.lastrowid, []
    except Exception:
        return None, ["시즌: 중복 연도 또는 오류"]


def create_competition(con, season_id, code, name):
    errors = []
    code, name = (code or "").strip(), (name or "").strip()
    if not code:
        errors.append("대회 코드: 필수 입력")
    if not name:
        errors.append("대회명: 필수 입력")
    if not _one(con, "SELECT id FROM seasons WHERE id = ?", (season_id,)):
        errors.append("시즌: 존재하지 않음")
    if errors:
        return None, errors
    try:
        cur = con.execute(
            "INSERT INTO competitions(season_id, code, name)"
            " VALUES(?, ?, ?)", (season_id, code, name))
        con.commit()
        return cur.lastrowid, []
    except Exception:
        return None, ["대회: 중복 코드 또는 오류"]


def create_round(con, season_id, competition_id, number):
    errors = []
    number = _to_int(number, "라운드 번호", errors)
    if number is not None and number < 1:
        errors.append("라운드 번호: 1 이상")
    comp = _one(con, "SELECT id, season_id FROM competitions WHERE id = ?",
                (competition_id,))
    if not comp:
        errors.append("대회: 존재하지 않음")
    elif comp["season_id"] != (season_id or comp["season_id"]):
        errors.append("대회: 시즌 불일치")
    if errors:
        return None, errors
    season_id = comp["season_id"]
    try:
        cur = con.execute(
            "INSERT INTO rounds(season_id, competition_id, round_number)"
            " VALUES(?, ?, ?)", (season_id, competition_id, number))
        con.commit()
        return cur.lastrowid, []
    except Exception:
        return None, ["라운드: 중복 번호 또는 오류"]


def create_team(con, name, short=""):
    name = (name or "").strip()
    if not name:
        return None, ["팀명: 필수 입력"]
    try:
        cur = con.execute("INSERT INTO teams(name, short_name) VALUES(?, ?)",
                          (name, (short or "").strip() or None))
        con.commit()
        return cur.lastrowid, []
    except Exception:
        return None, ["팀: 중복 팀명 또는 오류"]


def create_stadium(con, name):
    name = (name or "").strip()
    if not name:
        return None, ["경기장명: 필수 입력"]
    try:
        cur = con.execute("INSERT INTO stadiums(name) VALUES(?)", (name,))
        con.commit()
        return cur.lastrowid, []
    except Exception:
        return None, ["경기장: 중복 또는 오류"]


def create_player(con, data):
    name = (data.get("name") or "").strip()
    if not name:
        return None, ["선수명: 필수 입력"]
    cur = con.execute(
        "INSERT INTO players(name, name_en, birth_date, nationality,"
        " position, height_cm, weight_kg)"
        " VALUES(?, ?, ?, ?, ?, ?, ?)",
        (name, (data.get("name_en") or "").strip() or None,
         (data.get("birth_date") or "").strip() or None,
         (data.get("nationality") or "").strip() or None,
         (data.get("position") or "").strip() or None,
         (data.get("height_cm") or "").strip() or None,
         (data.get("weight_kg") or "").strip() or None))
    con.commit()
    return cur.lastrowid, []


def search_players(con, q, limit=20):
    q = (q or "").strip()
    if not q:
        return []
    return _all(con, "SELECT * FROM players WHERE name LIKE ?"
                     " ORDER BY id LIMIT ?", ("%" + q + "%", limit))


# ---- 경기 ----
def _check_match_teams(con, home_id, away_id, errors):
    if home_id == away_id:
        errors.append("홈팀과 원정팀이 같음")
        return
    for label, tid in (("홈팀", home_id), ("원정팀", away_id)):
        if not _one(con, "SELECT id FROM teams WHERE id = ?", (tid,)):
            errors.append("%s: 존재하지 않는 팀" % label)


def create_match(con, f):
    """최소 항목(§16): 시즌/대회/라운드/경기일/홈/원정/스코어."""
    errors = []
    rnd = _one(con, "SELECT * FROM rounds WHERE id = ?", (f.get("round_id"),))
    if not rnd:
        errors.append("라운드: 존재하지 않음")
    home = _to_int(f.get("home_team_id"), "홈팀", errors)
    away = _to_int(f.get("away_team_id"), "원정팀", errors)
    hs = _to_int(f.get("home_score"), "홈 스코어", errors)
    aws = _to_int(f.get("away_score"), "원정 스코어", errors)
    date = (f.get("match_date") or "").strip()
    if not date:
        errors.append("경기일: 필수 입력")
    for label, v in (("홈 스코어", hs), ("원정 스코어", aws)):
        if v is not None and v < 0:
            errors.append("%s: 음수 금지" % label)
    if home is not None and away is not None:
        _check_match_teams(con, home, away, errors)
    att = _to_int(f.get("attendance"), "관중", errors, required=False)
    if att is not None and att < 0:
        errors.append("관중: 음수 금지")
    if errors:
        return None, errors
    try:
        cur = con.execute(
            "INSERT INTO matches(season_id, competition_id, round_id,"
            " match_date, kickoff_time, stadium_id, attendance,"
            " home_team_id, away_team_id, home_score, away_score)"
            " VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (rnd["season_id"], rnd["competition_id"], rnd["id"], date,
             (f.get("kickoff_time") or "").strip() or None,
             f.get("stadium_id") or None, att, home, away, hs, aws))
        con.commit()
        return cur.lastrowid, []
    except Exception:
        return None, ["경기: 라운드 내 중복 대진 또는 오류"]


def update_match(con, match_id, f):
    errors = []
    m = _one(con, "SELECT * FROM matches WHERE id = ?", (match_id,))
    if not m:
        return ["경기: 존재하지 않음"]
    hs = _to_int(f.get("home_score"), "홈 스코어", errors)
    aws = _to_int(f.get("away_score"), "원정 스코어", errors)
    date = (f.get("match_date") or "").strip()
    if not date:
        errors.append("경기일: 필수 입력")
    for label, v in (("홈 스코어", hs), ("원정 스코어", aws)):
        if v is not None and v < 0:
            errors.append("%s: 음수 금지" % label)
    att = _to_int(f.get("attendance"), "관중", errors, required=False)
    if att is not None and att < 0:
        errors.append("관중: 음수 금지")
    hts = _to_int(f.get("home_ht_score"), "홈 전반", errors, required=False)
    ats = _to_int(f.get("away_ht_score"), "원정 전반", errors, required=False)
    motm = (f.get("motm_player_id") or "").strip() or None
    if motm and not _one(con, "SELECT id FROM players WHERE id = ?",
                         (motm,)):
        errors.append("MOTM: 존재하지 않는 선수")
    if errors:
        return errors
    con.execute(
        "UPDATE matches SET match_date = ?, kickoff_time = ?,"
        " stadium_id = ?, attendance = ?, home_score = ?,"
        " away_score = ?, home_ht_score = ?, away_ht_score = ?,"
        " motm_player_id = ? WHERE id = ?",
        (date, (f.get("kickoff_time") or "").strip() or None,
         f.get("stadium_id") or None, att, hs, aws, hts, ats, motm,
         match_id))
    con.commit()
    return []


# ---- 득점 ----
def add_goal(con, match_id, f):
    """returns (goal_id, errors, warnings). 부분 입력 허용."""
    errors, warnings = [], []
    m = _one(con, "SELECT * FROM matches WHERE id = ?", (match_id,))
    if not m:
        return None, ["경기: 존재하지 않음"], []
    team = _to_int(f.get("team_id"), "득점팀", errors)
    scorer = _to_int(f.get("player_id"), "득점 선수", errors)
    assist = _to_int(f.get("assist_player_id"), "도움 선수", errors,
                     required=False)
    if team is not None and team not in (m["home_team_id"],
                                         m["away_team_id"]):
        errors.append("득점팀: 경기 팀이 아님")
    if scorer is not None and not _one(
            con, "SELECT id FROM players WHERE id = ?", (scorer,)):
        errors.append("득점 선수: 존재하지 않음")
    if assist is not None:
        if not _one(con, "SELECT id FROM players WHERE id = ?",
                    (assist,)):
            errors.append("도움 선수: 존재하지 않음")
        elif assist == scorer:
            errors.append("도움 선수: 득점 선수와 동일")
    if errors:
        return None, errors, []
    # 출전 명단이 있으면 명단 대조 (없으면 부분 입력으로 통과)
    recs = {r["player_id"] for r in _all(
        con, "SELECT player_id FROM match_player_records WHERE match_id = ?",
        (match_id,))}
    if recs:
        if scorer not in recs:
            warnings.append("득점 선수가 출전 명단에 없음 (부분 입력 가능)")
        if assist is not None and assist not in recs:
            warnings.append("도움 선수가 출전 명단에 없음 (부분 입력 가능)")
    minute = (f.get("minute") or "").strip() or None
    cur = con.execute(
        "INSERT INTO goals(match_id, team_id, player_id, assist_player_id,"
        " minute, is_penalty, own_goal) VALUES(?, ?, ?, ?, ?, ?, ?)",
        (match_id, team, scorer, assist, minute,
         1 if f.get("is_penalty") else 0, 1 if f.get("own_goal") else 0))
    con.commit()
    return cur.lastrowid, [], warnings


def delete_goal(con, goal_id):
    con.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
    con.commit()


# ---- 출전 기록 ----
def add_record(con, match_id, player_id, team_id, started, sub):
    errors = []
    m = _one(con, "SELECT * FROM matches WHERE id = ?", (match_id,))
    if not m:
        return ["경기: 존재하지 않음"]
    if team_id not in (m["home_team_id"], m["away_team_id"]):
        errors.append("소속팀: 경기 팀이 아님")
    if not _one(con, "SELECT id FROM players WHERE id = ?", (player_id,)):
        errors.append("선수: 존재하지 않음")
    if not started and not sub:
        errors.append("선발/교체 중 하나는 선택")
    if errors:
        return errors
    try:
        con.execute(
            "INSERT INTO match_player_records(match_id, player_id, team_id,"
            " started, substitute_appearance)"
            " VALUES(?, ?, ?, ?, ?)",
            (match_id, player_id, team_id, 1 if started else 0,
             1 if sub else 0))
        con.commit()
        return []
    except Exception:
        return ["출전 기록: 같은 선수 중복 등록"]


def update_record(con, record_id, started, sub):
    if not started and not sub:
        return ["선발/교체 중 하나는 선택"]
    con.execute("UPDATE match_player_records SET started = ?,"
                " substitute_appearance = ? WHERE id = ?",
                (1 if started else 0, 1 if sub else 0, record_id))
    con.commit()
    return []


def delete_record(con, record_id):
    con.execute("DELETE FROM match_player_records WHERE id = ?",
                (record_id,))
    con.commit()


# ---- 조회 ----
def goal_counts(con, match_id):
    row = _one(con, "SELECT m.home_score, m.away_score,"
                    " SUM(g.team_id = m.home_team_id) AS gh,"
                    " SUM(g.team_id = m.away_team_id) AS ga"
                    " FROM matches m LEFT JOIN goals g"
                    " ON g.match_id = m.id WHERE m.id = ?",
               (match_id,))
    return {"home_score": row["home_score"], "away_score": row["away_score"],
            "gh": row["gh"] or 0, "ga": row["ga"] or 0}


def match_status(con, match_id):
    """미입력 / 정상 / 불일치 (§38)."""
    c = goal_counts(con, match_id)
    if c["gh"] == 0 and c["ga"] == 0:
        return "미입력", c
    if c["gh"] == c["home_score"] and c["ga"] == c["away_score"]:
        return "정상", c
    return "불일치", c


def reset_db(db_path):
    """전체 초기화 (§46). 호출 전 관리자 확인 필수."""
    if os.path.exists(db_path):
        os.remove(db_path)
    db.init_empty(db_path)
