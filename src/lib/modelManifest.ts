export interface ModelMetadata {
  name: string;
  path: string;
  hash: string;
  description: string;
}

export const MODELS: Record<string, ModelMetadata> = {
  localizer: {
    name: 'Buzz Localizer',
    path: '/models/buzz_localizer.onnx',
    hash: 'TODO_HASH_HERE', // Original hash lost, needs re-calculation
    description: 'CNN-based acoustic event detector optimized for Hume\'s Leaf Warbler buzz calls.'
  },
  classifier: {
    name: 'Call Classifier',
    path: '/models/classifier.onnx',
    hash: 'TODO_HASH_HERE', // Original hash lost, needs re-calculation
    description: 'Multi-class classifier for distinguishing bird species and call types.'
  }
};
