#!/usr/bin/env python3
"""스키마 테스트: 9개 테이블 존재 + 운영 DB 빈 상태 (§45).

실행: py -m unittest discover -s tests -v  (kleague/ 루트에서)
"""
import os
import sqlite3
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(BASE, "db", "schema.sql")
TABLES = ("seasons", "competitions", "rounds", "teams", "players",
          "stadiums", "matches", "match_player_records", "goals")


class SchemaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kleague_test_")
        self.db = os.path.join(self.tmp, "t.sqlite")
        with open(SCHEMA, encoding="utf-8") as f:
            schema = f.read()
        self.con = sqlite3.connect(self.db)
        self.con.executescript(schema)

    def tearDown(self):
        self.con.close()

    def test_tables_exist(self):
        names = {r[0] for r in self.con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        for t in TABLES:
            self.assertIn(t, names, t)
        # cards 테이블이 없어야 한다 (§31)
        self.assertNotIn("cards", names)

    def test_empty(self):
        for t in TABLES:
            n = self.con.execute(
                "SELECT COUNT(*) FROM %s" % t).fetchone()[0]
            self.assertEqual(n, 0, t)


if __name__ == "__main__":
    unittest.main()
