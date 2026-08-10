@echo off
rem このファイルは Shift-JIS(CP932) で保存すること。
setlocal enabledelayedexpansion

rem 8787（API）と 5173（開発サーバー）を掴んでいるプロセスだけを止める。
rem taskkill /IM node.exe だと無関係な Node まで巻き込むため使わない。

set FOUND=0

for %%P in (8787 5173) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    echo ポート %%P を使用中の PID %%I を停止します
    taskkill /f /pid %%I > nul 2>&1
    if not errorlevel 1 set FOUND=1
  )
)

if "!FOUND!"=="0" (
  echo 起動中のサーバーは見つかりませんでした。
) else (
  echo 停止しました。
)

echo.
pause
