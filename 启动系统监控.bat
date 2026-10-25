@echo off
chcp 936 >nul
setlocal EnableDelayedExpansion
title 系统监控 - System Monitor
cd /d "%~dp0"

set "PORT=3000"
set "LOGFILE=%~dp0server.log"
set "ERRFILE=%~dp0server.err.log"
set "RUNTIME=%~dp0runtime"
set "NODE_VERSION=22.11.0"

echo ========================================
echo   系统监控 - 启动中...
echo ========================================
echo.

REM ===== 1. 服务已在运行：直接打开页面，不重复启动 =====
netstat -ano | findstr /i "LISTENING" | findstr ":!PORT! " >nul
if !errorlevel! equ 0 (
    powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:!PORT!/api/metrics' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
    if !errorlevel! equ 0 (
        echo [信息] 系统监控已在后台运行，正在打开页面...
        if not defined MONITOR_NO_BROWSER start "" "http://localhost:!PORT!"
        echo.
        echo 后端服务与托盘图标会继续运行，此窗口可以关闭。
        ping -n 3 127.0.0.1 >nul
        exit /b 0
    )
    echo [错误] 端口 !PORT! 已被其他程序占用，系统监控无法启动。
    echo        可用以下命令查看占用进程：netstat -ano ^| findstr :!PORT!
    echo.
    pause
    exit /b 1
)

REM ===== 2. 依赖检查：Node.js v18 或更高版本 =====
set "NODE_EXE="
set "NODE_VER="

call :try_node "%RUNTIME%\node\node.exe"
if not defined NODE_EXE for %%A in (node.exe) do if not defined NODE_EXE if exist "%%~$PATH:A" call :try_node "%%~$PATH:A"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" call :try_node "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" call :try_node "%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" call :try_node "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\node.exe" call :try_node "%LOCALAPPDATA%\Microsoft\WinGet\Links\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.lmstudio\.internal\utils\node.exe" call :try_node "%USERPROFILE%\.lmstudio\.internal\utils\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" call :try_node "%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\current\node.exe" call :try_node "%APPDATA%\nvm\current\node.exe"

if defined NODE_EXE goto :node_ready

echo [依赖] 未检测到 Node.js v18 或更高版本。
echo [依赖] 正在从国内镜像下载便携版并自动部署，请稍候...
echo.
call :install_node
if not defined NODE_EXE goto :dep_failed

:node_ready
echo [OK] Node.js: !NODE_EXE!  版本 !NODE_VER!
if /i "!NODE_EXE!"=="%RUNTIME%\node\node.exe" echo [OK] 使用项目内置运行时，无需安装 Node.js。

REM ===== 前端依赖：Chart.js 本地文件 =====
if not exist "%~dp0public\vendor\chart.umd.js" call :install_chart
if not exist "%~dp0public\vendor\chart.umd.js" (
    echo [警告] 图表库下载失败，曲线图将无法显示，其余功能不受影响。
)

REM ===== 3. 后台启动服务：隐藏窗口，关闭本窗口不会停止服务 =====
echo [启动] 正在后台启动服务...
if exist "%LOGFILE%" del /q "%LOGFILE%" >nul 2>&1
if exist "%ERRFILE%" del /q "%ERRFILE%" >nul 2>&1

set "APP_DIR=%~dp0"
set "SM_LOG=%LOGFILE%"
set "SM_ERR=%ERRFILE%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $p = Start-Process -FilePath $env:NODE_EXE -ArgumentList 'server.js' -WorkingDirectory $env:APP_DIR -WindowStyle Hidden -RedirectStandardOutput $env:SM_LOG -RedirectStandardError $env:SM_ERR -PassThru -ErrorAction Stop; if (-not $p) { exit 1 } } catch { exit 1 }"
if !errorlevel! neq 0 (
    echo [错误] 无法创建后台进程，请检查安全软件是否拦截了 PowerShell。
    echo.
    pause
    exit /b 1
)

REM ===== 4. 等待接口就绪，最多约 12 秒 =====
powershell.exe -NoProfile -Command "$ok = $false; for ($i = 0; $i -lt 48; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:!PORT!/api/metrics' -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}; Start-Sleep -Milliseconds 250 }; if ($ok) { exit 0 } else { exit 1 }"
if !errorlevel! neq 0 goto :failed

:ready
REM ===== 5. 获取局域网 IP，跳过虚拟网卡 =====
set "LAN_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "CAND=%%a"
    set "CAND=!CAND: =!"
    if not defined LAN_IP (
        echo !CAND! | findstr /r /c:"^198\.18\." /c:"^169\.254\." >nul || set "LAN_IP=!CAND!"
    )
)
if not defined LAN_IP set "LAN_IP=127.0.0.1"

echo.
echo ========================================
echo   系统监控已启动（后台运行）
echo ========================================
echo   本机访问:   http://localhost:!PORT!
echo   局域网访问: http://!LAN_IP!:!PORT!
echo   后台进程:   已隐藏，关闭本窗口不会停止服务
echo   托盘图标:   右键查看占用 / 打开页面 / 结束后台进程
echo ========================================
echo.

if not defined MONITOR_NO_BROWSER start "" "http://localhost:!PORT!"

echo 提示：首次运行如弹出 Windows 防火墙提示，请点击“允许访问”。
echo 此窗口将在 4 秒后自动关闭。
ping -n 5 127.0.0.1 >nul
exit /b 0

:failed
echo.
echo [错误] 服务没有启动成功，下面是错误日志：
echo ----------------------------------------
if exist "%ERRFILE%" type "%ERRFILE%"
if exist "%LOGFILE%" type "%LOGFILE%"
echo ----------------------------------------
echo 常见原因：
echo   1. 端口 !PORT! 被其他程序占用：netstat -ano ^| findstr :!PORT!
echo   2. Node.js 版本过低，需要 v18 或更高版本
echo   3. 安全软件拦截了 node.exe 或 PowerShell
echo.
pause
exit /b 1

REM ========================================
REM  子过程
REM ========================================

:try_node
if not exist "%~1" exit /b 0
set "CVER="
set "CMAJ="
"%~1" -v > "%TEMP%\sm_node_ver.txt" 2>nul
if errorlevel 1 exit /b 0
set /p CVER=<"%TEMP%\sm_node_ver.txt"
del /q "%TEMP%\sm_node_ver.txt" >nul 2>&1
if not defined CVER exit /b 0
for /f "tokens=1 delims=." %%a in ("!CVER:v=!") do set "CMAJ=%%a"
if not defined CMAJ exit /b 0
if !CMAJ! lss 18 exit /b 0
set "NODE_EXE=%~1"
set "NODE_VER=!CVER!"
exit /b 0

:install_node
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" set "ARCH=x86"
set "PKG=node-v!NODE_VERSION!-win-!ARCH!"
set "URL1=https://npmmirror.com/mirrors/node/v!NODE_VERSION!/!PKG!.zip"
set "URL2=https://mirrors.cloud.tencent.com/nodejs-release/v!NODE_VERSION!/!PKG!.zip"
set "URL3=https://mirrors.huaweicloud.com/nodejs/v!NODE_VERSION!/!PKG!.zip"
set "ZIP=%~dp0node-portable.zip"
set "GOT="

if not exist "%RUNTIME%" mkdir "%RUNTIME%"
del /q "!ZIP!" >nul 2>&1

where curl.exe >nul 2>&1
if errorlevel 1 goto :install_ps

for %%U in ("!URL1!" "!URL2!" "!URL3!") do (
    if not defined GOT (
        echo [下载] %%~U
        curl.exe -fL --retry 2 --connect-timeout 15 --max-time 300 -o "!ZIP!" "%%~U"
        if exist "!ZIP!" for %%S in ("!ZIP!") do if %%~zS GTR 2000000 set "GOT=1"
    )
)
goto :install_extract

:install_ps
echo [下载] !URL1!
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = 3072; Invoke-WebRequest -UseBasicParsing -Uri '!URL1!' -OutFile '!ZIP!' -TimeoutSec 300; exit 0 } catch { exit 1 }"
if exist "!ZIP!" for %%S in ("!ZIP!") do if %%~zS GTR 2000000 set "GOT=1"

:install_extract
if not defined GOT (
    echo.
    echo [错误] Node.js 下载失败，请检查网络后重试。
    echo        国内镜像地址：!URL1!
    del /q "!ZIP!" >nul 2>&1
    exit /b 1
)

echo [解压] 正在部署 Node.js 到 runtime 目录...
if exist "%RUNTIME%\node" rmdir /s /q "%RUNTIME%\node"
tar -xf "!ZIP!" -C "%RUNTIME%" >nul 2>&1
if exist "%RUNTIME%\node\node.exe" goto :install_ok
for /d %%D in ("%RUNTIME%\node-v*-win-*") do move "%%D" "%RUNTIME%\node" >nul 2>&1
if exist "%RUNTIME%\node\node.exe" goto :install_ok

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -Force -LiteralPath '!ZIP!' -DestinationPath '%RUNTIME%' ; exit 0 } catch { exit 1 }"
for /d %%D in ("%RUNTIME%\node-v*-win-*") do move "%%D" "%RUNTIME%\node" >nul 2>&1
if not exist "%RUNTIME%\node\node.exe" (
    echo [错误] Node.js 解压失败，请手动解压 !ZIP! 到 runtime 目录。
    exit /b 1
)

:install_ok
del /q "!ZIP!" >nul 2>&1
call :try_node "%RUNTIME%\node\node.exe"
if not defined NODE_EXE (
    echo [错误] 自动部署的 Node.js 无法运行，请检查安全软件是否拦截。
    exit /b 1
)
echo [OK] 依赖部署完成。
exit /b 0

:install_chart
if not exist "%~dp0public\vendor" mkdir "%~dp0public\vendor"
set "CHART=%~dp0public\vendor\chart.umd.js"
echo [依赖] 缺少图表库 Chart.js，正在从国内镜像下载...
where curl.exe >nul 2>&1
if errorlevel 1 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = 3072; Invoke-WebRequest -UseBasicParsing -Uri 'https://registry.npmmirror.com/chart.js/4.4.4/files/dist/chart.umd.js' -OutFile '!CHART!' -TimeoutSec 120; exit 0 } catch { exit 1 }"
) else (
    curl.exe -fL --retry 2 --connect-timeout 15 --max-time 120 -o "!CHART!" "https://registry.npmmirror.com/chart.js/4.4.4/files/dist/chart.umd.js"
)
if not exist "!CHART!" (
    curl.exe -fL --retry 1 --connect-timeout 15 --max-time 120 -o "!CHART!" "https://cdn.npmmirror.com/packages/chart.js/4.4.4/files/dist/chart.umd.js"
)
if exist "!CHART!" echo [OK] 图表库已就绪。
exit /b 0

:dep_failed
echo.
echo [错误] 依赖部署失败，无法启动。
echo.
echo 也可以手动安装 Node.js v18 或更高版本后重试：
echo   国内镜像: https://npmmirror.com/mirrors/node/
echo   官方网站: https://nodejs.org
echo.
pause
exit /b 1
