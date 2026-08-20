/**
 * 테스트 실행기.
 *
 * tests 폴더의 *.test.mjs 를 파일 이름 순서대로 불러온 뒤 일괄 실행한다.
 * 순서를 고정해야 결정론 테스트의 재현성이 보장된다.
 *
 * 사용법: npm test
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { runAll } from './_harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const entries = await readdir(HERE);
const testFiles = entries
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (testFiles.length === 0) {
  console.error('실행할 테스트 파일이 없습니다.');
  process.exit(1);
}

console.log(`테스트 파일 ${testFiles.length}개: ${testFiles.join(', ')}`);

for (const file of testFiles) {
  await import(pathToFileURL(join(HERE, file)).href);
}

const exitCode = await runAll();
process.exit(exitCode);
