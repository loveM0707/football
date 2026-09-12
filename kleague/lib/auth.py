"""관리자 비밀번호. 해시만 저장 (평문 보관 없음).

우선순위: private_data/.admin_pw 파일 > KLEAGUE_ADMIN_PASSWORD 환경변수.
변경한 비밀번호는 서버 재시작 후에도 유지된다.
"""
import hashlib
import hmac
import os
import secrets

ITERATIONS = 200_000


def default_path(db_path):
    return os.path.join(os.path.dirname(os.path.abspath(db_path)),
                        ".admin_pw")


def hash_password(password):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt,
                             ITERATIONS)
    return "%s:%s" % (salt.hex(), dk.hex())


def verify_password(stored, password):
    try:
        salt_hex, dk_hex = stored.split(":")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 bytes.fromhex(salt_hex), ITERATIONS)
        return hmac.compare_digest(dk.hex(), dk_hex)
    except Exception:
        return False


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            stored = f.read().strip()
        return stored if stored else None
    except OSError:
        return None


def save(path, password):
    with open(path, "w", encoding="utf-8") as f:
        f.write(hash_password(password))
