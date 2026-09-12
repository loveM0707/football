"""DB 연결 공용. 외래키 항상 ON."""
import os
import sqlite3

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(BASE, "private_data", "kleague.sqlite")
SCHEMA = os.path.join(BASE, "db", "schema.sql")


def connect(db_path=DEFAULT_DB):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_empty(db_path=DEFAULT_DB):
    """스키마로 초기화 (파일이 없어야 호출)."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    with open(SCHEMA, encoding="utf-8") as f:
        schema = f.read()
    con = connect(db_path)
    try:
        con.executescript(schema)
        con.commit()
    finally:
        con.close()
