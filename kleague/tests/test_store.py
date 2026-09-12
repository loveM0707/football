#!/usr/bin/env python3
"""store 테스트: 검증(§37)·일관성(§38)·부분 입력(§17).

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


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleague_store_")
        self.db = os.path.join(self.tmp, "t.sqlite")
        dblib.init_empty(self.db)
        self.con = dblib.connect(self.db)
        self.season, _ = store.create_season(self.con, 2026, "2026")
        self.comp, _ = store.create_competition(
            self.con, self.season, "K1", "K리그1")
        self.rnd, _ = store.create_round(
            self.con, self.season, self.comp, 1)
        self.home, _ = store.create_team(self.con, "인천", "인천")
        self.away, _ = store.create_team(self.con, "서울", "서울")

    def tearDown(self):
        self.con.close()

    def mk_match(self, **kw):
        f = {"round_id": self.rnd, "match_date": "2026-02-28",
             "home_team_id": self.home, "away_team_id": self.away,
             "home_score": 1, "away_score": 2}
        f.update(kw)
        return store.create_match(self.con, f)

    def mk_player(self, name="김○○"):
        pid, errs = store.create_player(self.con, {"name": name})
        self.assertEqual(errs, [])
        return pid

    # 최소 항목만으로 생성 (§16)
    def test_minimal_match(self):
        mid, errs = self.mk_match()
        self.assertEqual(errs, [])
        self.assertIsNotNone(mid)

    def test_same_team(self):
        _, errs = self.mk_match(away_team_id=self.home)
        self.assertTrue(any("같음" in e for e in errs))

    def test_negative_score(self):
        _, errs = self.mk_match(home_score=-1)
        self.assertTrue(any("음수" in e for e in errs))

    def test_duplicate_fixture(self):
        self.mk_match()
        _, errs = self.mk_match()
        self.assertTrue(any("중복" in e for e in errs))

    # 부분 입력: 득점 없이 정상 저장, 상태 미입력 (§17, §38)
    def test_partial_status_empty(self):
        mid, _ = self.mk_match()
        st, c = store.match_status(self.con, mid)
        self.assertEqual(st, "미입력")

    def test_goal_flow_and_status(self):
        mid, _ = self.mk_match(home_score=0)
        p1, p2 = self.mk_player("김○○"), self.mk_player("박○○")
        # 명단 없이 득점 → 저장 + warning 없음
        _, errs, warns = store.add_goal(self.con, mid, {
            "team_id": self.away, "player_id": p1,
            "assist_player_id": p2, "minute": "35"})
        self.assertEqual(errs, [])
        self.assertEqual(warns, [])
        st, _ = store.match_status(self.con, mid)
        self.assertEqual(st, "불일치")
        # 명단 등록 후 명단 밖 선수 득점 → 저장 + warning
        store.add_record(self.con, mid, p1, self.away, True, False)
        p3 = self.mk_player("이○○")
        _, errs, warns = store.add_goal(self.con, mid, {
            "team_id": self.away, "player_id": p3, "minute": "67",
            "is_penalty": "1"})
        self.assertEqual(errs, [])
        self.assertTrue(warns)
        st, _ = store.match_status(self.con, mid)
        self.assertEqual(st, "정상")

    def test_goal_wrong_team(self):
        mid, _ = self.mk_match()
        p = self.mk_player()
        other, _ = store.create_team(self.con, "울산", "울산")
        _, errs, _ = store.add_goal(self.con, mid, {
            "team_id": other, "player_id": p})
        self.assertTrue(any("경기 팀" in e for e in errs))

    def test_duplicate_record(self):
        mid, _ = self.mk_match()
        p = self.mk_player()
        self.assertEqual(store.add_record(
            self.con, mid, p, self.home, True, False), [])
        errs = store.add_record(self.con, mid, p, self.home, False, True)
        self.assertTrue(any("중복" in e for e in errs))

    def test_record_needs_flag(self):
        mid, _ = self.mk_match()
        p = self.mk_player()
        errs = store.add_record(self.con, mid, p, self.home, False, False)
        self.assertTrue(errs)

    def test_starter_sub_both(self):
        """선발+교체 동시 허용 (§10)."""
        mid, _ = self.mk_match()
        p = self.mk_player()
        self.assertEqual(store.add_record(
            self.con, mid, p, self.home, True, True), [])

    def test_reset(self):
        self.mk_match()
        self.con.close()  # Windows: 열린 파일 삭제 불가
        store.reset_db(self.db)
        con2 = dblib.connect(self.db)
        try:
            n = con2.execute(
                "SELECT COUNT(*) FROM matches").fetchone()[0]
            self.assertEqual(n, 0)
        finally:
            con2.close()


if __name__ == "__main__":
    unittest.main()
