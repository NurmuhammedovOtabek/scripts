/**
 * Worker thread: finds a SHA-256 nonce where hash(challenge + nonce) has
 * `difficulty` leading zero BITS.  Runs off the main event loop so the
 * service stays responsive.
 *
 * difficulty = 16  →  4 hex zeros  →  ~65 K iterations  →  ~30-80 ms
 * difficulty = 20  →  5 hex zeros  →  ~1 M iterations   →  ~500 ms
 * difficulty = 24  →  6 hex zeros  →  ~16 M iterations  →  ~8 s
 */
const { parentPort, workerData } = require('worker_threads');
const { createHash } = require('crypto');

const { challenge, difficulty } = workerData;
const start = Date.now();

const fullHexZeros = Math.floor(difficulty / 4);
const remainingBits = difficulty % 4;
const hexPrefix = '0'.repeat(fullHexZeros);
const nibbleMax = remainingBits > 0 ? 1 << (4 - remainingBits) : 0;

for (let nonce = 0; nonce < 1_000_000_000; nonce++) {
  const hash = createHash('sha256')
    .update(challenge + nonce)
    .digest('hex');

  if (!hash.startsWith(hexPrefix)) continue;

  if (remainingBits > 0) {
    const nibble = parseInt(hash[fullHexZeros], 16);
    if (nibble >= nibbleMax) continue;
  }

  parentPort.postMessage({
    challenge,
    nonce: String(nonce),
    solveTimeMs: Date.now() - start,
    solved: true,
  });
  process.exit(0);
}

parentPort.postMessage({
  challenge,
  nonce: null,
  solveTimeMs: Date.now() - start,
  solved: false,
});
process.exit(1);
