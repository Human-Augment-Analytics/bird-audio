import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MODELS } from '../src/lib/modelManifest.ts';

function calculateHash(path: string): string {
  try {
    const buffer = readFileSync(path);
    return createHash('sha256').update(buffer).digest('hex');
  } catch (err) {
    console.error(`Error reading file for hashing at ${path}:`, err);
    return '';
  }
}

console.log('Verifying model hashes...\n');

let allPassed = true;

for (const [id, model] of Object.entries(MODELS)) {
  const fullPath = `./public${model.path}`;
  const actualHash = calculateHash(fullPath);

  if (actualHash === '') {
    console.log(`[MISSING] ${model.name} (${fullPath})`);
    allPassed = false;
    continue;
  }

  if (model.hash === 'TODO_HASH_HERE') {
    console.log(`[UPDATE] ${model.name}: ${actualHash} (Update manifest with this hash)`);
    allPassed = false;
    continue;
  }

  if (actualHash === model.hash) {
    console.log(`[OK]      ${model.name}`);
  } else {
    console.log(`[FAIL]    ${model.name}`);
    console.log(`          Expected: ${model.hash}`);
    console.log(`          Actual:   ${actualHash}`);
    allPassed = false;
  }
}

if (!allPassed) {
  process.exit(1);
} else {
  console.log('\nAll models verified successfully.');
}
