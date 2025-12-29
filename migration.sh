#!/bin/bash
docker compose down
docker compose up -d --build
echo "Konteynerlar başlatılıyor, veritabanı için 15 saniye bekleniyor..."
sleep 15
if [ -f "clearcart_full_backup.sql" ]; then
    cat clearcart_full_backup.sql | docker exec -i clearcart-db psql -U postgres -d clearcart
    echo "Veritabanı yedeği başarıyla geri yüklendi."
else
    echo "SQL dosyası bulunamadı, veritabanı restore edilemedi!"
fi
chmod 600 backend/keys/*.pem 2>/dev/null
chmod 600 backend/client_keys/* 2>/dev/null
echo "Kurulum ve Taşıma Tamamlandı!"