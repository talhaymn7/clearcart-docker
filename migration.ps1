$MigrationFolder = ".\Linux_Migration_Pack"
$Date = Get-Date -Format "yyyy-MM-dd"

If (Test-Path $MigrationFolder) { Remove-Item $MigrationFolder -Recurse -Force }
New-Item -ItemType Directory -Force -Path $MigrationFolder | Out-Null
Write-Host "Paketleme klasörü oluşturuldu..." -ForegroundColor Cyan

Write-Host "Veritabanı dışarı aktarılıyor (Dump)..." -ForegroundColor Yellow
docker exec -e PGPASSWORD=REMOVED-DB-PASSWORD clearcart-db pg_dump -U postgres -d clearcart > "$MigrationFolder\clearcart_full_backup.sql"

if ($LASTEXITCODE -eq 0) {
    Write-Host "Veritabanı yedeği alındı." -ForegroundColor Green
} else {
    Write-Host "HATA: Veritabanı yedeği alınamadı! Container çalışıyor mu?" -ForegroundColor Red
    Exit
}

Write-Host "Dosyalar kopyalanıyor (node_modules hariç tutuluyor)..." -ForegroundColor Yellow

$ExcludeDirs = @("node_modules", ".git", ".idea", ".vscode", "dist", "build")
$Source = "."
$Dest = $MigrationFolder

robocopy "$Source\backend" "$Dest\backend" /E /XD $ExcludeDirs /NFL /NDL /NJH /NJS
robocopy "$Source\ad-b" "$Dest\ad-b" /E /XD $ExcludeDirs /NFL /NDL /NJH /NJS
robocopy "$Source\nginx" "$Dest\nginx" /E /XD $ExcludeDirs /NFL /NDL /NJH /NJS
Copy-Item "docker-compose.yml" -Destination $Dest

Write-Host "---------------------------------------------------"
Write-Host "HAZIRLIK TAMAMLANDI!" -ForegroundColor Green
Write-Host "Lütfen '$MigrationFolder' klasörünü Ubuntu sunucuna taşı." -ForegroundColor Cyan
Write-Host "---------------------------------------------------"