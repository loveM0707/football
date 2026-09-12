#!/usr/bin/env python3
"""auth 테스트: 해시 저장·검증.

실행: py -m unittest discover -s tests -v  (kleague/ 루트에서)
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".."))
from lib import auth  # noqa: E402


class AuthTest(unittest.TestCase):
    def test_roundtrip(self):
        tmp = os.path.join(tempfile.mkdtemp(prefix="kleague_auth_"),
                           ".admin_pw")
        auth.save(tmp, "new-pw-123")
        stored = auth.load(tmp)
        self.assertTrue(stored)
        self.assertNotIn("new-pw-123", stored)
        self.assertTrue(auth.verify_password(stored, "new-pw-123"))
        self.assertFalse(auth.verify_password(stored, "wrong"))

    def test_missing(self):
        self.assertIsNone(auth.load(os.path.join(
            tempfile.mkdtemp(prefix="kleague_auth_"), "nope")))


if __name__ == "__main__":
    unittest.main()
