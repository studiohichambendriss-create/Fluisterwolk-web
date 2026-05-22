@echo off
REM Change to the directory of the project
cd /d "C:\Users\Gebruiker\Desktop\Fluisterwolk"

REM Activate the virtual environment
call venv\Scripts\activate.bat

REM Run the Python script
python fluiserbox2.0.py

REM Keep the window open (optional, if you want to see the output/errors)
pause
