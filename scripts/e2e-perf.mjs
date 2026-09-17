// Live performance card + engine switch, with a fake 650 ms OpenAI-compatible LLM on :8799.
// Same setup as e2e-jev.mjs (Chrome for Testing + puppeteer-core).
// End-to-end: load the unpacked extension in Chrome for Testing, serve a mock X timeline at
// https://x.com/home, let Jev decide every tweet, then read pills, stats and timing.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = process.env.OUT_DIR || '/tmp/ta-e2e';
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_BIN;
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error('TYPESAFE_API_KEY missing');

const tweets = [
  ['sama', 'big ship this week and then for devday'],
  ['GoogleAI', 'Introducing Gemini 3.8 Live: our most advanced audio model, it thinks while it talks'],
  ['baker_jane', 'Made sourdough this morning. Crumb is finally open.'],
  ['DarioAmodei', 'We Must Pace the Frontier: a new essay on why the AI industry should slow down'],
  ['SenSanders', 'The Senate votes tomorrow on the appropriations bill. Call your senator.'],
  ['piefan', 'Apple is a great fruit for pie, change my mind'],
  ['moviebuff', 'Transformers 7 is the worst movie I have seen this year'],
  ['cryptobro', 'BTC just broke 150k, ETH following. Alt season incoming'],
  ['typesafeai', 'Jev is a System One model: typed decisions with calibrated probabilities in 150ms'],
  ['commuter', 'Traffic on the 101 is a nightmare again'],
  ['noahrshinn', 'Your Instinct can now handle phone calls. Introducing Instinct Concierge'],
  ['potus_watch', 'Trump called Dario a traitor on Truth Social over the pacing essay'],
  ['hf_fan', 'we trained a 744B MoE and open sourced it under MIT. weights on HF now'],
  ['gardener', 'Tomatoes are finally ripening. September is the best month.'],
  ['airdrop4u', 'Free airdrop! Connect your wallet now to claim 5000 $PEPE'],
  ['kwindla', 'thinking fast and slow with multiple models in one voice agent loop is the architecture'],
  ['sports', 'What a goal by Messi in the 89th minute!!'],
  ['StepFun_ai', 'Introducing StepAudio 3, five audio models for real-time voice, ASR and TTS'],
  ['pydev', 'Python 3.14 removed the GIL by default. My web server got 3x faster.'],
  ['alexandr_wang', 'we just launched invite codes in Muse, 1 billion tokens each'],
  ['foodie', 'Best tacos in Denver are on Federal, no debate'],
  ['OpenRouter', 'New stealth model: Union Alpha. Multimodal, 256K context, free to use'],
  ['voter', 'Early voting starts next week in Colorado, check your registration'],
  ['traveler', 'Lisbon in October is perfect. 24 degrees and no crowds.']
];

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Home / X</title></head>
<body style="background:#000;color:#e7e9ea;font-family:sans-serif"><div aria-label="Timeline: Your Home Timeline">
${tweets.map(([u, t], i) => `<article data-testid="tweet" style="border-bottom:1px solid #2f3336;padding:12px;max-width:600px">
  <div data-testid="User-Name"><div><span>${u}</span> <span>@${u}</span> <a href="/${u}/status/${2100000000000000000n + BigInt(i)}"><time datetime="2026-09-17T08:00:00Z">2h</time></a></div></div>
  <div data-testid="tweetText">${t}</div>
  <div data-testid="caret"></div>
</article>`).join('\n')}
</div></body></html>`;

const criteria = [
  { id: 'ai1', description: 'AI and machine learning news', emoji: '🤖', color: '#1d9bf0', actions: { tag: true, highlight: true, hide: false }, regexPatterns: [],
    jevInstruction: 'The tweet is about artificial intelligence: AI models, labs, research, agents, or AI products and tools, not movies or unrelated uses of similar words.' },
  { id: 'pol1', description: 'US politics', emoji: '🏛️', color: '#f4212e', actions: { tag: true, highlight: false, hide: false }, regexPatterns: [],
    jevInstruction: 'The tweet is about US politics: elections, voting, politicians, parties, legislation, or government policy fights.' },
  { id: 'cry1', description: 'Cryptocurrency and Bitcoin', emoji: '🪙', color: '#ffd400', actions: { tag: true, highlight: false, hide: false }, regexPatterns: [] }
];


import http from 'node:http';
// Fake OpenAI-compatible LLM: ~650 ms per call, answers like a classifier would
const llm = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const text = (JSON.parse(body || '{}').messages || []).map(m => m.content).join(' ');
    const tweet = text.split('Classify this tweet:')[1] || '';
    const ids = [];
    if (/gemini|model|jev|moe|agent|stepaudio|muse|stealth|essay|devday|instinct/i.test(tweet)) ids.push('ai1');
    if (/senate|trump|voting/i.test(tweet)) ids.push('pol1');
    if (/btc|airdrop/i.test(tweet)) ids.push('cry1');
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ids) } }], usage: { prompt_tokens: 210, completion_tokens: 12 } })); }, 600 + Math.random() * 120);
  });
}).listen(8799);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: path.join(OUT, 'profile'),
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--window-size=1100,900']
});
try {
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background/background.js'), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  await sw.evaluate(async (key, criteria) => {
    await chrome.storage.local.set({ jevEnabled: true, jevApiKey: key, jevModel: 'jev-latest', jevThreshold: 0.5, jevDecideAll: true,
      apiKey: 'test', apiBaseUrl: 'http://127.0.0.1:8799/v1', model: 'llama-3.3-70b', preset: 'cerebras',
      isActive: true, criteria, stats: { analyzed: 0, tagged: 0, hidden: 0, byTopic: {} } });
  }, KEY, criteria);
  console.log('panel behavior set:', await sw.evaluate(async () => ({ popup: await chrome.action.getPopup({}), panel: chrome.sidePanel ? (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick : 'no sidePanel api', path: chrome.sidePanel ? (await chrome.sidePanel.getOptions({})).path : null })));

  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', req => { if (req.url().startsWith('https://x.com/')) req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html }); else req.continue(); });
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(n => document.querySelectorAll('[data-ta-processed="true"]').length >= n, { timeout: 30000 }, tweets.length);
  const doubles = await page.evaluate(() => [...document.querySelectorAll('article')].filter(a => a.querySelector('.ta-pill') && a.querySelector('.ta-scores')).length);
  console.log('tweets showing BOTH a tag and chips (must be 0):', doubles);
  const xTabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/*' }))[0].id);

  const popup = await browser.newPage();
  await popup.setViewport({ width: 420, height: 980 });
  await popup.evaluateOnNewDocument((id) => { const q = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = async (f) => (f && f.active ? [{ id, url: 'https://x.com/home' }] : q(f)); }, xTabId);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?panel=1`, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 900));
  const read = () => popup.evaluate(() => ({ active: document.getElementById('perfSection').dataset.active, tps: perfTps.textContent, ms: perfMs.textContent, cost: perfCost.textContent, jev: valJev.textContent, llm: valLlm.textContent, llmBtn: engineLlm.textContent, verdict: perfVerdict.textContent, bars: document.querySelectorAll('#perfSpark i:not(.perf-empty)').length }));
  console.log('JEV   ', JSON.stringify(await read()));
  await popup.screenshot({ path: path.join(OUT, 'perf-jev.png') });

  await popup.click('#engineLlm');   // the on-air move
  await page.bringToFront();
  await page.waitForFunction(n => document.querySelectorAll('[data-ta-processed="true"]').length >= n, { timeout: 60000 }, tweets.length).catch(() => console.log('LLM re-judge timed out'));
  await new Promise(r => setTimeout(r, 1200));
  await popup.bringToFront();
  await new Promise(r => setTimeout(r, 600));
  console.log('LLM   ', JSON.stringify(await read()));
  await popup.screenshot({ path: path.join(OUT, 'perf-llm.png') });
} finally {
  await browser.close(); llm.close();
  fs.rmSync(path.join(OUT, 'profile'), { recursive: true, force: true });
}
