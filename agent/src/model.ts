// Sentinel's neural network: feature extraction + MLP inference.
//
// The model classifies a rolling window of 8 prices into a market regime and
// maps it to a protective action for the DecisionVault:
//   0 = HOLD  (calm / rising market: stay fully exposed)
//   1 = HEDGE (steady downtrend: hedge 50% of the position)
//   2 = EXIT  (panic / crash pattern: hedge 100%, i.e. fully protected)
//
// Architecture: 12 engineered features -> 24 tanh -> 12 tanh -> 3 softmax.
// Weights are produced by src/train.ts and stored in model/weights.json.

export const ACTIONS = ['HOLD', 'HEDGE', 'EXIT'] as const;
export type Action = (typeof ACTIONS)[number];

export interface Weights {
  inputSize: number;
  hidden1: number;
  hidden2: number;
  outputSize: number;
  featureMean: number[];
  featureStd: number[];
  W1: number[][];
  b1: number[];
  W2: number[][];
  b2: number[];
  W3: number[][];
  b3: number[];
  trainedOn: string;
  testAccuracy: number;
}

/**
 * Turn a window of 8 prices (plain numbers, any scale) into 12 scale-free
 * features based on returns, so the model works for any asset price level.
 * Leading zero entries (window still warming up) are padded with the first
 * real price.
 */
export function extractFeatures(windowRaw: number[]): number[] {
  const firstReal = windowRaw.find((p) => p > 0) ?? 0;
  const w = windowRaw.map((p) => (p > 0 ? p : firstReal));
  if (w.length !== 8 || firstReal === 0) {
    return new Array(12).fill(0);
  }
  const rets: number[] = [];
  for (let i = 0; i < 7; i++) rets.push(w[i + 1] / w[i] - 1);

  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const totalRet = w[7] / w[0] - 1;
  const meanRet = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, r) => a + (r - meanRet) ** 2, 0) / rets.length);

  let peak = w[0];
  let maxDd = 0;
  for (const p of w) {
    if (p > peak) peak = p;
    const dd = p / peak - 1;
    if (dd < maxDd) maxDd = dd;
  }

  const lastRet = rets[6];
  const last3Ret = w[7] / w[4] - 1;
  const downFrac = rets.filter((r) => r < 0).length / rets.length;
  const worstStep = Math.min(...rets);
  const momentum = w[7] / mean - 1;
  const range = (Math.max(...w) - Math.min(...w)) / mean;
  const accel = lastRet - meanRet;

  let consecDown = 0;
  for (let i = 6; i >= 0; i--) {
    if (rets[i] < 0) consecDown++;
    else break;
  }

  // Percent units for return-like features keep magnitudes model-friendly.
  return [
    totalRet * 100,
    meanRet * 100,
    vol * 100,
    maxDd * 100,
    lastRet * 100,
    last3Ret * 100,
    downFrac,
    worstStep * 100,
    momentum * 100,
    range * 100,
    accel * 100,
    consecDown / 7,
  ];
}

function matVec(m: number[][], v: number[]): number[] {
  return m.map((row) => row.reduce((a, x, i) => a + x * v[i], 0));
}
function addVec(a: number[], b: number[]): number[] {
  return a.map((x, i) => x + b[i]);
}
function tanh(v: number[]): number[] {
  return v.map((x) => Math.tanh(x));
}
function softmax(v: number[]): number[] {
  const max = Math.max(...v);
  const exps = v.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}

export interface Prediction {
  action: Action;
  actionIndex: number;
  confidence: number; // 0..1, softmax probability of the chosen action
  probabilities: number[];
  features: number[];
}

/** Run the MLP on a window of 8 prices (numbers; 1e8-scaled ints are fine). */
export function predict(weights: Weights, windowRaw: number[]): Prediction {
  const rawFeatures = extractFeatures(windowRaw);
  const x = rawFeatures.map(
    (f, i) => (f - weights.featureMean[i]) / (weights.featureStd[i] || 1)
  );
  const h1 = tanh(addVec(matVec(weights.W1, x), weights.b1));
  const h2 = tanh(addVec(matVec(weights.W2, h1), weights.b2));
  const logits = addVec(matVec(weights.W3, h2), weights.b3);
  const probabilities = softmax(logits);
  const actionIndex = probabilities.indexOf(Math.max(...probabilities));
  return {
    action: ACTIONS[actionIndex],
    actionIndex,
    confidence: probabilities[actionIndex],
    probabilities,
    features: rawFeatures,
  };
}
