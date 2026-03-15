$MigrationFolder = ".\BackupFolder"
$Date = Get-Date -Format "yyyy-MM-dd"

# Klasör temizliği
If (Test-Path $MigrationFolder) { Remove-Item $MigrationFolder -Recurse -Force }
New-Item -ItemType Directory -Force -Path $MigrationFolder | Out-Null
Write-Host "Paketleme klasörü oluşturuldu..." -ForegroundColor Cyan

# ---------------------------------------------------------
# VERİTABANI YEDEĞİ (TÜRKÇE KARAKTER GARANTİLİ)
# ---------------------------------------------------------
Write-Host "Veritabanı dışarı aktarılıyor (UTF-8 Plain Text)..." -ForegroundColor Yellow

# Önce eski geçici dosyayı temizle
docker exec clearcart-db rm -f /tmp/clearcart_full_backup.sql

# 🛠️ KRİTİK KOMUT:
# 1. -e PGCLIENTENCODING=UTF8 : PostgreSQL client'ını UTF-8 moduna zorla.
# 2. -F p : Plain Text formatı (Notepad ile okunabilir).
# 3. -E UTF8 : Export encoding UTF-8 olsun.
docker exec -e PGPASSWORD=REMOVED-DB-PASSWORD -e PGCLIENTENCODING=UTF8 clearcart-db pg_dump -U postgres -d clearcart -F p -E UTF8 -f /tmp/clearcart_full_backup.sql

if ($LASTEXITCODE -eq 0) {
    Write-Host "Yedek container içinde oluşturuldu, masaüstüne alınıyor..." -ForegroundColor Cyan
    
    # docker cp ile dosyayı byte-byte kopyala (Karakter bozulmasını engeller)
    docker cp clearcart-db:/tmp/clearcart_full_backup.sql "$MigrationFolder\clearcart_full_backup.sql"
    
    # İçerideki çöpü sil
    docker exec clearcart-db rm /tmp/clearcart_full_backup.sql
    
    Write-Host "✅ Veritabanı yedeği alındı." -ForegroundColor Green
} else {
    Write-Host "❌ HATA: Veritabanı yedeği alınamadı!" -ForegroundColor Red
    Exit
}

# ---------------------------------------------------------
# DOSYA KOPYALAMA
# ---------------------------------------------------------
Write-Host "Dosyalar kopyalanıyor..." -ForegroundColor Yellow

$ExcludeDirs = @("node_modules", ".git", ".idea", ".vscode", "dist", "build", "coverage")
$Source = "."
$Dest = $MigrationFolder

robocopy "$Source\backend" "$Dest\backend" /E /XD $ExcludeDirs /NFL /NDL /NJH /NJS
robocopy "$Source\ad-b" "$Dest\ad-b" /E /XD $ExcludeDirs /NFL /NDL /NJH /NJS
robocopy "$Source\nginx" "$Dest\nginx" /E /XD $ExcludeDirs /NFL /NDL /NJH /NJS
Copy-Item "docker-compose.yml" -Destination $Dest

Write-Host "---------------------------------------------------"
Write-Host "HAZIRLIK TAMAMLANDI!" -ForegroundColor Green
Write-Host "Oluşan .sql dosyasını VS Code ile açarsan Türkçe karakterlerin düzgün olduğunu göreceksin." -ForegroundColor Cyan
Write-Host "---------------------------------------------------"