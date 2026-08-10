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

const port = Number(process.env.PORT ?? 8787);

const credentials = await checkCredentials();
await initSchema();
const adminUsername = await seedAdminUser();

createApp().listen(port, () => {
  console.log(`api  : http://localhost:${port}`);
  console.log(`model: 作問 ${MODEL_ID} (${REGION})`);
  console.log(`     : 採点 ${GRADER_MODEL_ID}`);
  console.log(`     : 解説 ${EXPLAINER_MODEL_ID}`);
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
