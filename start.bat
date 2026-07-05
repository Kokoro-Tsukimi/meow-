@echo off
chcp 65001 >nul
REM ^ 本文件为 UTF-8 编码,上一行切换代码页保证中文正常显示,勿删喵
setlocal enabledelayedexpansion

REM ============================================================
REM   喵咖魔法书店 · 本地一键开店脚本 (start.bat)
REM   ------------------------------------------------------------
REM   把手册里的"本地开店六步"自动化:
REM     1. 检查 Docker 是否就绪
REM     2. 拉起 3 个数据库容器 (mysql / redis / clickhouse)
REM     3. 等容器就绪
REM     4. 各开独立窗口跑 gateway / worker / 双前端
REM
REM   零硬编码路径: 全部以 %~dp0 (本脚本所在目录=项目根) 为基准,
REM   所以把本文件放在项目根目录即可,clone 到任何盘符都能用喵。
REM
REM   要公网开门(Cloudflare Tunnel)请改用 start-public.bat
REM ============================================================

REM %~dp0 = 本脚本所在目录(含结尾反斜杠),即项目根
set "ROOT=%~dp0"

echo.
echo   ============================================
echo      喵咖魔法书店 · 本地开店中 ...
echo      项目根目录: %ROOT%
echo   ============================================
echo.

REM ---------- 第①步: 检查 Docker 是否在运行 ----------
echo [1/4] 检查 Docker 是否就绪 ...
docker info >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [X] 没检测到正在运行的 Docker 喵!
    echo       请先打开 Docker Desktop, 等右下角鲸鱼图标稳定后再运行本脚本。
    echo       ^(若未安装 Docker, 请先安装 Docker Desktop^)
    echo.
    pause
    exit /b 1
)
echo       Docker 已就绪 ^(鲸鱼稳稳的^)~
echo.

REM ---------- 第②步: 拉起 3 个数据库容器 ----------
echo [2/4] 启动数据库容器 ^(mysql / redis / clickhouse^) ...
pushd "%ROOT%"
docker compose -f docker-compose.dev.yml up -d
if errorlevel 1 (
    echo.
    echo   [X] 容器启动失败喵! 请检查 docker-compose.dev.yml 或 Docker 状态。
    popd
    pause
    exit /b 1
)
popd
echo.

REM ---------- 第③步: 等容器就绪 ----------
echo [3/4] 等待容器就绪 ^(约 20 秒^) ...
timeout /t 20 /nobreak >nul
echo       容器应该都 Up 了, 若后续网关连不上可稍等再重试喵。
echo.

REM ---------- 第④步: 各开独立窗口跑 4 个 Node 服务 ----------
echo [4/4] 拉起 gateway / worker / 双前端 ^(各自独立窗口^) ...

REM start "窗口标题" /d "工作目录" cmd /k "命令"
REM   /d = 新窗口的启动目录(交给start处理,避免路径引号嵌套)
REM   /k = 命令跑完后窗口保留(方便看日志),这些是常驻服务不能关
start "喵咖-gateway 网关" /d "%ROOT%gateway" cmd /k "npx ts-node src/index.ts"
start "喵咖-worker 结算" /d "%ROOT%gateway" cmd /k "npx ts-node src/worker.ts"
start "喵咖-frontend-user 客人前台" /d "%ROOT%frontend-user" cmd /k "npm run dev"
start "喵咖-frontend-admin 店长后台" /d "%ROOT%frontend-admin" cmd /k "npm run dev"

echo.
echo   ============================================
echo      本地开店完成喵~ 已拉起 4 个服务窗口:
echo        - gateway   网关 API   : http://localhost:3000 ^(默认^)
echo        - worker    结算消费者
echo        - 客人前台  用户端     : http://localhost:5173 ^(默认^)
echo        - 店长后台  超管端     : http://localhost:5174 ^(默认^)
echo.
echo      端口被占用? 在项目根 .env 里改 GATEWAY_PORT / USER_PORT / ADMIN_PORT
echo      三个变量即可, 不填就用上面的默认值喵~
echo.
echo      ^(这 4 个窗口不要关, 关了对应服务就停了喵^)
echo      要公网开门请另外运行 start-public.bat
echo   ============================================
echo.
echo   本窗口可以关掉了, 不影响已启动的服务~
pause
endlocal
