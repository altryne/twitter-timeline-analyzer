// Live test of lib/jev.js against the real API.
// Run: node --env-file=<path to .env with TYPESAFE_API_KEY> scripts/test-jev.mjs
import { decideTweet } from '../lib/jev.js';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) { console.error('Set TYPESAFE_API_KEY'); process.exit(1); }

const criteria = [
  { id: 'ai', description: 'AI and machine learning discussions',
    jevInstruction: 'The tweet is about artificial intelligence: AI models, labs, research, agents, or AI products and tools.' },
  { id: 'politics', description: 'US politics',
    jevInstruction: 'The tweet is about US politics: elections, politicians, parties, legislation, or government policy fights.' },
  { id: 'crypto', description: 'Cryptocurrency and Bitcoin news' } // no LLM instruction: exercises the default
];

const tweets = [
  ['ai', 'Gemini 3.8 Live just topped the Artificial Analysis speech-to-speech index. Thinks while it talks.'],
  ['ai', 'we trained a 744B MoE on GLM base and open sourced it under MIT. weights on HF now'],
  ['ai', 'My agent booked a dentist appointment by phone today. Wild times.'],
  ['ai', 'RLHF was a mistake. There, I said it.'],
  ['politics', 'The Senate votes tomorrow on the appropriations bill. Call your senator.'],
  ['politics', 'Trump called Dario a traitor on Truth Social over the pacing essay'],
  ['crypto', 'BTC just broke 150k, ETH following. Alt season incoming'],
  ['crypto', 'Free airdrop! Connect your wallet now to claim 5000 $PEPE'],
  ['none', 'Made sourdough this morning. Crumb is finally open.'],
  ['none', 'The new Dune trailer is incredible'],
  ['none', 'Traffic on the 101 is a nightmare again'],
  ['none', 'Apple is a great fruit for pie, change my mind'],
  ['ai+politics', 'Sanders introduces a bill to permanently ban superintelligence development'],
  ['none', 'Python 3.14 removed the GIL by default. My web server got 3x faster.'],
  ['ai', 'כמה זמן לוקח ל-Jev לענות? פחות מ-200 מילישניות'],
  ['none', 'Transformers 7 is the worst movie I have seen this year']
];

const expect = (label, id) => label.split('+').includes(id);

async function run(concurrency) {
  const results = new Array(tweets.length);
  let next = 0;
  const started = Date.now();
  async function worker() {
    while (next < tweets.length) {
      const i = next++;
      results[i] = await decideTweet({ apiKey, tweetText: tweets[i][1], criteria });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { results, wallMs: Date.now() - started };
}

const { results, wallMs } = await run(8);
let correct = 0, total = 0;
results.forEach((r, i) => {
  const [label, text] = tweets[i];
  const flags = criteria.map(c => {
    const ok = expect(label, c.id) === r.matches.includes(c.id);
    total++; if (ok) correct++;
    return `${c.id}=${(r.scores[c.id] ?? NaN).toFixed(2)}${ok ? '' : ' !!'}`;
  }).join('  ');
  console.log(`${String(r.latencyMs).padStart(4)}ms  [${label.padEnd(11)}] ${flags}  | ${text.slice(0, 60)}`);
});
const lat = results.map(r => r.latencyMs).sort((a, b) => a - b);
const tokens = results.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0);
console.log(`\ndecisions correct: ${correct}/${total}`);
console.log(`tweets: ${tweets.length}  concurrency 8  wall ${wallMs}ms  (${(tweets.length / (wallMs / 1000)).toFixed(1)} tweets/s)`);
console.log(`latency median ${lat[Math.floor(lat.length / 2)]}ms  p95 ${lat[Math.floor(lat.length * 0.95)]}ms  model ${results[0].model}`);
console.log(`input tokens ${tokens}  est cost $${(tokens * 0.042 / 1e6).toFixed(6)} for ${tweets.length} tweets`);
