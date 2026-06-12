export interface LabeledClip {
  start: number;
  end: number;
  label: string;
}

export interface EvaluationResults {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

/**
 * Evaluates detections against ground truth labels.
 * Uses a simplified Intersection over Union (IoU) threshold for matching.
 */
export function evaluateDetections(
  predictions: LabeledClip[],
  labels: LabeledClip[],
  iouThreshold: number = 0.3
): EvaluationResults {
  let truePositives = 0;
  const matchedLabels = new Set<number>();

  for (const pred of predictions) {
    let bestIoU = 0;
    let bestLabelIndex = -1;

    for (let i = 0; i < labels.length; i++) {
      if (matchedLabels.has(i)) continue;

      const label = labels[i];
      const intersection = Math.max(0, Math.min(pred.end, label.end) - Math.max(pred.start, label.start));
      const union = Math.max(pred.end, label.end) - Math.min(pred.start, label.start);
      const iou = intersection / union;

      if (iou > bestIoU) {
        bestIoU = iou;
        bestLabelIndex = i;
      }
    }

    if (bestIoU >= iouThreshold) {
      truePositives++;
      matchedLabels.add(bestLabelIndex);
    }
  }

  const falsePositives = Math.max(0, predictions.length - truePositives);
  const falseNegatives = Math.max(0, labels.length - truePositives);

  const precision = predictions.length > 0 ? truePositives / predictions.length : 0;
  const recall = labels.length > 0 ? truePositives / labels.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    precision,
    recall,
    f1,
    truePositives,
    falsePositives,
    falseNegatives
  };
}
