// Trains Sentinel's MLP on synthetic price-window patterns and writes
// model/weights.json. Run with: npm run train
//
// Synthetic regimes (8-price windows, random base level 50..5000):
//   calm      small noise, no drift                    -> HOLD
//   uptrend   steady rise                              -> HOLD
//   chop      directionless, moderate noise            -> HOLD
//   downtrend steady decline ~0.7-1.4%/step            -> HEDGE
//   panic     crash: several -3%..-9% steps, high vol  -> EXIT
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFeatures, predict, type Weights } from './model.js';

// Deterministic RNG so training is reproducible.
let seed = 1234567;
function rand(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function randn(): number {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

type Sample = { window: number[]; label: number };

function genWindow(kind: number): number[] {
  const base = 50 + rand() * 4950;
  const w = [base];
  const steps: number[] = [];
  if (kind === 0) {
    // calm
    for (let i = 0; i < 7; i++) steps.push(randn() * 0.0025);
  } else if (kind === 1) {
    // uptrend
    const drift = 0.005 + rand() * 0.008;
    for (let i = 0; i < 7; i++) steps.push(drift + randn() * 0.004);
  } else if (kind === 2) {
    // chop
    for (let i = 0; i < 7; i++) steps.push(randn() * 0.009);
  } else if (kind === 3) {
    // downtrend
    const drift = -(0.007 + rand() * 0.007);
    for (let i = 0; i < 7; i++) steps.push(drift + randn() * 0.005);
  } else {
    // panic: 2-4 large drops among noisy steps
    const drops = 2 + Math.floor(rand() * 3);
    const dropIdx = new Set<number>();
    while (dropIdx.size < drops) dropIdx.add(Math.floor(rand() * 7));
    for (let i = 0; i < 7; i++) {
      steps.push(dropIdx.has(i) ? -(0.03 + rand() * 0.06) : randn() * 0.02 - 0.004);
    }
  }
  for (const s of steps) w.push(w[w.length - 1] * (1 + s));
  return w;
}

function genDataset(n: number): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const r = rand();
    let kind: number;
    let label: number;
    if (r < 0.22) { kind = 0; label = 0; }
    else if (r < 0.42) { kind = 1; label = 0; }
    else if (r < 0.58) { kind = 2; label = 0; }
    else if (r < 0.79) { kind = 3; label = 1; }
    else { kind = 4; label = 2; }
    out.push({ window: genWindow(kind), label });
  }
  return out;
}

// --- tiny MLP with manual backprop -----------------------------------------
const IN = 12, H1 = 24, H2 = 12, OUT = 3;
function initMatrix(rows: number, cols: number, scale: number): number[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (rand() * 2 - 1) * scale)
  );
}
const W1 = initMatrix(H1, IN, Math.sqrt(2 / IN));
const b1 = new Array(H1).fill(0);
const W2 = initMatrix(H2, H1, Math.sqrt(2 / H1));
const b2 = new Array(H2).fill(0);
const W3 = initMatrix(OUT, H2, Math.sqrt(2 / H2));
const b3 = new Array(OUT).fill(0);

function forward(x: number[]) {
  const z1 = W1.map((row, i) => row.reduce((a, w, j) => a + w * x[j], 0) + b1[i]);
  const a1 = z1.map(Math.tanh);
  const z2 = W2.map((row, i) => row.reduce((a, w, j) => a + w * a1[j], 0) + b2[i]);
  const a2 = z2.map(Math.tanh);
  const z3 = W3.map((row, i) => row.reduce((a, w, j) => a + w * a2[j], 0) + b3[i]);
  const max = Math.max(...z3);
  const exps = z3.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((e) => e / sum);
  return { a1, a2, probs };
}

const trainSet = genDataset(4200);
const testSet = genDataset(900);
const trainX = trainSet.map((s) => extractFeatures(s.window));
const featureMean = new Array(IN).fill(0);
const featureStd = new Array(IN).fill(0);
for (const x of trainX) x.forEach((v, i) => (featureMean[i] += v / trainX.length));
for (const x of trainX) x.forEach((v, i) => (featureStd[i] += (v - featureMean[i]) ** 2 / trainX.length));
featureStd.forEach((v, i) => (featureStd[i] = Math.sqrt(v) || 1));
const norm = (x: number[]) => x.map((v, i) => (v - featureMean[i]) / featureStd[i]);
const trainXn = trainX.map(norm);

const LR = 0.01;
const EPOCHS = 60;
for (let epoch = 0; epoch < EPOCHS; epoch++) {
  // shuffle
  const idx = trainXn.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  let loss = 0;
  for (const i of idx) {
    const x = trainXn[i];
    const y = trainSet[i].label;
    const { a1, a2, probs } = forward(x);
    loss += -Math.log(Math.max(probs[y], 1e-12));

    const dz3 = probs.slice();
    dz3[y] -= 1;
    const dz2 = new Array(H2).fill(0);
    for (let r = 0; r < H2; r++) {
      let s = 0;
      for (let c = 0; c < OUT; c++) s += W3[c][r] * dz3[c];
      dz2[r] = s * (1 - a2[r] ** 2);
    }
    const dz1 = new Array(H1).fill(0);
    for (let r = 0; r < H1; r++) {
      let s = 0;
      for (let c = 0; c < H2; c++) s += W2[c][r] * dz2[c];
      dz1[r] = s * (1 - a1[r] ** 2);
    }
    for (let c = 0; c < OUT; c++) {
      for (let r = 0; r < H2; r++) W3[c][r] -= LR * dz3[c] * a2[r];
      b3[c] -= LR * dz3[c];
    }
    for (let c = 0; c < H2; c++) {
      for (let r = 0; r < H1; r++) W2[c][r] -= LR * dz2[c] * a1[r];
      b2[c] -= LR * dz2[c];
    }
    for (let c = 0; c < H1; c++) {
      for (let r = 0; r < IN; r++) W1[c][r] -= LR * dz1[c] * x[r];
      b1[c] -= LR * dz1[c];
    }
  }
  if (epoch % 15 === 0 || epoch === EPOCHS - 1) {
    console.log(`epoch ${epoch}: loss ${(loss / trainXn.length).toFixed(4)}`);
  }
}

const weights: Weights = {
  inputSize: IN, hidden1: H1, hidden2: H2, outputSize: OUT,
  featureMean, featureStd, W1, b1, W2, b2, W3, b3,
  trainedOn: 'synthetic regimes (calm/uptrend/chop -> HOLD, downtrend -> HEDGE, panic -> EXIT)',
  testAccuracy: 0,
};

let correct = 0;
for (const s of testSet) {
  const p = predict(weights, s.window);
  if (p.actionIndex === s.label) correct++;
}
weights.testAccuracy = correct / testSet.length;
console.log(`test accuracy: ${(weights.testAccuracy * 100).toFixed(1)}% (${correct}/${testSet.length})`);

// Sanity check on the exact shapes the demo will drive (start $2,000).
const demoCalm = [2000, 2004, 1998, 2003, 2001, 2006, 2002, 2005];
const demoTrend = [2000, 1978, 1955, 1936, 1912, 1890, 1871, 1849];
const demoPanic = [2000, 1965, 1830, 1790, 1620, 1585, 1440, 1395];
for (const [name, w] of [['calm', demoCalm], ['downtrend', demoTrend], ['panic', demoPanic]] as const) {
  const p = predict(weights, w);
  console.log(`demo ${name}: -> ${p.action} (confidence ${(p.confidence * 100).toFixed(1)}%, probs ${p.probabilities.map((v) => v.toFixed(3)).join('/')})`);
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'model', 'weights.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(weights, null, 1));
console.log('weights written to', outPath);
