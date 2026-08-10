// 認証（セッションクッキー）と Postgres 永続化を入れた時点で、この薄い Lambda
// ハンドラは使えなくなった。Express 側のミドルウェアを通らないため、そのまま公開すると
// ログインなしでクイズ生成と採点を叩けてしまう。
//
// 現在の想定構成はサーバー PC 上で `server/dist/local.js` を常駐させる形。
// Lambda に載せる場合は serverless-http などで createApp() 全体を包み、
// RDS / Aurora への接続と接続プールの扱いを設計し直すこと。

interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function handler(): Promise<HttpResult> {
  return {
    statusCode: 501,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      error:
        'この Lambda ハンドラは無効です。認証と Postgres を導入したため、createApp() を serverless-http で包む形に作り直す必要があります。',
    }),
  };
}
