[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Gemini Project Studio - Cập nhật"

Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "   DONG BO BAN NANG CAP & SUA LOI VAO PROGRAM FILES" -ForegroundColor Yellow
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

$baseDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$baseDir\extension")) {
    $baseDir = "c:\Users\chann\Downloads\gemini-project-studio-mvp-v0.1.1\gemini-project-studio"
}

Write-Host "1. Kiem tra va dong Gemini Project Studio neu dang mo..." -ForegroundColor Gray
Get-Process -Name "Gemini Project Studio" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$targetDir = "C:\Program Files\Gemini Project Studio\resources"
$extSource = Join-Path $baseDir "extension"
$extTarget = Join-Path $targetDir "extension"
$asarSource = Join-Path $baseDir "release\win-unpacked\resources\app.asar"
$asarTarget = Join-Path $targetDir "app.asar"

$success = $true

if (Test-Path $targetDir) {
    if (Test-Path $extSource) {
        Write-Host "2. Dang sao chep Extension vao Program Files..." -ForegroundColor Gray
        try {
            if (-not (Test-Path $extTarget)) { New-Item -ItemType Directory -Path $extTarget -Force | Out-Null }
            Copy-Item -Path "$extSource\*" -Destination $extTarget -Recurse -Force -ErrorAction Stop
            Write-Host "   [OK] Da sao chep Extension thanh cong." -ForegroundColor Green
        } catch {
            Write-Host "   [LOI] Khong the chep Extension: $_" -ForegroundColor Red
            $success = $false
        }
    }

    if (Test-Path $asarSource) {
        Write-Host "3. Dang cap nhat ung dung Desktop (app.asar)..." -ForegroundColor Gray
        try {
            Copy-Item -Path $asarSource -Destination $asarTarget -Force -ErrorAction Stop
            Write-Host "   [OK] Da cap nhat app.asar thanh cong." -ForegroundColor Green
        } catch {
            Write-Host "   [LOI] Khong the cap nhat app.asar: $_" -ForegroundColor Red
            $success = $false
        }
    }
} else {
    Write-Host "[CANH BAO] Khong tim thay thu muc '$targetDir'." -ForegroundColor Yellow
    Write-Host "Ban co the chay truc tiep file cai dat: release\Gemini Project Studio Setup 0.1.1.exe" -ForegroundColor Yellow
    $success = $false
}

Write-Host ""
if ($success) {
    Write-Host "==============================================================" -ForegroundColor Green
    Write-Host "   CAP NHAT THANH CONG! CAC BUOC TIEP THEO:" -ForegroundColor Green
    Write-Host "==============================================================" -ForegroundColor Green
    Write-Host "1. Vao trinh duyet Chrome/Edge: chrome://extensions hoac edge://extensions" -ForegroundColor White
    Write-Host "2. Bam nut Tai lai (Reload / icon xoay tron) o tien ich Gemini Project Studio Bridge" -ForegroundColor White
    Write-Host "3. F5 (Refresh) lai tab chat gemini.google.com" -ForegroundColor White
    Write-Host "4. Mo lai ung dung Gemini Project Studio va su dung!" -ForegroundColor White
} else {
    Write-Host "Co mot so file chua chep duoc. Ban co the chay file cai dat moi nhat tai:" -ForegroundColor Red
    Write-Host "release\Gemini Project Studio Setup 0.1.1.exe" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Nhan phim Enter de dong cua so nay..." -ForegroundColor Gray
$null = Read-Host
