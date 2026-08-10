// 現在のアカウント / リージョンで呼び出せる Bedrock モデル ID を一覧表示します。
// 使い方: npm run models          … 全件
//         npm run models opus     … "opus" を含むものだけ
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import dotenv from 'dotenv';

// AWS_REGION / AWS_PROFILE / アクセスキーを .env に書いた場合にも対応する。
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../.env') });

const region = process.env.AWS_REGION ?? 'us-east-1';
const filter = (process.argv[2] ?? '').toLowerCase();
const matches = (value) => !filter || value.toLowerCase().includes(filter);

const client = new BedrockClient({ region });

const { modelSummaries = [] } = await client.send(
  new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }),
);

console.log(`\n== Foundation models (${region})${filter ? ` / filter: "${filter}"` : ''} ==`);
for (const m of modelSummaries) {
  if (!m.inputModalities?.includes('TEXT')) continue;
  if (!matches(m.modelId ?? '')) continue;
  const onDemand = m.inferenceTypesSupported?.includes('ON_DEMAND') ? 'on-demand' : 'profile-only';
  // inputModalities に IMAGE があれば板書写真やスキャンPDFの読み取りが期待できる
  const modalities = (m.inputModalities ?? []).join('+');
  console.log(`${m.modelId}\t[${onDemand}]\t${modalities}\t${m.providerName ?? ''}`);
}

const { inferenceProfileSummaries = [] } = await client.send(
  new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED' }),
);

console.log(`\n== Inference profiles (BEDROCK_MODEL_ID にはこちらを使う場合が多い) ==`);
for (const p of inferenceProfileSummaries) {
  if (!matches(p.inferenceProfileId ?? '')) continue;
  console.log(`${p.inferenceProfileId}\t${p.status ?? ''}`);
}
console.log('');
