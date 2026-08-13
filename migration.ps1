$MigrationFolder = ".\BackupFolder"
$Date = Get-Date -Format "yyyy-MM-dd"

# ---------------------------------------------------------
# VERİTABANI KİMLİK BİLGİLERİ (.env dosyasından okunur)
# Şifreyi ASLA bu dosyaya yazmayın — script'ler de repoya gider.
# ---------------------------------------------------------
if (-not (Test-Path ".\.env")) {
    Write-Host "HATA: .env dosyasi bulunamadi. Once '.env.example' dosyasini '.env' olarak kopyalayin." -ForegroundColor Red
    Exit 1
}

$EnvVars = @{}
Get-Content ".\.env" | ForEach-Object {
    if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*)$') { $EnvVars[$Matches[1]] = $Matches[2] }
}

$PgUser = $EnvVars['POSTGRES_USER']
$PgPassword = $EnvVars['POSTGRES_PASSWORD']
$PgDb = $EnvVars['POSTGRES_DB']

if ([string]::IsNullOrWhiteSpace($PgPassword)) {
    Write-Host "HATA: .env icinde POSTGRES_PASSWORD tanimli degil." -ForegroundColor Red
    Exit 1
}

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
docker exec -e "PGPASSWORD=$PgPassword" -e PGCLIENTENCODING=UTF8 clearcart-db pg_dump -U $PgUser -d $PgDb -F p -E UTF8 -f /tmp/clearcart_full_backup.sql

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

# RSA anahtarları, .htpasswd ve .env DIŞARIDA BIRAKILIR.
# (Bu klasör geçmişte olduğu gibi yanlışlıkla commit edilirse secret sızmasın.)
$ExcludeDirs = @("node_modules", ".git", ".idea", ".vscode", "dist", "build", "coverage", "keys", "client_keys", "user_uploads", "venv")
$ExcludeFiles = @(".env", ".htpasswd", "*.pem", "*.key")
$Source = "."
$Dest = $MigrationFolder

robocopy "$Source\backend" "$Dest\backend" /E /XD $ExcludeDirs /XF $ExcludeFiles /NFL /NDL /NJH /NJS
robocopy "$Source\ad-b" "$Dest\ad-b" /E /XD $ExcludeDirs /XF $ExcludeFiles /NFL /NDL /NJH /NJS
robocopy "$Source\nginx" "$Dest\nginx" /E /XD $ExcludeDirs /XF $ExcludeFiles /NFL /NDL /NJH /NJS
Copy-Item "docker-compose.yml" -Destination $Dest
Copy-Item ".env.example" -Destination $Dest

Write-Host "---------------------------------------------------"
Write-Host "HAZIRLIK TAMAMLANDI!" -ForegroundColor Green
Write-Host "Olusan .sql dosyasini VS Code ile acarsan Turkce karakterlerin duzgun oldugunu goreceksin." -ForegroundColor Cyan
Write-Host ""
Write-Host "DIKKAT: BackupFolder icindeki .sql dosyasi KISISEL VERI icerir" -ForegroundColor Yellow
Write-Host "(kullanici e-postalari, telefon, sifre hash'leri, JWT token'lari)." -ForegroundColor Yellow
Write-Host "Bu klasoru ASLA git'e ekleme - .gitignore'da zaten haric tutuldu." -ForegroundColor Yellow
Write-Host "---------------------------------------------------"