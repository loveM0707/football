"""공개 화면용 집계. 집계값 저장 없이 원본에서 계산 (§32)."""
from . import store


def default_scope(con):
    s = con.execute(
        "SELECT * FROM seasons ORDER BY year DESC LIMIT 1").fetchone()
    if not s:
        return None, None
    c = con.execute("SELECT * FROM competitions WHERE season_id = ?"
                    " ORDER BY id LIMIT 1", (s["id"],)).fetchone()
    return s, c


def round_matches(con, round_id):
    return con.execute(
        "SELECT m.*, ht.name AS hn, at.name AS an FROM matches m"
        " JOIN teams ht ON ht.id = m.home_team_id"
        " JOIN teams at ON at.id = m.away_team_id"
        " WHERE m.round_id = ? ORDER BY m.match_date, m.id",
        (round_id,)).fetchall()


def match_view(con, mid):
    m = con.execute(
        "SELECT m.*, ht.name AS hn, at.name AS an, st.name AS stn,"
        " s.name AS sname, c.name AS cname, r.round_number,"
        " mp.name AS motm FROM matches m"
        " JOIN teams ht ON ht.id = m.home_team_id"
        " JOIN teams at ON at.id = m.away_team_id"
        " LEFT JOIN stadiums st ON st.id = m.stadium_id"
        " JOIN seasons s ON s.id = m.season_id"
        " JOIN competitions c ON c.id = m.competition_id"
        " JOIN rounds r ON r.id = m.round_id"
        " LEFT JOIN players mp ON mp.id = m.motm_player_id"
        " WHERE m.id = ?", (mid,)).fetchone()
    if not m:
        return None
    goals = con.execute(
        "SELECT g.*, p.name AS pn, a.name AS an2, t.name AS tn"
        " FROM goals g JOIN players p ON p.id = g.player_id"
        " LEFT JOIN players a ON a.id = g.assist_player_id"
        " JOIN teams t ON t.id = g.team_id"
        " WHERE g.match_id = ? ORDER BY g.id", (mid,)).fetchall()
    recs = {}
    for tid in (m["home_team_id"], m["away_team_id"]):
        recs[tid] = con.execute(
            "SELECT r.*, p.name FROM match_player_records r"
            " JOIN players p ON p.id = r.player_id"
            " WHERE r.match_id = ? AND r.team_id = ? ORDER BY p.name",
            (mid, tid)).fetchall()
    return {"m": m, "goals": goals, "recs": recs}


def standings(con, comp_id):
    rows = con.execute(
        "SELECT m.*, ht.name AS hn, at.name AS an FROM matches m"
        " JOIN teams ht ON ht.id = m.home_team_id"
        " JOIN teams at ON at.id = m.away_team_id"
        " WHERE m.competition_id = ?", (comp_id,)).fetchall()
    t = {}
    for m in rows:
        for tid, name in ((m["home_team_id"], m["hn"]),
                          (m["away_team_id"], m["an"])):
            t.setdefault(tid, {"team_id": tid, "name": name, "p": 0,
                               "w": 0, "d": 0, "l": 0, "gf": 0,
                               "ga": 0})
        h, a = t[m["home_team_id"]], t[m["away_team_id"]]
        h["p"] += 1
        a["p"] += 1
        h["gf"] += m["home_score"]
        h["ga"] += m["away_score"]
        a["gf"] += m["away_score"]
        a["ga"] += m["home_score"]
        if m["home_score"] > m["away_score"]:
            h["w"] += 1
            a["l"] += 1
        elif m["home_score"] < m["away_score"]:
            a["w"] += 1
            h["l"] += 1
        else:
            h["d"] += 1
            a["d"] += 1
    out = []
    for v in t.values():
        v["gd"] = v["gf"] - v["ga"]
        v["pts"] = v["w"] * 3 + v["d"]
        out.append(v)
    out.sort(key=lambda v: (-v["pts"], -v["gd"], -v["gf"], v["name"]))
    return out


def _comp_matches(con, season_id, comp_id):
    return con.execute(
        "SELECT m.*, ht.name AS hn, at.name AS an FROM matches m"
        " JOIN teams ht ON ht.id = m.home_team_id"
        " JOIN teams at ON at.id = m.away_team_id"
        " WHERE m.season_id = ? AND m.competition_id = ?"
        " ORDER BY m.match_date, m.id", (season_id, comp_id)).fetchall()


def team_view(con, team_id, season_id, comp_id):
    team = con.execute("SELECT * FROM teams WHERE id = ?",
                       (team_id,)).fetchone()
    if not team:
        return None
    table = [r for r in standings(con, comp_id)
             if r["team_id"] == team_id]
    ms = [m for m in _comp_matches(con, season_id, comp_id)
          if m["home_team_id"] == team_id or m["away_team_id"] == team_id]
    recent = ms[-5:][::-1]
    players = con.execute(
        "SELECT p.id, p.name,"
        " SUM(r.started) AS st, SUM(r.substitute_appearance) AS sub,"
        " (SELECT COUNT(*) FROM goals g JOIN matches m ON"
        "  m.id = g.match_id WHERE g.player_id = p.id"
        "  AND m.season_id = ? AND m.competition_id = ?"
        "  AND g.team_id = ?) AS gl,"
        " (SELECT COUNT(*) FROM goals g JOIN matches m ON"
        "  m.id = g.match_id WHERE g.player_id = p.id"
        "  AND g.is_penalty = 1 AND m.season_id = ?"
        "  AND m.competition_id = ? AND g.team_id = ?) AS pk,"
        " (SELECT COUNT(*) FROM goals g JOIN matches m ON"
        "  m.id = g.match_id WHERE g.assist_player_id = p.id"
        "  AND m.season_id = ? AND m.competition_id = ?) AS ast"
        " FROM players p JOIN match_player_records r"
        " ON r.player_id = p.id JOIN matches m ON m.id = r.match_id"
        " WHERE r.team_id = ? AND m.season_id = ?"
        " AND m.competition_id = ?"
        " GROUP BY p.id ORDER BY gl DESC, ast DESC, p.name",
        (season_id, comp_id, team_id, season_id, comp_id, team_id,
         season_id, comp_id, team_id, season_id, comp_id)).fetchall()
    return {"team": team, "row": table[0] if table else None,
            "recent": recent, "players": players, "fixtures": ms}


def player_view(con, pid, season_id, comp_id):
    p = con.execute("SELECT * FROM players WHERE id = ?", (pid,)).fetchone()
    if not p:
        return None
    last = con.execute(
        "SELECT t.id, t.name FROM match_player_records r"
        " JOIN matches m ON m.id = r.match_id"
        " JOIN teams t ON t.id = r.team_id"
        " WHERE r.player_id = ? AND m.season_id = ?"
        " AND m.competition_id = ? ORDER BY m.match_date DESC,"
        " m.id DESC LIMIT 1", (pid, season_id, comp_id)).fetchone()
    rnds = con.execute("SELECT * FROM rounds WHERE competition_id = ?"
                       " ORDER BY round_number", (comp_id,)).fetchall()
    rows, tot = [], {"st": 0, "sub": 0, "gl": 0, "pk": 0, "ast": 0}
    for r in rnds:
        ms = con.execute("SELECT id FROM matches WHERE round_id = ?",
                         (r["id"],)).fetchall()
        mids = [m["id"] for m in ms]
        if not mids:
            continue
        q = ",".join("?" * len(mids))
        rec = con.execute(
            "SELECT MAX(started) AS st, MAX(substitute_appearance) AS sub"
            " FROM match_player_records WHERE player_id = ? AND match_id"
            " IN (%s)" % q, (pid,) + tuple(mids)).fetchone()
        gl = con.execute(
            "SELECT COUNT(*), SUM(is_penalty) FROM goals WHERE player_id = ?"
            " AND match_id IN (%s)" % q, (pid,) + tuple(mids)).fetchone()
        ast = con.execute(
            "SELECT COUNT(*) FROM goals WHERE assist_player_id = ?"
            " AND match_id IN (%s)" % q, (pid,) + tuple(mids)).fetchone()[0]
        st = rec["st"] or 0
        sub = rec["sub"] or 0
        g, pk = (gl[0] or 0), (gl[1] or 0)
        if not (st or sub or g or ast):
            continue
        rows.append({"round": r["round_number"], "st": st, "sub": sub,
                     "gl": g, "pk": pk, "ast": ast})
        for k, v in (("st", st), ("sub", sub), ("gl", g), ("pk", pk),
                     ("ast", ast)):
            tot[k] += v
    return {"p": p, "team": last, "rows": rows, "tot": tot}


def scorers(con, season_id, comp_id):
    return con.execute(
        "SELECT p.id, p.name, t.name AS tn, COUNT(*) AS gl,"
        " SUM(g.is_penalty) AS pk FROM goals g"
        " JOIN players p ON p.id = g.player_id"
        " JOIN teams t ON t.id = g.team_id"
        " JOIN matches m ON m.id = g.match_id"
        " WHERE m.season_id = ? AND m.competition_id = ?"
        " GROUP BY p.id ORDER BY gl DESC, pk, p.name",
        (season_id, comp_id)).fetchall()


def assists(con, season_id, comp_id):
    return con.execute(
        "SELECT p.id, p.name, COUNT(*) AS ast FROM goals g"
        " JOIN players p ON p.id = g.assist_player_id"
        " JOIN matches m ON m.id = g.match_id"
        " WHERE m.season_id = ? AND m.competition_id = ?"
        " GROUP BY p.id ORDER BY ast DESC, p.name",
        (season_id, comp_id)).fetchall()


def h2h(con, a, b):
    ms = con.execute(
        "SELECT m.*, ht.name AS hn, at.name AS an FROM matches m"
        " JOIN teams ht ON ht.id = m.home_team_id"
        " JOIN teams at ON at.id = m.away_team_id"
        " WHERE (m.home_team_id = ? AND m.away_team_id = ?)"
        " OR (m.home_team_id = ? AND m.away_team_id = ?)"
        " ORDER BY m.match_date, m.id", (a, b, b, a)).fetchall()
    st = {"n": 0, "aw": 0, "d": 0, "bw": 0, "gf_a": 0, "ga_a": 0}
    for m in ms:
        st["n"] += 1
        fa = m["home_score"] if m["home_team_id"] == a else m["away_score"]
        fb = m["away_score"] if m["home_team_id"] == a else m["home_score"]
        st["gf_a"] += fa
        st["ga_a"] += fb
        if fa > fb:
            st["aw"] += 1
        elif fa < fb:
            st["bw"] += 1
        else:
            st["d"] += 1
    return st, ms
