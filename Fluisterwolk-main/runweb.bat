@echo off
REM Change to the directory of the project
cd /d "C:\Users\Gebruiker\Desktop\Fluisterwolk"

REM Activate the virtual environment
call venv\Scripts\activate.bat

REM Run the Python script
python WhisperWebviewer.py

REM Keep the window open to show any output or errors
pause
