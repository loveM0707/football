#!/usr/bin/env python3
"""빈 운영 DB 초기화 (§1, §45). 이미 있으면 손대지 않는다.

사용: py tools/init_db.py [--db private_data/kleague.sqlite]
"""
import argparse
import os
import sqlite3
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(BASE, "private_data", "kleague.sqlite")
SCHEMA = os.path.join(BASE, "db", "schema.sql")


def main(argv=None):
    ap = argparse.ArgumentParser(description="빈 운영 DB 초기화")
    ap.add_argument("--db", default=DEFAULT_DB)
    args = ap.parse_args(argv)

    if os.path.exists(args.db):
        print("exists (변경 없음): %s" % args.db)
        return 0
    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    with open(SCHEMA, encoding="utf-8") as f:
        schema = f.read()
    con = sqlite3.connect(args.db)
    try:
        con.executescript(schema)
        con.commit()
    finally:
        con.close()
    print("created: %s" % args.db)
    return 0


if __name__ == "__main__":
    sys.exit(main())
