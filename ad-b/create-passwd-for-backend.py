#!/usr/bin/env python3
"""
Admin kullanıcısı için bcrypt şifre hash'i üretir.

Kullanım:
    python create-passwd-for-backend.py

Şifre etkileşimli olarak sorulur; komut satırı argümanı olarak GEÇİLMEZ ve
kaynak koda GÖMÜLMEZ (aksi halde shell geçmişine ve repoya sızar).

Çıktıyı adm_users tablosuna ekleyin:
    INSERT INTO adm_users (email, password) VALUES ('admin@example.com', '<hash>');
"""

import getpass
import sys

import bcrypt

MIN_LENGTH = 12


def main() -> int:
    password = getpass.getpass("Yeni admin şifresi: ")
    confirm = getpass.getpass("Şifreyi tekrar girin: ")

    if password != confirm:
        print("HATA: Şifreler eşleşmiyor.", file=sys.stderr)
        return 1

    if len(password) < MIN_LENGTH:
        print(f"HATA: Şifre en az {MIN_LENGTH} karakter olmalıdır.", file=sys.stderr)
        return 1

    # 12 rounds (cost factor) ile salt oluştur ve hash'le
    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12))
    print(hashed.decode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
