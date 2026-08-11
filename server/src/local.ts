import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const { createApp } = await import('./app.js');
const { BEARER_TOKEN_ENV, EXPLAINER_MODEL_ID, GRADER_MODEL_ID, MODEL_ID, REGION, checkCredentials } =
  await import('./bedrock.js');
const { initSchema } = await import('./db.js');
const { seedAdminUser } = await import('./auth.js');
const { pruneJobs, recoverJobs } = await import('./jobs.js');
const { loadModelConfig, modelSettings } = await import('./modelConfig.js');

const port = Number(process.env.PORT ?? 8787);

const credentials = await checkCredentials();
await initSchema();
const adminUsername = await seedAdminUser();

// 管理画面で切り替えたモデルを読み込む（無ければ環境変数のまま）。
await loadModelConfig();
const activeModels = modelSettings().current;

// 前回の停止で中断したジョブを整理し、待機中のものを拾い直す。
await pruneJobs().catch(() => undefined);
await recoverJobs().catch((error: unknown) => console.error('[jobs] 復帰に失敗', error));

createApp().listen(port, () => {
  console.log(`api  : http://localhost:${port}`);
  console.log(`model: 作問 ${activeModels.generate} (${REGION})`);
  console.log(`     : 採点 ${activeModels.grader}`);
  console.log(`     : 解説 ${activeModels.explainer}`);
  if (credentials) {
    console.log(`creds: ${credentials}`);
  } else {
    console.warn(`creds: 見つかりません。.env の ${BEARER_TOKEN_ENV} を埋めてください。`);
  }
  if (adminUsername) {
    console.log(`admin: ${adminUsername}（/admin から管理画面）`);
  } else {
    console.warn(
      'admin: 未設定。.env の ADMIN_USERNAME / ADMIN_PASSWORD を埋めると管理画面が使えます。',
    );
  }
});
