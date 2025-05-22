@echo off
cd /d "C:\Users\ronen\OneDrive\Mine\Projects\wa_duplicate_bot"
echo [%date% %time%] Starting WA‑dup bot >> bot.log
node bot.js >> bot.log 2>&1
echo [%date% %time%] Bot.exe exited with code %errorlevel% >> bot.log
