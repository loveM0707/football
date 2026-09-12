#!/usr/bin/env python3
"""K리그 경량 DB 웹사이트. 표준라이브러리만 사용.

실행: KLEAGUE_ADMIN_PASSWORD=... py server/app.py [--db ...] [--port 8734]
공개 페이지는 Phase 4에서 확장. 관리자: /administrator_console/
"""
import argparse
import html
import json
import os
import secrets
import sys
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlparse, quote

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".."))
from lib import db as dblib  # noqa: E402
from lib import store  # noqa: E402
from lib import stats  # noqa: E402
from lib import auth  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSIONS = set()
STATIC_DIR = os.path.join(BASE, "static")

HEAD = ("<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<link rel='stylesheet' href='/static/style.css'>")


def static_path(name):
    """정적 파일 경로. 통과 불가 이름은 None (§39 traversal 차단)."""
    if not name or ".." in name or "/" in name or "\\" in name:
        return None
    if not all(ch.isalnum() or ch in "._-" for ch in name):
        return None
    full = os.path.join(STATIC_DIR, name)
    if not os.path.isfile(full):
        return None
    return full


def esc(s):
    return html.escape("" if s is None else str(s))


def page(title, body, admin=False, pub=False):
    nav = ""
    if admin:
        nav = ("<nav><a href='/administrator_console/'>관리홈</a> | "
               "<a href='/administrator_console/teams'>팀</a> | "
               "<a href='/administrator_console/players'>선수</a> | "
               "<a href='/administrator_console/stadiums'>경기장</a> | "
               "<a href='/administrator_console/seasons'>시즌</a> | "
               "<a href='/administrator_console/password'>비밀번호 변경</a> | "
               "<form method='post' action='/administrator_console/logout' "
               "style='display:inline'>"
               "<button>로그아웃</button></form></nav>")
    elif pub:
        nav = ("<nav><a href='/'>홈</a> | <a href='/results'>결과</a> | "
               "<a href='/standings'>순위</a> | "
               "<a href='/scorers'>득점</a> | <a href='/assists'>도움</a> | "
               "<a href='/teams'>팀</a> | <a href='/players'>선수</a> | "
               "<a href='/h2h'>상대전적</a></nav>")
    return ("<!doctype html><html lang='ko'><head><meta charset='utf-8'>"
            "<title>%s</title>%s</head><body>%s<h1>%s</h1>%s</body></html>"
            % (esc(title), HEAD, nav, esc(title), body))


def errs_html(errors, warnings=()):
    h = ""
    for e in errors:
        h += "<p class='err'>%s</p>" % esc(e)
    for w in warnings:
        h += "<p class='warn'>%s</p>" % esc(w)
    return h


class Handler(BaseHTTPRequestHandler):
    server_version = "KLeague/0.3"

    # -- 공용 --
    def log_message(self, *a):
        pass

    def _db(self):
        return dblib.connect(self.server.db_path)

    def _send(self, code, body, headers=()):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def _redirect(self, loc, cookie=None):
        h = [("Location", loc)]
        if cookie is not None:
            h.append(("Set-Cookie", cookie))
        self.send_response(302)
        for k, v in h:
            self.send_header(k, v)
        self.end_headers()

    def _session(self):
        ck = SimpleCookie(self.headers.get("Cookie", ""))
        tok = ck["ksess"].value if "ksess" in ck else ""
        return tok if tok in SESSIONS else None

    def _need_admin(self):
        if self.server.pw_hash and self._session():
            return True
        self._redirect("/administrator_console/login")
        return False

    def _form(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        return dict(parse_qsl(self.rfile.read(n).decode("utf-8"),
                              keep_blank_values=True))

    # -- 라우팅 --
    def do_GET(self):
        u = urlparse(self.path)
        p, q = u.path, dict(parse_qsl(u.query))
        if p.startswith("/static/"):
            return self._static(p[len("/static/"):])
        if p == "/":
            return self._pub_route(
                lambda con: self._home(con), pub=True)
        if p == "/results":
            return self._pub_route(
                lambda con: self._results(con, q), pub=True)
        if p.startswith("/matches/"):
            return self._pub_route(
                lambda con: self._pub_match(con, p[9:]), pub=True)
        if p == "/teams":
            return self._pub_route(
                lambda con: self._pub_teams(con, q), pub=True)
        if p.startswith("/teams/"):
            return self._pub_route(
                lambda con: self._pub_team(con, p[7:], q), pub=True)
        if p == "/players":
            return self._pub_route(
                lambda con: self._pub_players(con, q), pub=True)
        if p.startswith("/players/"):
            return self._pub_route(
                lambda con: self._pub_player(con, p[9:], q), pub=True)
        if p == "/standings":
            return self._pub_route(
                lambda con: self._pub_standings(con, q), pub=True)
        if p == "/scorers":
            return self._pub_route(
                lambda con: self._pub_scorers(con, q), pub=True)
        if p == "/assists":
            return self._pub_route(
                lambda con: self._pub_assists(con, q), pub=True)
        if p == "/h2h":
            return self._pub_route(
                lambda con: self._pub_h2h(con, q), pub=True)
        if p.startswith("/api/"):
            return self._api(p, q)
        if p == "/administrator_console/login":
            return self._login_page()
        if not p.startswith("/administrator_console/"):
            return self._send(404, page("404", "<p>없음</p>"))
        if not self._need_admin():
            return
        con = self._db()
        try:
            seg = p[len("/administrator_console/"):].strip("/").split("/")
            if seg == [""]:
                return self._admin_home(con, q)
            if seg == ["seasons"]:
                return self._seasons(con)
            if len(seg) == 2 and seg[0] == "season":
                return self._season(con, seg[1])
            if len(seg) == 2 and seg[0] == "competition":
                return self._competition(con, seg[1])
            if len(seg) == 2 and seg[0] == "round":
                return self._round(con, seg[1], q)
            if len(seg) == 2 and seg[0] == "match":
                return self._match(con, seg[1], q)
            if seg == ["teams"]:
                return self._teams(con)
            if seg == ["players"]:
                return self._players(con, q)
            if seg == ["stadiums"]:
                return self._stadiums(con)
            if seg == ["reset"]:
                return self._reset_page()
            if seg == ["password"]:
                return self._password_page()
            return self._send(404, page("404", "<p>없음</p>", True))
        finally:
            con.close()

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/administrator_console/login":
            return self._login_do()
        if p == "/administrator_console/logout":
            ck = SimpleCookie(self.headers.get("Cookie", ""))
            if "ksess" in ck:
                SESSIONS.discard(ck["ksess"].value)
            return self._redirect("/administrator_console/login")
        if not p.startswith("/administrator_console/"):
            return self._send(404, page("404", "<p>없음</p>"))
        if not self._need_admin():
            return
        con = self._db()
        try:
            f = self._form()
            seg = p[len("/administrator_console/"):].strip("/").split("/")
            if seg == ["seasons"]:
                sid, errors = store.create_season(
                    con, f.get("year"), f.get("name"))
                if errors:
                    return self._send(200, page(
                        "시즌", errs_html(errors)
                        + "<p><a href='/administrator_console/seasons'>돌아가기</a></p>",
                        True))
                return self._redirect("/administrator_console/season/%d" % sid)
            if len(seg) == 3 and seg[0] == "season" \
                    and seg[2] == "competitions":
                cid, errors = store.create_competition(
                    con, int(seg[1]), f.get("code"), f.get("name"))
                if errors:
                    return self._send(200, page(
                        "대회", errs_html(errors)
                        + "<p><a href='/administrator_console/season/%s'>돌아가기</a></p>"
                        % esc(seg[1]), True))
                return self._redirect("/administrator_console/competition/%d" % cid)
            if len(seg) == 3 and seg[0] == "competition" \
                    and seg[2] == "rounds":
                rid, errors = store.create_round(
                    con, None, int(seg[1]), f.get("number"))
                if errors:
                    return self._send(200, page(
                        "라운드", errs_html(errors)
                        + "<p><a href='/administrator_console/competition/%s'>돌아가기</a>"
                        "</p>" % esc(seg[1]), True))
                return self._redirect("/administrator_console/round/%d" % rid)
            if len(seg) == 3 and seg[0] == "round" \
                    and seg[2] == "matches":
                mid, errors = store.create_match(con, dict(
                    f, round_id=int(seg[1])))
                if errors:
                    return self._send(200, page(
                        "경기 등록", errs_html(errors)
                        + "<p><a href='/administrator_console/round/%s'>돌아가기</a></p>"
                        % esc(seg[1]), True))
                return self._redirect("/administrator_console/match/%d" % mid)
            if len(seg) == 2 and seg[0] == "match":
                errors = store.update_match(con, int(seg[1]), f)
                loc = "/administrator_console/match/%s" % esc(seg[1])
                if errors:
                    return self._send(200, page(
                        "경기 수정", errs_html(errors)
                        + "<p><a href='%s'>돌아가기</a></p>" % loc, True))
                return self._redirect(loc)
            if len(seg) == 3 and seg[0] == "match" \
                    and seg[2] == "goals":
                gid, errors, warns = store.add_goal(
                    con, int(seg[1]), f)
                loc = "/administrator_console/match/%s" % esc(seg[1])
                if errors:
                    return self._send(200, page(
                        "득점 등록", errs_html(errors)
                        + "<p><a href='%s'>돌아가기</a></p>" % loc, True))
                if warns:
                    loc += "?warn=" + quote("; ".join(warns))
                return self._redirect(loc)
            if len(seg) == 3 and seg[0] == "goal" \
                    and seg[2] == "delete":
                mid = con.execute(
                    "SELECT match_id FROM goals WHERE id = ?",
                    (int(seg[1]),)).fetchone()
                store.delete_goal(con, int(seg[1]))
                return self._redirect("/administrator_console/match/%d" % mid["match_id"])
            if len(seg) == 3 and seg[0] == "match" \
                    and seg[2] == "records":
                errors = store.add_record(
                    con, int(seg[1]), int(f.get("player_id")),
                    int(f.get("team_id")), bool(f.get("started")),
                    bool(f.get("sub")))
                loc = "/administrator_console/match/%s" % esc(seg[1])
                if errors:
                    return self._send(200, page(
                        "출전 등록", errs_html(errors)
                        + "<p><a href='%s'>돌아가기</a></p>" % loc, True))
                return self._redirect(loc)
            if len(seg) == 3 and seg[0] == "record" \
                    and seg[2] == "update":
                r = con.execute(
                    "SELECT match_id FROM match_player_records WHERE id = ?",
                    (int(seg[1]),)).fetchone()
                errors = store.update_record(
                    con, int(seg[1]), bool(f.get("started")),
                    bool(f.get("sub")))
                loc = "/administrator_console/match/%d" % r["match_id"]
                if errors:
                    return self._send(200, page(
                        "출전 수정", errs_html(errors)
                        + "<p><a href='%s'>돌아가기</a></p>" % loc, True))
                return self._redirect(loc)
            if len(seg) == 3 and seg[0] == "record" \
                    and seg[2] == "delete":
                r = con.execute(
                    "SELECT match_id FROM match_player_records WHERE id = ?",
                    (int(seg[1]),)).fetchone()
                store.delete_record(con, int(seg[1]))
                return self._redirect("/administrator_console/match/%d" % r["match_id"])
            if len(seg) == 3 and seg[0] == "match" \
                    and seg[2] == "motm":
                con.execute("UPDATE matches SET motm_player_id = ?"
                            " WHERE id = ?",
                            (f.get("player_id") or None, int(seg[1])))
                con.commit()
                return self._redirect("/administrator_console/match/%s" % esc(seg[1]))
            if seg == ["teams"]:
                _, errors = store.create_team(
                    con, f.get("name"), f.get("short"))
                if errors:
                    return self._send(200, page(
                        "팀", errs_html(errors)
                        + "<p><a href='/administrator_console/teams'>돌아가기</a></p>",
                        True))
                return self._redirect("/administrator_console/teams")
            if seg == ["players"]:
                pid, errors = store.create_player(con, f)
                if errors:
                    return self._send(200, page(
                        "선수", errs_html(errors)
                        + "<p><a href='/administrator_console/players'>돌아가기</a></p>",
                        True))
                back = f.get("back") or "/administrator_console/players"
                return self._redirect(back)
            if seg == ["stadiums"]:
                _, errors = store.create_stadium(con, f.get("name"))
                if errors:
                    return self._send(200, page(
                        "경기장", errs_html(errors)
                        + "<p><a href='/administrator_console/stadiums'>돌아가기</a></p>",
                        True))
                return self._redirect("/administrator_console/stadiums")
            if seg == ["reset"]:
                if (f.get("confirm") or "").strip() != "RESET":
                    return self._redirect(
                        "/administrator_console/reset")
                con.close()  # Windows: 열린 DB 파일 삭제 불가
                store.reset_db(self.server.db_path)
                SESSIONS.clear()
                return self._redirect("/administrator_console/login")
            if seg == ["password"]:
                return self._password_do(f)
            return self._send(404, page("404", "<p>없음</p>", True))
        finally:
            con.close()

    # -- 공개 --
    def _static(self, name):
        full = static_path(name)
        if not full:
            return self._send(404, page("404", "<p>없음</p>", pub=True))
        with open(full, "rb") as f:
            raw = f.read()
        mime = "text/css" if full.endswith(".css") else \
            "application/javascript" if full.endswith(".js") else \
            "image/png" if full.endswith(".png") else \
            "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _scope_form(self, con, s, c, action):
        seasons = con.execute(
            "SELECT * FROM seasons ORDER BY year DESC").fetchall()
        comps = con.execute("SELECT * FROM competitions WHERE season_id = ?"
                            " ORDER BY id", (s["id"],)).fetchall()
        h = ("<form class='scope' method='get' action='%s'>시즌 "
             "<select name='season'>" % esc(action))
        for x in seasons:
            h += "<option value='%d'%s>%s</option>" % (
                x["id"], " selected" if x["id"] == s["id"] else "",
                esc(x["name"]))
        h += "</select> 대회 <select name='comp'>"
        for x in comps:
            h += "<option value='%d'%s>%s</option>" % (
                x["id"], " selected" if x["id"] == c["id"] else "",
                esc(x["name"]))
        return h + "</select> <button>이동</button></form>"

    def _pub_route(self, fn, pub=True):
        con = self._db()
        try:
            return fn(con)
        finally:
            con.close()

    def _scope(self, con, q):
        s = c = None
        if q.get("season"):
            s = con.execute("SELECT * FROM seasons WHERE id = ?",
                            (q["season"],)).fetchone()
        if q.get("comp"):
            c = con.execute("SELECT * FROM competitions WHERE id = ?",
                            (q["comp"],)).fetchone()
        if s is None or c is None:
            s, c = stats.default_scope(con)
        return s, c

    def _scope_label(self, s, c):
        return "%s %s" % (s["name"], c["name"])

    def _home(self, con):
        s, c = stats.default_scope(con)
        if not s:
            return self._send(200, page("K리그 DB", "<p>데이터 축적 중.</p>",
                                        pub=True))
        ms = con.execute(
            "SELECT m.*, ht.name AS hn, at.name AS an FROM matches m"
            " JOIN teams ht ON ht.id = m.home_team_id"
            " JOIN teams at ON at.id = m.away_team_id"
            " WHERE m.season_id = ? AND m.competition_id = ?"
            " ORDER BY m.match_date DESC, m.id DESC LIMIT 5",
            (s["id"], c["id"])).fetchall()
        h = "<h2>%s</h2>" % esc(self._scope_label(s, c))
        h += "<h3>최근 경기</h3>"
        for m in ms:
            h += ("<div class='card'><a href='/matches/%d'>%s %d - %d %s"
                  "</a><br>%s</div>" % (m["id"], esc(m["hn"]),
                                        m["home_score"], m["away_score"],
                                        esc(m["an"]), esc(m["match_date"])))
        if not ms:
            h += "<p>기록 없음</p>"
        return self._send(200, page("K리그 DB", h, pub=True))

    def _results(self, con, q):
        s, c = self._scope(con, q)
        if not s:
            return self._send(200, page("라운드 결과", "<p>기록 없음</p>",
                                        pub=True))
        rnds = con.execute("SELECT * FROM rounds WHERE competition_id = ?"
                           " ORDER BY round_number", (c["id"],)).fetchall()
        rid = q.get("round") or (rnds[-1]["id"] if rnds else None)
        h = "<h2>%s</h2>" % esc(self._scope_label(s, c))
        h += self._scope_form(con, s, c, "/results") + "<p>"
        for r in rnds:
            h += "<a href='/results?round=%d'>[%dR]</a> " % (
                r["id"], r["round_number"])
        h += "</p>"
        if rid:
            ids = [r["id"] for r in rnds]
            if rid in ids:
                i = ids.index(rid)
                nav = ""
                if i > 0:
                    nav += "<a href='/results?round=%d'>← %dR</a> " % (
                        ids[i - 1], rnds[i - 1]["round_number"])
                if i < len(ids) - 1:
                    nav += "<a href='/results?round=%d'>%dR →</a>" % (
                        ids[i + 1], rnds[i + 1]["round_number"])
                if nav:
                    h += "<p>%s</p>" % nav
            for m in stats.round_matches(con, rid):
                h += ("<div class='card'><a href='/matches/%d'>%s %d - %d"
                      " %s</a><br>%s %s</div>"
                      % (m["id"], esc(m["hn"]), m["home_score"],
                         m["away_score"], esc(m["an"]),
                         esc(m["match_date"]),
                         esc(m["kickoff_time"] or "")))
        return self._send(200, page("라운드 결과", h, pub=True))

    def _pub_match(self, con, mid):
        v = stats.match_view(con, mid)
        if not v:
            return self._send(404, page("404", "<p>없음</p>", pub=True))
        m = v["m"]
        h = ("<h2>%s %s %dR</h2><div class='card'><b>%s %d - %d %s</b><br>"
             "%s %s<br>%s%s</div>" % (
                 esc(m["sname"]), esc(m["cname"]), m["round_number"],
                 esc(m["hn"]), m["home_score"], m["away_score"],
                 esc(m["an"]), esc(m["match_date"]),
                 esc(m["kickoff_time"] or ""), esc(m["stn"] or ""),
                 (" · 관중 %s" % esc(m["attendance"]))
                 if m["attendance"] is not None else ""))
        h += "<h3>득점</h3>"
        if v["goals"]:
            for g in v["goals"]:
                h += ("<div>%s' %s (%s)%s%s</div>"
                      % (esc(g["minute"] or "?"), esc(g["pn"]),
                         esc(g["tn"]),
                         " (도움 %s)" % esc(g["an2"]) if g["an2"] else "",
                         " (PK)" if g["is_penalty"] else ""))
        else:
            h += "<p>기록 없음</p>"
        for tid, tn in ((m["home_team_id"], m["hn"]),
                        (m["away_team_id"], m["an"])):
            h += "<h3>%s</h3>" % esc(tn)
            rs = v["recs"][tid]
            if rs:
                h += "<ul>" + "".join(
                    "<li><a href='/players/%d'>%s</a>%s%s</li>"
                    % (r["player_id"], esc(r["name"]),
                       " 선발" if r["started"] else "",
                       "/교체" if r["substitute_appearance"] else "")
                    for r in rs) + "</ul>"
            else:
                h += "<p>출전 기록 없음</p>"
        if m["motm"]:
            h += "<p>MOTM: %s</p>" % esc(m["motm"])
        return self._send(200, page(
            "%s %d-%d %s" % (m["hn"], m["home_score"], m["away_score"],
                             m["an"]), h, pub=True))

    def _pub_teams(self, con, q):
        sq = (q.get("q") or "").strip()
        return self._send(200, page("팀", self._teams_body(con, sq),
                                    pub=True))

    def _teams_body(self, con, sq):
        rows = con.execute(
            "SELECT * FROM teams WHERE name LIKE ? ORDER BY name",
            ("%" + sq + "%",)).fetchall() if sq else con.execute(
            "SELECT * FROM teams ORDER BY name").fetchall()
        h = ("<form method='get' action='/teams'>검색 "
             "<input name='q' size='10' value='%s'>"
             "<button>검색</button></form><ul>" % esc(sq))
        for r in rows:
            h += ("<li><a href='/teams/%d'>%s</a></li>"
                  % (r["id"], esc(r["name"])))
        return h + "</ul>" if rows else h + "</ul><p>기록 없음</p>"

    def _pub_team(self, con, tid, q):
        s, c = self._scope(con, q)
        if not s:
            return self._send(200, page("팀", "<p>기록 없음</p>", pub=True))
        v = stats.team_view(con, tid, s["id"], c["id"])
        if not v:
            return self._send(404, page("404", "<p>없음</p>", pub=True))
        h = "<h2>%s</h2><p>%s</p>" % (
            esc(v["team"]["name"]), esc(self._scope_label(s, c)))
        h += self._scope_form(con, s, c, "/teams/%s" % esc(tid))
        if v["row"]:
            r = v["row"]
            h += ("<div class='tw'><table><tr><th>순위</th><th>경기</th><th>승</th><th>무</th>"
                  "<th>패</th><th>득점</th><th>실점</th><th>득실차</th>"
                  "<th>승점</th></tr><tr><td>-</td><td>%d</td><td>%d</td>"
                  "<td>%d</td><td>%d</td><td>%d</td><td>%d</td><td>%d</td>"
                  "<td>%d</td></tr></table></div>"
                  % (r["p"], r["w"], r["d"], r["l"], r["gf"], r["ga"],
                     r["gd"], r["pts"]))
        else:
            h += "<p>기록 없음</p>"
        h += "<h3>최근 경기</h3>"
        for m in v["recent"]:
            h += ("<div><a href='/matches/%d'>%s %d - %d %s</a></div>"
                  % (m["id"], esc(m["hn"]), m["home_score"],
                     m["away_score"], esc(m["an"])))
        h += "<h3>선수</h3>"
        if v["players"]:
            h += ("<div class='tw'><table><tr><th>선수</th><th>선발</th><th>교체</th>"
                  "<th>득점</th><th>PK</th><th>도움</th></tr>")
            for p in v["players"]:
                h += ("<tr><td><a href='/players/%d'>%s</a></td><td>%d</td>"
                      "<td>%d</td><td>%d</td><td>%d</td><td>%d</td></tr>"
                      % (p["id"], esc(p["name"]), p["st"] or 0,
                         p["sub"] or 0, p["gl"] or 0, p["pk"] or 0,
                         p["ast"] or 0))
            h += "</table></div>"
        else:
            h += "<p>기록 없음</p>"
        h += "<h3>시즌 경기 일정</h3>"
        for m in v["fixtures"]:
            h += ("<div><a href='/matches/%d'>%s %d - %d %s</a> %s</div>"
                  % (m["id"], esc(m["hn"]), m["home_score"],
                     m["away_score"], esc(m["an"]), esc(m["match_date"])))
        return self._send(200, page(v["team"]["name"], h, pub=True))

    def _pub_players(self, con, q):
        sq = (q.get("q") or "").strip()
        pg = max(1, int(q.get("page") or 1))
        per = 50
        if sq:
            rows = store.search_players(con, sq, 200)
            total = len(rows)
        else:
            total = con.execute(
                "SELECT COUNT(*) FROM players").fetchone()[0]
            rows = con.execute("SELECT * FROM players ORDER BY name"
                               " LIMIT ? OFFSET ?",
                               (per, (pg - 1) * per)).fetchall()
        h = ("<form method='get' action='/players'>검색 "
             "<input name='q' size='10' value='%s'>"
             "<button>검색</button></form><ul>" % esc(sq))
        for r in rows:
            h += ("<li><a href='/players/%d'>%s</a></li>"
                  % (r["id"], esc(r["name"])))
        h += "</ul>"
        if not sq and total > per:
            h += "<p>"
            if pg > 1:
                h += "<a href='/players?page=%d'>← 이전</a> " % (pg - 1)
            h += "%d/%d " % (pg, (total + per - 1) // per)
            if pg * per < total:
                h += "<a href='/players?page=%d'>다음 →</a>" % (pg + 1)
            h += "</p>"
        return self._send(200, page("선수", h, pub=True))

    def _pub_player(self, con, pid, q):
        s, c = self._scope(con, q)
        if not s:
            return self._send(200, page("선수", "<p>기록 없음</p>",
                                        pub=True))
        v = stats.player_view(con, pid, s["id"], c["id"])
        if not v:
            return self._send(404, page("404", "<p>없음</p>", pub=True))
        t = v["tot"]
        h = "<h2>%s</h2><p>%s · %s</p>" % (
            esc(v["p"]["name"]),
            esc(v["team"]["name"]) if v["team"] else "소속 기록 없음",
            esc(self._scope_label(s, c)))
        h += self._scope_form(con, s, c, "/players/%s" % esc(pid))
        h += ("<h3>시즌 기록</h3><p>선발 %d · 교체 %d · 득점 %d (PK %d) · "
              "도움 %d</p>" % (t["st"], t["sub"], t["gl"], t["pk"],
                               t["ast"]))
        h += "<h3>경기별 기록</h3>"
        if v["rows"]:
            h += ("<div class='tw'><table><tr><th>R</th><th>선발</th><th>교체</th>"
                  "<th>득점</th><th>도움</th></tr>")
            for r in v["rows"]:
                h += ("<tr><td>%dR</td><td>%s</td><td>%s</td><td>%d%s</td>"
                      "<td>%d</td></tr>"
                      % (r["round"], "선발" if r["st"] else "",
                         "교체" if r["sub"] else "", r["gl"],
                         " (PK %d)" % r["pk"] if r["pk"] else "",
                         r["ast"]))
            h += "</table></div>"
        else:
            h += "<p>기록 없음</p>"
        return self._send(200, page(v["p"]["name"], h, pub=True))

    def _pub_standings(self, con, q):
        s, c = self._scope(con, q)
        if not s:
            return self._send(200, page("순위", "<p>기록 없음</p>",
                                        pub=True))
        rows = stats.standings(con, c["id"])
        h = "<h2>%s</h2>" % esc(self._scope_label(s, c))
        h += self._scope_form(con, s, c, "/standings")
        if rows:
            h += ("<div class='tw'><table><tr><th>순위</th><th>팀</th><th>경기</th><th>승</th>"
                  "<th>무</th><th>패</th><th>득점</th><th>실점</th>"
                  "<th>득실차</th><th>승점</th></tr>")
            for i, r in enumerate(rows, 1):
                h += ("<tr><td>%d</td><td><a href='/teams/%d'>%s</a></td>"
                      "<td>%d</td><td>%d</td><td>%d</td><td>%d</td><td>%d</td>"
                      "<td>%d</td><td>%d</td><td>%d</td></tr>"
                      % (i, r["team_id"], esc(r["name"]), r["p"], r["w"],
                         r["d"], r["l"], r["gf"], r["ga"], r["gd"],
                         r["pts"]))
            h += "</table></div>"
        else:
            h += "<p>기록 없음</p>"
        return self._send(200, page("순위", h, pub=True))

    def _pub_scorers(self, con, q):
        s, c = self._scope(con, q)
        if not s:
            return self._send(200, page("득점 순위", "<p>기록 없음</p>",
                                        pub=True))
        rows = stats.scorers(con, s["id"], c["id"])
        h = "<h2>%s</h2>" % esc(self._scope_label(s, c))
        h += self._scope_form(con, s, c, "/scorers")
        if rows:
            h += "<div class='tw'><table><tr><th>순위</th><th>선수</th><th>팀</th><th>득점"
            h += "</th><th>PK</th></tr>"
            for i, r in enumerate(rows, 1):
                h += ("<tr><td>%d</td><td><a href='/players/%d'>%s</a></td>"
                      "<td>%s</td><td>%d</td><td>%d</td></tr>"
                      % (i, r["id"], esc(r["name"]), esc(r["tn"]),
                         r["gl"], r["pk"] or 0))
            h += "</table></div>"
        else:
            h += "<p>기록 없음</p>"
        return self._send(200, page("득점 순위", h, pub=True))

    def _pub_assists(self, con, q):
        s, c = self._scope(con, q)
        if not s:
            return self._send(200, page("도움 순위", "<p>기록 없음</p>",
                                        pub=True))
        rows = stats.assists(con, s["id"], c["id"])
        h = "<h2>%s</h2>" % esc(self._scope_label(s, c))
        h += self._scope_form(con, s, c, "/assists")
        if rows:
            h += "<div class='tw'><table><tr><th>순위</th><th>선수</th><th>도움</th></tr>"
            for i, r in enumerate(rows, 1):
                h += ("<tr><td>%d</td><td><a href='/players/%d'>%s</a></td>"
                      "<td>%d</td></tr>"
                      % (i, r["id"], esc(r["name"]), r["ast"]))
            h += "</table></div>"
        else:
            h += "<p>기록 없음</p>"
        return self._send(200, page("도움 순위", h, pub=True))

    def _pub_h2h(self, con, q):
        teams = con.execute(
            "SELECT * FROM teams ORDER BY name").fetchall()
        opts = "".join("<option value='%d'>%s</option>" % (t["id"], esc(
            t["name"])) for t in teams)
        h = ("<form method='get' action='/h2h'><select name='a'>%s</select>"
             " vs <select name='b'>%s</select><button>조회</button></form>"
             % (opts, opts))
        if q.get("a") and q.get("b") and q["a"] != q["b"]:
            ta = con.execute("SELECT * FROM teams WHERE id = ?",
                             (q["a"],)).fetchone()
            tb = con.execute("SELECT * FROM teams WHERE id = ?",
                             (q["b"],)).fetchone()
            if ta and tb:
                st, ms = stats.h2h(con, ta["id"], tb["id"])
                h += ("<h3>%s vs %s</h3><p>경기 %d · %s %d승 · 무 %d · "
                      "%s %d승 · 득점 %d-%d</p>"
                      % (esc(ta["name"]), esc(tb["name"]), st["n"],
                         esc(ta["name"]), st["aw"], st["d"],
                         esc(tb["name"]), st["bw"], st["gf_a"],
                         st["ga_a"]))
                for m in ms:
                    h += ("<div><a href='/matches/%d'>%s %d - %d %s</a> "
                          "%s</div>" % (m["id"], esc(m["hn"]),
                                        m["home_score"], m["away_score"],
                                        esc(m["an"]),
                                        esc(m["match_date"])))
        return self._send(200, page("상대전적", h, pub=True))

    # -- 공개 API (§40: 화면 필요분만, dump 없음) --
    def _json(self, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _api(self, p, q):
        con = self._db()
        try:
            seg = p[len("/api/"):].strip("/").split("/")
            if seg == ["matches"]:
                if not q.get("round"):
                    return self._send(400, "round required")
                return self._json([dict(m) for m in stats.round_matches(
                    con, q["round"])])
            if len(seg) == 2 and seg[0] == "matches":
                v = stats.match_view(con, seg[1])
                if not v:
                    return self._send(404, "not found")
                m = dict(v["m"])
                m["goals"] = [dict(g) for g in v["goals"]]
                return self._json(m)
            if len(seg) == 2 and seg[0] == "rounds":
                r = con.execute("SELECT * FROM rounds WHERE id = ?",
                                (seg[1],)).fetchone()
                if not r:
                    return self._send(404, "not found")
                out = dict(r)
                out["matches"] = [dict(m) for m in stats.round_matches(
                    con, seg[1])]
                return self._json(out)
            if len(seg) == 2 and seg[0] == "teams":
                s, c = self._scope(con, q)
                if not s:
                    return self._send(404, "not found")
                v = stats.team_view(con, seg[1], s["id"], c["id"])
                if not v:
                    return self._send(404, "not found")
                return self._json({
                    "team": dict(v["team"]), "row": v["row"],
                    "recent": [dict(m) for m in v["recent"]]})
            if len(seg) == 2 and seg[0] == "players":
                s, c = self._scope(con, q)
                if not s:
                    return self._send(404, "not found")
                v = stats.player_view(con, seg[1], s["id"], c["id"])
                if not v:
                    return self._send(404, "not found")
                return self._json({
                    "player": dict(v["p"]),
                    "team": dict(v["team"]) if v["team"] else None,
                    "rows": v["rows"], "total": v["tot"]})
            if seg == ["standings"]:
                s, c = self._scope(con, q)
                if not s:
                    return self._send(404, "not found")
                return self._json(stats.standings(con, c["id"]))
            if seg == ["scorers"]:
                s, c = self._scope(con, q)
                if not s:
                    return self._send(404, "not found")
                return self._json([dict(r) for r in stats.scorers(
                    con, s["id"], c["id"])])
            if seg == ["assists"]:
                s, c = self._scope(con, q)
                if not s:
                    return self._send(404, "not found")
                return self._json([dict(r) for r in stats.assists(
                    con, s["id"], c["id"])])
            return self._send(404, "not found")
        finally:
            con.close()

    # -- 로그인 --
    def _login_page(self):
        if not self.server.pw_hash:
            return self._send(200, page(
                "관리자", "<p class='err'>비밀번호 미설정으로 관리자 비활성."
                " KLEAGUE_ADMIN_PASSWORD 환경변수로 기동하라.</p>"))
        if self._session():
            return self._redirect("/administrator_console/")
        return self._send(200, page(
            "관리자 로그인",
            "<form method='post' action='/administrator_console/login'>"
            "비밀번호 <input type='password' name='pw'>"
            "<button>로그인</button></form>"))

    def _login_do(self):
        f = self._form()
        if self.server.pw_hash and auth.verify_password(
                self.server.pw_hash, f.get("pw", "")):
            tok = secrets.token_urlsafe(24)
            SESSIONS.add(tok)
            return self._redirect("/administrator_console/", "ksess=%s; Path=/; HttpOnly"
                                  % tok)
        return self._send(200, page(
            "관리자 로그인", "<p class='err'>실패</p>"
            "<p><a href='/administrator_console/login'>다시</a></p>"))

    # -- 관리자 화면 --
    def _admin_home(self, con, q=None):
        n = {t: con.execute(
            "SELECT COUNT(*) FROM %s" % t).fetchone()[0]
            for t in ("seasons", "teams", "players", "matches", "goals")}
        msg = "<p>%s</p>" % esc((q or {}).get("msg", "")) if (
            q or {}).get("msg") else ""
        return self._send(200, page(
            "관리홈",
            msg + "<div class='card'>시즌 %d · 팀 %d · 선수 %d · 경기 %d · 득점 %d"
            "</div><ul><li><a href='/administrator_console/seasons'>시즌/대회/라운드</a>"
            "</li><li><a href='/administrator_console/teams'>팀</a></li>"
            "<li><a href='/administrator_console/players'>선수</a></li>"
            "<li><a href='/administrator_console/stadiums'>경기장</a></li>"
            "<li><a href='/administrator_console/reset'>DB 초기화</a></li></ul>"
            % (n["seasons"], n["teams"], n["players"], n["matches"],
               n["goals"]), True))

    def _seasons(self, con):
        rows = con.execute(
            "SELECT * FROM seasons ORDER BY year DESC").fetchall()
        h = ("<form method='post' action='/administrator_console/seasons'>연도 "
             "<input name='year' size='6'> 명칭 <input name='name' size='16'>"
             "<button>시즌 추가</button></form><ul>")
        for r in rows:
            h += ("<li><a href='/administrator_console/season/%d'>%s</a></li>"
                  % (r["id"], esc(r["name"])))
        return self._send(200, page("시즌", h + "</ul>", True))

    def _season(self, con, sid):
        s = con.execute("SELECT * FROM seasons WHERE id = ?",
                        (sid,)).fetchone()
        if not s:
            return self._send(404, page("404", "<p>없음</p>", True))
        comps = con.execute(
            "SELECT * FROM competitions WHERE season_id = ? ORDER BY id",
            (sid,)).fetchall()
        h = ("<form method='post' action='/administrator_console/season/%s/competitions'>"
             "코드 <input name='code' size='6' placeholder='K1'> 명칭 "
             "<input name='name' size='16' placeholder='K리그1'>"
             "<button>대회 추가</button></form><ul>" % esc(sid))
        for c in comps:
            h += ("<li><a href='/administrator_console/competition/%d'>%s</a></li>"
                  % (c["id"], esc(c["name"])))
        return self._send(200, page(s["name"], h + "</ul>", True))

    def _competition(self, con, cid):
        c = con.execute(
            "SELECT c.*, s.name AS sname FROM competitions c"
            " JOIN seasons s ON s.id = c.season_id WHERE c.id = ?",
            (cid,)).fetchone()
        if not c:
            return self._send(404, page("404", "<p>없음</p>", True))
        rnds = con.execute(
            "SELECT * FROM rounds WHERE competition_id = ?"
            " ORDER BY round_number", (cid,)).fetchall()
        h = ("<form method='post' action='/administrator_console/competition/%s/rounds'>"
             "라운드 번호 <input name='number' size='4'>"
             "<button>라운드 추가</button></form><ul>" % esc(cid))
        for r in rnds:
            h += ("<li><a href='/administrator_console/round/%d'>%d라운드</a></li>"
                  % (r["id"], r["round_number"]))
        return self._send(200, page(
            "%s %s" % (c["sname"], c["name"]), h + "</ul>", True))

    def _round(self, con, rid, q):
        r = con.execute(
            "SELECT r.*, s.name AS sname, c.name AS cname FROM rounds r"
            " JOIN seasons s ON s.id = r.season_id"
            " JOIN competitions c ON c.id = r.competition_id"
            " WHERE r.id = ?", (rid,)).fetchone()
        if not r:
            return self._send(404, page("404", "<p>없음</p>", True))
        ms = con.execute(
            "SELECT m.*, ht.name AS hn, at.name AS an FROM matches m"
            " JOIN teams ht ON ht.id = m.home_team_id"
            " JOIN teams at ON at.id = m.away_team_id"
            " WHERE m.round_id = ? ORDER BY m.match_date, m.id",
            (rid,)).fetchall()
        teams = con.execute(
            "SELECT * FROM teams ORDER BY name").fetchall()
        h = "<h2>%s %s %d라운드</h2>" % (
            esc(r["sname"]), esc(r["cname"]), r["round_number"])
        if q.get("warn"):
            h += "<p class='warn'>%s</p>" % esc(q["warn"])
        for m in ms:
            st, _ = store.match_status(con, m["id"])
            h += ("<div class='card'><b>%s %d - %d %s</b> "
                  "<span class='badge'>%s</span><br>%s %s<br>"
                  "<a href='/administrator_console/match/%d'>수정</a> | "
                  "<a href='/matches/%d'>상세</a></div>"
                  % (esc(m["hn"]), m["home_score"], m["away_score"],
                     esc(m["an"]), esc(st), esc(m["match_date"]),
                     esc(m["kickoff_time"] or ""), m["id"], m["id"]))
        opts = "".join("<option value='%d'>%s</option>" % (t["id"], esc(
            t["name"])) for t in teams)
        h += ("<h3>새 경기 (§16 최소 항목)</h3>"
              "<form method='post' action='/administrator_console/round/%s/matches'>"
              "경기일 <input name='match_date' size='10' "
              "placeholder='2026-02-28'><br>홈팀 <select name='home_team_id'>"
              "%s</select> <input name='home_score' size='2' value='0'>"
              "<br>원정팀 <select name='away_team_id'>%s</select> "
              "<input name='away_score' size='2' value='0'><br>"
              "<button>경기 추가</button></form>" % (esc(rid), opts, opts))
        return self._send(200, page("라운드 관리", h, True))

    def _match(self, con, mid, q):
        m = con.execute(
            "SELECT m.*, ht.name AS hn, at.name AS an FROM matches m"
            " JOIN teams ht ON ht.id = m.home_team_id"
            " JOIN teams at ON at.id = m.away_team_id WHERE m.id = ?",
            (mid,)).fetchone()
        if not m:
            return self._send(404, page("404", "<p>없음</p>", True))
        st, cnt = store.match_status(con, mid)
        h = ("<p><a href='/administrator_console/round/%d'>← 라운드로</a> "
             "<span class='badge'>%s</span> "
             "득점입력 홈 %d/%d · 원정 %d/%d</p>"
             % (m["round_id"], esc(st), cnt["gh"], cnt["home_score"],
                cnt["ga"], cnt["away_score"]))
        if q.get("warn"):
            h += "<p class='warn'>%s</p>" % esc(q["warn"])
        stadia = con.execute(
            "SELECT * FROM stadiums ORDER BY name").fetchall()
        sopts = "<option value=''>-</option>" + "".join(
            "<option value='%d'%s>%s</option>" % (
                s["id"], " selected" if m["stadium_id"] == s["id"] else "",
                esc(s["name"])) for s in stadia)
        motm = ""
        if m["motm_player_id"]:
            mp = con.execute("SELECT name FROM players WHERE id = ?",
                             (m["motm_player_id"],)).fetchone()
            motm = esc(mp["name"]) if mp else ""
        h += ("<h3>기본 정보</h3><form method='post' "
              "action='/administrator_console/match/%s'>경기일 "
              "<input name='match_date' size='10' value='%s'> 킥오프 "
              "<input name='kickoff_time' size='5' value='%s'><br>경기장 "
              "<select name='stadium_id'>%s</select> 관중 "
              "<input name='attendance' size='7' value='%s'><br>"
              "%s <input name='home_score' size='2' value='%d'> - "
              "<input name='away_score' size='2' value='%d'> %s<br>"
              "전반 %s - %s<br>MOTM: %s "
              "<button>저장</button></form>"
              "<form method='post' action='/administrator_console/match/%s/motm'>선수ID "
              "<input name='player_id' size='5'>"
              "<button>MOTM 지정</button></form>"
              % (esc(mid), esc(m["match_date"]),
                 esc(m["kickoff_time"] or ""), sopts,
                 esc(m["attendance"] if m["attendance"] is not None
                     else ""), esc(m["hn"]), m["home_score"],
                 m["away_score"], esc(m["an"]),
                 "<input name='home_ht_score' size='2' value='%s'>"
                 % esc(m["home_ht_score"] if m["home_ht_score"] is not None
                       else ""),
                 "<input name='away_ht_score' size='2' value='%s'>"
                 % esc(m["away_ht_score"] if m["away_ht_score"] is not None
                       else ""), motm or "없음", esc(mid)))
        # 득점
        goals = con.execute(
            "SELECT g.*, p.name AS pn, a.name AS an2, t.name AS tn"
            " FROM goals g JOIN players p ON p.id = g.player_id"
            " LEFT JOIN players a ON a.id = g.assist_player_id"
            " JOIN teams t ON t.id = g.team_id"
            " WHERE g.match_id = ? ORDER BY g.id", (mid,)).fetchall()
        h += "<h3>득점</h3>"
        for g in goals:
            h += ("<div>%s' %s (%s)%s%s "
                  "<form method='post' action='/administrator_console/goal/%d/delete' "
                  "style='display:inline'><button>삭제</button></form></div>"
                  % (esc(g["minute"] or "?"), esc(g["pn"]), esc(g["tn"]),
                     " (도움 %s)" % esc(g["an2"]) if g["an2"] else "",
                     " (PK)" if g["is_penalty"] else "", g["id"]))
        recs = con.execute(
            "SELECT player_id FROM match_player_records WHERE match_id = ?",
            (mid,)).fetchall()
        cand = {r["player_id"] for r in recs}
        sq = (q.get("sq") or "").strip()
        if sq:
            for p in store.search_players(con, sq):
                cand.add(p["id"])
        if not cand:
            for p in con.execute(
                    "SELECT id FROM players ORDER BY id LIMIT 30"):
                cand.add(p["id"])
        opts = ""
        for p in con.execute(
                "SELECT id, name FROM players WHERE id IN (%s) ORDER BY name"
                % ",".join("?" * len(cand)), tuple(cand)):
            opts += "<option value='%d'>%s</option>" % (p["id"], esc(
                p["name"]))
        h += ("<form method='post' action='/administrator_console/match/%s/goals'>시간 "
              "<input name='minute' size='4' placeholder='35'> 팀 "
              "<select name='team_id'><option value='%d'>%s</option>"
              "<option value='%d'>%s</option></select><br>득점 "
              "<select name='player_id'>%s</select> 도움 "
              "<select name='assist_player_id'><option value=''>없음</option>"
              "%s</select><br><label><input type='checkbox' name='is_penalty'"
              "> PK</label> <label><input type='checkbox' name='own_goal'>"
              " 자책골</label> <button>득점 추가</button></form>"
              "<form method='get' action='/administrator_console/match/%s'>선수 검색 "
              "<input name='sq' size='8' value='%s'>"
              "<button>검색</button></form>"
              % (esc(mid), m["home_team_id"], esc(m["hn"]),
                 m["away_team_id"], esc(m["an"]), opts, opts, esc(mid),
                 esc(sq)))
        # 출전 기록
        h += "<h3>출전 기록</h3>"
        for tid, tn in ((m["home_team_id"], m["hn"]),
                        (m["away_team_id"], m["an"])):
            h += "<h4>%s</h4>" % esc(tn)
            rs = con.execute(
                "SELECT r.*, p.name FROM match_player_records r"
                " JOIN players p ON p.id = r.player_id"
                " WHERE r.match_id = ? AND r.team_id = ? ORDER BY p.name",
                (mid, tid)).fetchall()
            for r in rs:
                h += ("<div>%s %s%s "
                      "<form method='post' action='/administrator_console/record/%d/update' "
                      "style='display:inline'><label>"
                      "<input type='checkbox' name='started'%s>선발</label>"
                      "<label><input type='checkbox' name='sub'%s>교체</label>"
                      "<button>변경</button></form> "
                      "<form method='post' action='/administrator_console/record/%d/delete' "
                      "style='display:inline'><button>삭제</button></form>"
                      "</div>"
                      % (esc(r["name"]),
                         "선발" if r["started"] else "",
                         "/교체" if r["substitute_appearance"] else "",
                         r["id"], " checked" if r["started"] else "",
                         " checked" if r["substitute_appearance"] else "",
                         r["id"]))
            rq = (q.get("rq") or "").strip()
            found = store.search_players(con, rq) if rq else []
            h += ("<form method='get' action='/administrator_console/match/%s'>선수 검색 "
                  "<input name='rq' size='8' value='%s'>"
                  "<button>검색</button></form>" % (esc(mid), esc(rq)))
            for p in found:
                h += ("<div>%s <form method='post' "
                      "action='/administrator_console/match/%s/records' style='display:inline'>"
                      "<input type='hidden' name='player_id' value='%d'>"
                      "<input type='hidden' name='team_id' value='%d'>"
                      "<button name='started' value='1'>선발 추가</button> "
                      "<button name='sub' value='1'>교체 추가</button>"
                      "</form></div>" % (esc(p["name"]), esc(mid), p["id"],
                                         tid))
        return self._send(200, page(
            "%s %d-%d %s" % (m["hn"], m["home_score"], m["away_score"],
                             m["an"]), h, True))

    def _teams(self, con):
        rows = con.execute(
            "SELECT * FROM teams ORDER BY name").fetchall()
        h = ("<form method='post' action='/administrator_console/teams'>팀명 "
             "<input name='name' size='16'> 약칭 <input name='short' "
             "size='8'><button>팀 추가</button></form><ul>")
        for r in rows:
            h += "<li>%s%s</li>" % (esc(r["name"]),
                                    " (%s)" % esc(r["short_name"])
                                    if r["short_name"] else "")
        return self._send(200, page("팀", h + "</ul>", True))

    def _players(self, con, q):
        sq = (q.get("q") or "").strip()
        rows = store.search_players(con, sq, 50) if sq else con.execute(
            "SELECT * FROM players ORDER BY id DESC LIMIT 50").fetchall()
        h = ("<form method='get' action='/administrator_console/players'>검색 "
             "<input name='q' size='10' value='%s'>"
             "<button>검색</button></form>"
             "<form method='post' action='/administrator_console/players'>이름 "
             "<input name='name' size='10'> 영문 <input name='name_en' "
             "size='12'> 생년월일 <input name='birth_date' size='10'> "
             "국적 <input name='nationality' size='6'> 포지션 "
             "<input name='position' size='4'> 키 <input name='height_cm' "
             "size='4'> 몸무게 <input name='weight_kg' size='4'>"
             "<button>선수 추가</button></form><div class='tw'><table>"
             "<tr><th>ID</th><th>이름</th><th>포지션</th></tr>" % esc(sq))
        for r in rows:
            h += ("<tr><td>%d</td><td>%s</td><td>%s</td></tr>"
                  % (r["id"], esc(r["name"]), esc(r["position"] or "")))
        return self._send(200, page("선수", h + "</table></div>", True))

    def _stadiums(self, con):
        rows = con.execute(
            "SELECT * FROM stadiums ORDER BY name").fetchall()
        h = ("<form method='post' action='/administrator_console/stadiums'>경기장명 "
             "<input name='name' size='20'><button>추가</button></form><ul>")
        for r in rows:
            h += "<li>%s</li>" % esc(r["name"])
        return self._send(200, page("경기장", h + "</ul>", True))

    def _reset_page(self):
        return self._send(200, page(
            "DB 초기화",
            "<p class='err'>전체 데이터 삭제. 복구 불가(§46).</p>"
            "<form method='post' action='/administrator_console/reset'>확인 문구 RESET 입력 "
            "<input name='confirm' size='8'><button>초기화 실행</button>"
            "</form>", True))

    def _password_page(self, errors=()):
        h = errs_html(errors)
        h += ("<form method='post' action='/administrator_console/password'>"
              "현재 비밀번호 <input type='password' name='cur'><br>"
              "새 비밀번호 <input type='password' name='new1'><br>"
              "새 비밀번호 확인 <input type='password' name='new2'><br>"
              "<button>변경</button></form>")
        return self._send(200, page("비밀번호 변경", h, True))

    def _password_do(self, f):
        errors = []
        if not auth.verify_password(self.server.pw_hash,
                                    f.get("cur", "")):
            errors.append("현재 비밀번호 불일치")
        if (f.get("new1", "") or "") != (f.get("new2", "") or ""):
            errors.append("새 비밀번호 확인 불일치")
        if len(f.get("new1", "") or "") < 4:
            errors.append("새 비밀번호 4자 이상")
        if errors:
            return self._password_page(errors)
        auth.save(self.server.pw_path, f["new1"])
        self.server.pw_hash = auth.load(self.server.pw_path)
        mine = self._session()
        SESSIONS.clear()
        if mine:
            SESSIONS.add(mine)  # 내 세션 유지, 나머지는 로그아웃
        return self._redirect("/administrator_console/?msg=" + quote(
            "비밀번호 변경됨"))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(BASE, "private_data",
                                                 "kleague.sqlite"))
    ap.add_argument("--port", type=int, default=8734)
    args = ap.parse_args(argv)
    if not os.path.exists(args.db):
        dblib.init_empty(args.db)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.db_path = args.db
    srv.pw_path = auth.default_path(args.db)
    srv.pw_hash = auth.load(srv.pw_path)
    if not srv.pw_hash and os.environ.get("KLEAGUE_ADMIN_PASSWORD", ""):
        srv.pw_hash = auth.hash_password(
            os.environ["KLEAGUE_ADMIN_PASSWORD"])
    print("serving http://127.0.0.1:%d db=%s admin=%s"
          % (args.port, args.db, "on" if srv.pw_hash else "off"))
    srv.serve_forever()


if __name__ == "__main__":
    main()
