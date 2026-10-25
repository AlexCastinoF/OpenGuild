@echo off
cd /d "%~dp0"
python -m pip install -r installer-win\requirements.txt
python installer-win\install_gui.py
if errorlevel 1 pause
