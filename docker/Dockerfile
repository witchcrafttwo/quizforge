# syntax=docker/dockerfile:1

# QuizForge のサーバー（API + フロントの静的配信）を 1 コンテナで動かす。
# フロントは web/dist をビルドして Express が同一オリジンで配る構成なので、
# コンテナも 1 つで済む。


# ---------- ビルド ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 依存だけ先に入れる。ソースを変えても npm ci をやり直さないようにするため。
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

# ここで --ignore-scripts を付けてはいけない。
# esbuild / rollup は postinstall でプラットフォーム用のバイナリを用意するため、
# 省略すると vite build が動かない。
RUN npm ci

COPY server ./server
COPY web ./web

# server は tsc、web は vite build。npm workspaces なのでルートから両方走る。
RUN npm run build


# ---------- 実行 ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Tokyo

# bookworm-slim には tzdata が無く、TZ を設定しても UTC のままになる。
# ログの時刻を日本時間で読みたいので入れる。
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

# 本番依存だけ入れる。typescript や vite はイメージに持ち込まない。
# 実行時に postinstall が必要なパッケージは無いので --ignore-scripts でよい。
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

# local.js は自分の位置から ../../web/dist を探すので、この配置が前提になる。
#   /app/server/dist/local.js → /app/web/dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# ファイルへの書き込みを行わない（資料は base64 でメモリに載せて Bedrock へ送るだけ）。
# root で動かす理由がないので一般ユーザーに落とす。node ユーザーは公式イメージに同梱。
USER node

EXPOSE 8787

# /api/health は認証不要で 200 を返す。curl を入れずに Node の fetch を使う。
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "const p=process.env.PORT||8787;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dotenv は /app/.env を読もうとするが、無ければ何もしない。
# 設定は compose の env_file から環境変数として渡す。
CMD ["node", "server/dist/local.js"]
