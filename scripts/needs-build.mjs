// ビルドが必要かを判定する。必要なら終了コード 1、不要なら 0。
// start.cmd から呼ぶ。古い dist をコピーしてきた場合に気づかず起動するのを防ぐ。
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = [
  'server/src',
  'web/src',
  'web/index.html',
  'web/vite.config.ts',
  'server/tsconfig.json',
  'package.json',
  'server/package.json',
  'web/package.json',
];

const OUTPUTS = ['server/dist/local.js', 'server/dist/app.js', 'web/dist/index.html'];

/** 対象以下で最も新しい更新時刻。存在しなければ 0。 */
function newestMtime(target) {
  const full = path.join(root, target);
  if (!existsSync(full)) return 0;

  const stat = statSync(full);
  if (!stat.isDirectory()) return stat.mtimeMs;

  let newest = stat.mtimeMs;
  for (const entry of readdirSync(full)) {
    newest = Math.max(newest, newestMtime(path.join(target, entry)));
  }
  return newest;
}

const missing = OUTPUTS.filter((out) => !existsSync(path.join(root, out)));
if (missing.length > 0) {
  console.log(`ビルド成果物がありません: ${missing.join(', ')}`);
  process.exit(1);
}

const newestSource = Math.max(...SOURCES.map(newestMtime));
const oldestOutput = Math.min(...OUTPUTS.map(newestMtime));

if (newestSource > oldestOutput) {
  console.log('ソースがビルド成果物より新しいため、作り直します。');
  process.exit(1);
}

process.exit(0);
