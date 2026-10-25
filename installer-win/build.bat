@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  Central de Deploy — gerando o .exe
echo ============================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo ERRO: Python nao encontrado no PATH.
  pause
  exit /b 1
)

echo [1/3] Dependencias...
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo Falha ao instalar dependencias.
  pause
  exit /b 1
)

echo [2/3] Compilando .exe...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

python -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --windowed ^
  --name "Central-de-Deploy" ^
  --collect-data customtkinter ^
  --hidden-import paramiko ^
  --hidden-import cryptography ^
  install_gui.py

if errorlevel 1 (
  echo Falha no PyInstaller.
  pause
  exit /b 1
)

echo [3/3] Pronto!
echo   %cd%\dist\Central-de-Deploy.exe
echo.
echo O .exe le o codigo das pastas dos projetos (ao lado desta pasta ou a que voce escolher na tela inicial).
pause
