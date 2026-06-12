import { readFileSync } from 'node:fs';
import { evaluateDetections, type LabeledClip } from '../src/lib/evaluation.ts';

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    console.error(`Error reading or parsing JSON file at ${path}:`, err);
    process.exit(1);
  }
}

const [, , labelsPath, predictionsPath] = process.argv;

if (!labelsPath || !predictionsPath) {
  console.error('Usage: npm run eval -- <labels.json> <predictions.json>');
  process.exit(1);
}

console.log(`Evaluating ${predictionsPath} against ${labelsPath}...`);

const labels = readJson<LabeledClip[]>(labelsPath);
const predictions = readJson<LabeledClip[]>(predictionsPath);

const results = evaluateDetections(predictions, labels);

console.log('\n--- Evaluation Results ---');
console.log(`Precision: ${(results.precision * 100).toFixed(2)}%`);
console.log(`Recall:    ${(results.recall * 100).toFixed(2)}%`);
console.log(`F1 Score:  ${(results.f1 * 100).toFixed(2)}%`);
console.log('--------------------------');
console.log(`True Positives:  ${results.truePositives}`);
console.log(`False Positives: ${results.falsePositives}`);
console.log(`False Negatives: ${results.falseNegatives}`);
console.log('--------------------------\n');
