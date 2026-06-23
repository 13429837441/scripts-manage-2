@echo off
title Stop Server
echo.
echo Checking port 3000...
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo Found process PID: %%a
    echo Killing process...
    taskkill /f /pid %%a
    echo Process killed
    goto :end
)

echo Port 3000 is not in use

:end
echo.
echo Done, press any key to exit...
pause >nul