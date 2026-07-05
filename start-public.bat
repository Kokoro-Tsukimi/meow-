@echo off
chcp 65001 >nul
REM ^ 本文件为 UTF-8 编码,上一行切换代码页保证中文正常显示,勿删喵
setlocal enabledelayedexpansion

REM ============================================================
REM   喵咖魔法书店 · 公网一键开店脚本 (start-public.bat)
REM   ------------------------------------------------------------
REM   在本地六步基础上, 多拉一个 Cloudflare Tunnel 窗口(第⑦步),
REM   让外网(手机流量 / 朋友 / SillyTavern)也能访问喵。
REM
REM     1~4 步: 同 start.bat (容器 + gateway + worker + 双前端)
REM     5 步  : 检查 cloudflared + 拉起隧道窗口
REM
REM   零硬编码路径: 全部以 %~dp0 (项目根) 为基准。
REM   只想本地玩不开公网 → 用 start.bat 即可。
REM ============================================================

set "ROOT=%~dp0"

REM 隧道名(与 cloudflared 配置里的 tunnel 名一致, 项目内固定值)
set "TUNNEL_NAME=meow-gateway"

echo.
echo   ============================================
echo      喵咖魔法书店 · 公网开店中 ...
echo      项目根目录: %ROOT%
echo   ============================================
echo.

REM ---------- 第①步: 检查 Docker ----------
echo [1/5] 检查 Docker 是否就绪 ...
docker info >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [X] 没检测到正在运行的 Docker 喵!
    echo       请先打开 Docker Desktop, 等鲸鱼图标稳定后再运行。
    echo.
    pause
    exit /b 1
)
echo       Docker 已就绪~
echo.

REM ---------- 第②步: 拉起容器 ----------
echo [2/5] 启动数据库容器 ...
pushd "%ROOT%"
docker compose -f docker-compose.dev.yml up -d
if errorlevel 1 (
    echo   [X] 容器启动失败喵!
    popd
    pause
    exit /b 1
)
popd
echo.

REM ---------- 第③步: 等待就绪 ----------
echo [3/5] 等待容器就绪 ^(约 20 秒^) ...
timeout /t 20 /nobreak >nul
echo.

REM ---------- 第④步: 4 个 Node 服务 ----------
echo [4/5] 拉起 gateway / worker / 双前端 ...
start "喵咖-gateway 网关:3000" /d "%ROOT%gateway" cmd /k "npx ts-node src/index.ts"
start "喵咖-worker 结算" /d "%ROOT%gateway" cmd /k "npx ts-node src/worker.ts"
start "喵咖-frontend-user 客人前台:5173" /d "%ROOT%frontend-user" cmd /k "npm run dev"
start "喵咖-frontend-admin 店长后台:5174" /d "%ROOT%frontend-admin" cmd /k "npm run dev"
echo.

REM ---------- 第⑤步: Cloudflare Tunnel 公网门面 ----------
echo [5/5] 检查 cloudflared 并拉起隧道 ...
where cloudflared >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [!] 没找到 cloudflared 命令喵, 已跳过公网隧道这步。
    echo       本地 4 个服务已经起好了, 可以本地访问。
    echo       若要公网开门, 请先安装 cloudflared 并配置好隧道 "%TUNNEL_NAME%"。
    echo.
) else (
    start "喵咖-cloudflared 公网隧道" cmd /k "cloudflared tunnel run %TUNNEL_NAME%"
    echo       隧道窗口已拉起, 等看到 4 条 Registered tunnel connection 就通了~
)

echo.
echo   ============================================
echo      公网开店完成喵~ 服务清单:
echo        - 本地网关 API : http://localhost:3000
echo        - 本地客人前台 : http://localhost:5173
echo        - 本地店长后台 : http://localhost:5174
echo        - 公网客人端   : https://app.nyabookstore.com
echo        - 公网网关 API : https://api.nyabookstore.com  ^(SillyTavern 用^)
echo.
echo      ^(所有服务窗口不要关, 隧道窗口关了公网门面就塌喵^)
echo   ============================================
echo.
pause
endlocal
