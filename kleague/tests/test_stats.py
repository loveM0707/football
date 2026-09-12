#!/usr/bin/env python3
"""stats 테스트: 원본 기반 계산 (§32).

실행: py -m unittest discover -s tests -v  (kleague/ 루트에서)
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".."))
from lib import db as dblib  # noqa: E402
from lib import store  # noqa: E402
from lib import stats  # noqa: E402


class StatsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleague_stats_")
        self.db = os.path.join(self.tmp, "t.sqlite")
        dblib.init_empty(self.db)
        self.con = dblib.connect(self.db)
        s, _ = store.create_season(self.con, 2026, "2026")
        c, _ = store.create_competition(self.con, s, "K1", "K리그1")
        self.s, self.c = s, c
        r1, _ = store.create_round(self.con, s, c, 1)
        r2, _ = store.create_round(self.con, s, c, 2)
        self.r1, self.r2 = r1, r2
        self.a, _ = store.create_team(self.con, "인천", "인천")
        self.b, _ = store.create_team(self.con, "서울", "서울")
        self.cc, _ = store.create_team(self.con, "울산", "울산")
        self.p1, _ = store.create_player(self.con, {"name": "김○○"})
        self.p2, _ = store.create_player(self.con, {"name": "박○○"})
        self.p3, _ = store.create_player(self.con, {"name": "이○○"})

        def match(rnd, date, h, a, hs, aws):
            mid, errs = store.create_match(self.con, {
                "round_id": rnd, "match_date": date, "home_team_id": h,
                "away_team_id": a, "home_score": hs, "away_score": aws})
            assert errs == [], errs
            return mid

        # R1: 인천 1-0 서울 (김○○ 35')
        m1 = match(r1, "2026-02-28", self.a, self.b, 1, 0)
        store.add_record(self.con, m1, self.p1, self.a, True, False)
        store.add_record(self.con, m1, self.p2, self.b, True, False)
        store.add_goal(self.con, m1, {"team_id": self.a,
                                      "player_id": self.p1,
                                      "minute": "35"})
        # R1: 서울 2-2 울산 (박○○ 10', 박○○ PK 50' 도움 이○○)
        m2 = match(r1, "2026-03-01", self.b, self.cc, 2, 2)
        store.add_record(self.con, m2, self.p2, self.b, True, False)
        store.add_record(self.con, m2, self.p3, self.b, False, True)
        store.add_goal(self.con, m2, {"team_id": self.b,
                                      "player_id": self.p2,
                                      "minute": "10"})
        store.add_goal(self.con, m2, {"team_id": self.b,
                                      "player_id": self.p2,
                                      "assist_player_id": self.p3,
                                      "minute": "50", "is_penalty": "1"})
        # R2: 울산 0-1 인천 (김○○ 80')
        m3 = match(r2, "2026-03-08", self.cc, self.a, 0, 1)
        store.add_record(self.con, m3, self.p1, self.a, True, False)
        store.add_goal(self.con, m3, {"team_id": self.a,
                                      "player_id": self.p1,
                                      "minute": "80"})
        self.m1 = m1

    def tearDown(self):
        self.con.close()

    def test_standings(self):
        t = stats.standings(self.con, self.c)
        self.assertEqual([r["name"] for r in t], ["인천", "서울", "울산"])
        inc = t[0]
        self.assertEqual(
            (inc["p"], inc["w"], inc["d"], inc["l"], inc["gf"],
             inc["ga"], inc["gd"], inc["pts"]), (2, 2, 0, 0, 2, 0, 2, 6))
        seo = t[1]
        self.assertEqual((seo["p"], seo["pts"]), (2, 1))

    def test_scorers_pk_split(self):
        sc = stats.scorers(self.con, self.s, self.c)
        self.assertEqual([(r["name"], r["gl"], r["pk"]) for r in sc],
                         [("김○○", 2, 0), ("박○○", 2, 1)])

    def test_assists(self):
        a = stats.assists(self.con, self.s, self.c)
        self.assertEqual([(r["name"], r["ast"]) for r in a],
                         [("이○○", 1)])

    def test_player_round_rows(self):
        v = stats.player_view(self.con, self.p2, self.s, self.c)
        self.assertEqual(len(v["rows"]), 1)
        r = v["rows"][0]
        self.assertEqual(
            (r["round"], r["st"], r["sub"], r["gl"], r["pk"], r["ast"]),
            (1, 1, 0, 2, 1, 0))
        self.assertEqual(v["tot"]["gl"], 2)

    def test_player_substitute(self):
        v = stats.player_view(self.con, self.p3, self.s, self.c)
        self.assertEqual(
            (v["rows"][0]["sub"], v["rows"][0]["ast"]), (1, 1))

    def test_h2h(self):
        st, ms = stats.h2h(self.con, self.a, self.b)
        self.assertEqual(
            (st["n"], st["aw"], st["d"], st["bw"],
             st["gf_a"], st["ga_a"]), (1, 1, 0, 0, 1, 0))
        self.assertEqual(len(ms), 1)

    def test_match_view_empty(self):
        mid, _ = store.create_match(self.con, {
            "round_id": self.r2, "match_date": "2026-03-09",
            "home_team_id": self.b, "away_team_id": self.cc,
            "home_score": 0, "away_score": 0})
        v = stats.match_view(self.con, mid)
        self.assertEqual(v["goals"], [])
        self.assertEqual(v["recs"][self.b], [])

    def test_team_view(self):
        v = stats.team_view(self.con, self.a, self.s, self.c)
        self.assertEqual(v["row"]["pts"], 6)
        self.assertEqual(len(v["recent"]), 2)
        self.assertEqual(v["players"][0]["name"], "김○○")


if __name__ == "__main__":
    unittest.main()
