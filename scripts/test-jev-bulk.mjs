// Does packing several tweets into one Jev call keep the decisions? Compare batch sizes.
// Run: node --env-file=<.env with TYPESAFE_API_KEY> scripts/test-jev-bulk.mjs
import { decideTweet, decideTweets, decideTweetsHybrid } from '../lib/jev.js';
const apiKey = process.env.TYPESAFE_API_KEY;

const criteria = [
  { id: 'ai', description: 'AI', jevInstruction: 'The tweet is about artificial intelligence: AI models, labs, research, agents, or AI products and tools.' },
  { id: 'politics', description: 'US politics', jevInstruction: 'The tweet is about US politics: elections, politicians, parties, legislation, or government policy fights.' },
  { id: 'crypto', description: 'Cryptocurrency and Bitcoin news' }
];
const labelled = [
  ['ai', 'Gemini 3.8 Live just topped the Artificial Analysis speech-to-speech index. Thinks while it talks.'],
  ['ai', 'we trained a 744B MoE on GLM base and open sourced it under MIT. weights on HF now'],
  ['ai', 'the list of things Jev can instantly improve in a cloud agent platform is very very long - harness selection - repo / env selection - super fast computer use, without needing Astra'],
  ['ai', 'these are results of using jev on one of our security pipelines. we already have to use smaller (and dumber) models to make it economic and this model does it over 5x cheaper'],
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
  ['none', 'Transformers 7 is the worst movie I have seen this year'],
  ['none', 'Best tacos in Denver are on Federal, no debate'],
  ['ai', 'Introducing StepAudio 3, five audio models for real-time voice, ASR and TTS'],
  ['politics', 'Early voting starts next week in Colorado, check your registration'],
  ['none', 'Lisbon in October is perfect. 24 degrees and no crowds.'],
  ['ai', 'we just launched invite codes in Muse, 1 billion tokens each'],
  ['none', 'What a goal by Messi in the 89th minute!!'],
  ['crypto', 'Solana ETF approved, SOL up 18% in an hour'],
  ['ai', 'New stealth model on OpenRouter: Union Alpha. Multimodal, 256K context, free to use']
];
const tweets = labelled.map(([label, text], i) => ({ id: `tw${i}`, text, label }));
const want = (label, id) => label.split('+').includes(id);

function score(resultsById) {
  let correct = 0, total = 0; const misses = [];
  for (const t of tweets) for (const c of criteria) {
    total++;
    const got = resultsById[t.id].matches.includes(c.id);
    if (got === want(t.label, c.id)) correct++; else misses.push(`${c.id}=${resultsById[t.id].scores[c.id]?.toFixed(2)} "${t.text.slice(0, 40)}"`);
  }
  return { correct, total, misses };
}

// Baseline: one call per tweet, 8 in parallel
{
  const out = {}; let next = 0; let tokens = 0; const t0 = Date.now();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < tweets.length) { const t = tweets[next++]; const r = await decideTweet({ apiKey, tweetText: t.text, criteria }); out[t.id] = r; tokens += r.usage?.input_tokens || 0; }
  }));
  const s = score(out);
  console.log(`single x8 parallel : ${s.correct}/${s.total} correct  wall ${Date.now() - t0}ms  calls ${tweets.length}  input tokens ${tokens}`);
  s.misses.forEach(m => console.log('    miss', m));
}

for (const size of [4, 8, 12, 24]) {
  const batches = []; for (let i = 0; i < tweets.length; i += size) batches.push(tweets.slice(i, i + size));
  const t0 = Date.now(); let tokens = 0; const lat = [];
  const merged = {};
  const rs = await Promise.all(batches.map(b => decideTweets({ apiKey, tweets: b, criteria })));
  rs.forEach(r => { Object.assign(merged, r.results); tokens += r.usage?.input_tokens || 0; lat.push(r.latencyMs); });
  const s = score(merged);
  console.log(`bulk ${String(size).padStart(2)} per call   : ${s.correct}/${s.total} correct  wall ${Date.now() - t0}ms  calls ${batches.length}  input tokens ${tokens}  per-call ${Math.min(...lat)}-${Math.max(...lat)}ms`);
  s.misses.forEach(m => console.log('    miss', m));
}

for (const size of [6, 8, 12]) {
  const batches = []; for (let i = 0; i < tweets.length; i += size) batches.push(tweets.slice(i, i + size));
  const t0 = Date.now(); let tokens = 0; let refined = 0;
  const merged = {};
  const rs = await Promise.all(batches.map(b => decideTweetsHybrid({ apiKey, tweets: b, criteria })));
  rs.forEach(r => { Object.assign(merged, r.results); tokens += r.usage?.input_tokens || 0; refined += r.refinedCount; });
  const s = score(merged);
  console.log(`hybrid ${String(size).padStart(2)} per call : ${s.correct}/${s.total} correct  wall ${Date.now() - t0}ms  bulk calls ${batches.length} + ${refined} second opinions  input tokens ${tokens}`);
  s.misses.forEach(m => console.log('    miss', m));
}
