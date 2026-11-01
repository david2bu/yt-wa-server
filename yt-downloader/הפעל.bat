@echo off
chcp 65001 >nul
cd /d "%~dp0"
title YouTube Downloader

rem Runs the app from source. Most users should use YouTubeDownloader.exe instead.
if exist "venv\Scripts\python.exe" goto run

set "PYEXE="
where py >nul 2>nul && set "PYEXE=py -3"
if not defined PYEXE where python >nul 2>nul && python -c "import sys;sys.exit(sys.version_info<(3,10))" 2>nul && set "PYEXE=python"
if not defined PYEXE (
  echo Python לא מותקן - מתקין אותו עכשיו...
  winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
  set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
)

echo התקנה ראשונה - זה לוקח דקה או שתיים...
%PYEXE% -m venv venv
if not exist "venv\Scripts\python.exe" (
  echo.
  echo לא הצלחתי להתקין Python. התקן מ-https://www.python.org ^(סמן "Add to PATH"^) והפעל שוב.
  pause
  exit /b 1
)
venv\Scripts\python.exe -m pip install -q --disable-pip-version-check --upgrade pip
venv\Scripts\python.exe -m pip install -q --disable-pip-version-check -r requirements.txt

rem Desktop shortcut
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\מוריד יוטיוב.lnk');$s.TargetPath='%~dp0הפעל.bat';$s.WorkingDirectory='%~dp0';$s.IconLocation='%~dp0assets\icon.ico';$s.Save()" >nul 2>nul

:run
start "" venv\Scripts\pythonw.exe -X utf8 app.py
