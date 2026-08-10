@echo off
chcp 65001 > nul
setlocal

cd /d "%~dp0"
title QuizForge (開発)

echo ============================================
echo  QuizForge を開発モードで起動します
echo  ソースを保存すると自動で反映されます
echo ============================================
echo.

where node > nul 2>&1
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。
  goto :fail
)

if not exist ".env" (
  copy /y ".env.example" ".env" > nul
  echo [エラー] .env を作成しました。中身を埋めてから起動してください。
  goto :fail
)

if not exist "node_modules" (
  echo 依存パッケージを取得しています...
  call npm install
  if errorlevel 1 (
    echo [エラー] npm install に失敗しました。
    goto :fail
  )
)

echo.
echo --------------------------------------------
echo  画面 http://localhost:5173
echo  API  http://localhost:8787
echo  止めるときは Ctrl + C
echo --------------------------------------------
echo.

call npm run dev

echo.
echo 停止しました。
goto :fail

:fail
echo.
pause
exit /b 1
