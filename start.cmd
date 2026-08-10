@echo off
chcp 65001 > nul
setlocal

rem このバッチが置かれているフォルダーで動かす（ダブルクリック対応）
cd /d "%~dp0"

title QuizForge

echo ============================================
echo  QuizForge を起動します
echo ============================================
echo.

rem --- Node.js の確認 ---
where node > nul 2>&1
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。
  echo          https://nodejs.org から Node.js 20 以上を入れてください。
  goto :fail
)
for /f "delims=" %%v in ('node -v') do echo Node.js %%v

rem --- .env の確認 ---
if not exist ".env" (
  echo.
  echo [エラー] .env がありません。.env.example をコピーして作成しました。
  copy /y ".env.example" ".env" > nul
  echo          .env を開いて次の項目を埋めてから、もう一度起動してください。
  echo            AWS_BEARER_TOKEN_BEDROCK  Bedrock の API キー
  echo            DATABASE_URL              Postgres の接続先
  echo            SIGNUP_CODE               新規登録に使う招待コード
  echo            ADMIN_USERNAME            管理者アカウント名
  echo            ADMIN_PASSWORD            管理者パスワード
  goto :fail
)

rem --- 依存のインストール（初回のみ） ---
if not exist "node_modules" (
  echo.
  echo 依存パッケージを取得しています。初回は数分かかります...
  call npm ci
  if errorlevel 1 (
    echo [エラー] npm ci に失敗しました。
    goto :fail
  )
)

rem --- ビルド（成果物が無いときだけ） ---
set NEED_BUILD=0
if not exist "server\dist\local.js" set NEED_BUILD=1
if not exist "web\dist\index.html" set NEED_BUILD=1
if /i "%~1"=="rebuild" set NEED_BUILD=1

if "%NEED_BUILD%"=="1" (
  echo.
  echo ビルドしています...
  call npm run build
  if errorlevel 1 (
    echo [エラー] ビルドに失敗しました。
    goto :fail
  )
)

rem --- 起動 ---
echo.
echo --------------------------------------------
echo  http://localhost:8787 で開けます
echo  止めるときは このウィンドウで Ctrl + C
echo --------------------------------------------
echo.

node server\dist\local.js

rem サーバーが落ちた場合はここに来る
echo.
echo サーバーが停止しました。
goto :fail

:fail
echo.
pause
exit /b 1
