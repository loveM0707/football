#!/usr/bin/env python3
"""Phase 5 테스트: 정적 파일 경로 검증 (§39 traversal 차단).

실행: py -m unittest discover -s tests -v  (kleague/ 루트에서)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "server"))
import app as server_app  # noqa: E402


class StaticTest(unittest.TestCase):
    def test_css_ok(self):
        p = server_app.static_path("style.css")
        self.assertTrue(p and p.endswith("style.css"))

    def test_traversal_blocked(self):
        for bad in ("../server/app.py", "..\\server\\app.py", "",
                    "a/b.css", "a b.css", ".", "x/../../y"):
            self.assertIsNone(server_app.static_path(bad), bad)

    def test_missing_none(self):
        self.assertIsNone(server_app.static_path("nope.css"))


if __name__ == "__main__":
    unittest.main()
