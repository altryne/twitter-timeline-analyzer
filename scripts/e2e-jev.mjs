// End-to-end: load the unpacked extension in Chrome for Testing, serve a mock X timeline at
// https://x.com/home, let Jev decide every tweet, then stream 120 more tweets through a fast
// virtualized scroll and check every one of them gets decided. Reads pills, scores, stats, timing.
//
// Branded Chrome no longer accepts --load-extension, so this needs Chrome for Testing:
//   npm install --no-save puppeteer-core
//   npx @puppeteer/browsers install chrome@stable --path ./.browsers
//   CHROME_BIN="<path printed above>" OUT_DIR=/tmp/ta-e2e \
//     node --env-file=path/to/.env scripts/e2e-jev.mjs      # .env holds TYPESAFE_API_KEY
// The temporary Chrome profile (which holds the key) is deleted when the run ends.
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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: path.join(OUT, 'profile'),
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--window-size=1100,900']
});

try {
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background/background.js'), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  console.log('extension loaded, id', extId);

  await sw.evaluate(async (key, criteria) => {
    await chrome.storage.local.set({
      jevEnabled: true, jevApiKey: key, jevModel: 'jev-latest', jevThreshold: 0.5, jevDecideAll: true,
      isActive: true, criteria, stats: { analyzed: 0, tagged: 0, hidden: 0, byTopic: {} }
    });
  }, KEY, criteria);

  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().startsWith('https://x.com/')) req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    else req.continue();
  });
  page.on('console', m => { const t = m.text(); if (t.includes('Twitter Analyzer') || m.type() === 'error') console.log('  [page]', t.slice(0, 160)); });

  const t0 = Date.now();
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(n => document.querySelectorAll('[data-ta-processed="true"]').length >= n, { timeout: 30000 }, tweets.length);
  const wallMs = Date.now() - t0;

  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map(a => ({
    text: a.querySelector('[data-testid="tweetText"]').textContent.slice(0, 62),
    pills: Array.from(a.querySelectorAll('.ta-pill')).map(p => p.title.replace(/^.*·\s*/, '') + ' ' + p.textContent.trim().slice(0, 2)),
    highlighted: a.classList.contains('ta-highlighted')
  })));
  rows.forEach(r => console.log(`  ${r.pills.length ? r.pills.join(' | ').padEnd(34) : '-'.padEnd(34)} ${r.highlighted ? 'HL' : '  '} ${r.text}`));
  console.log(`\n${tweets.length} tweets decided and rendered in ${wallMs} ms from navigation (${(tweets.length / (wallMs / 1000)).toFixed(1)} tweets/s, includes page load)`);

  const scrollStart = Date.now();
  const total = await page.evaluate(async (seed) => {
    const timeline = document.querySelector('[aria-label^="Timeline"]');
    let n = 0;
    for (let step = 0; step < 20; step++) {
      for (let k = 0; k < 6; k++) {
        const [u, t] = seed[(n + 3) % seed.length];
        const id = 2100000000000001000n + BigInt(n);
        const a = document.createElement('article');
        a.setAttribute('data-testid', 'tweet');
        a.style.cssText = 'border-bottom:1px solid #2f3336;padding:12px;max-width:600px';
        a.innerHTML = `<div data-testid="User-Name"><div><span>${u}</span> <span>@${u}</span> <a href="/${u}/status/${id}"><time>1m</time></a></div></div><div data-testid="tweetText">${t} (#${n})</div>`;
        timeline.appendChild(a);
        n++;
      }
      const all = timeline.querySelectorAll('article');
      for (let k = 0; k < 6 && all.length - k > 30; k++) all[k].remove();   // virtualization
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 90));
    }
    return n;
  }, tweets);
  await new Promise(r => setTimeout(r, 1500));
  const decided = await sw.evaluate(async () => { const c = (await chrome.storage.local.get(['tweetCache'])).tweetCache; return c ? Object.keys(JSON.parse(c)).filter(k => k !== '__sig').length : 0; });
  console.log(`FAST SCROLL: ${total} more tweets streamed through a 30-tweet window in ${Date.now() - scrollStart - 1500} ms; decisions cached in total: ${decided} of ${tweets.length + total}`);
  const chips = await page.evaluate(() => Array.from(document.querySelectorAll('article')).slice(-3).map(a => (a.querySelector('.ta-scores')?.textContent || 'NO SCORES') + ' | ' + a.querySelector('[data-testid="tweetText"]').textContent.slice(0, 40)));
  chips.forEach(c => console.log('   ', c));

  const before = await sw.evaluate(async () => (await chrome.storage.local.get(['stats'])).stats);
  await sw.evaluate(async () => {
    const { criteria } = await chrome.storage.local.get(['criteria']);
    criteria[2].jevInstruction = 'The tweet is about cryptocurrency: Bitcoin, Ethereum, tokens, airdrops, wallets, or crypto markets.';
    await chrome.storage.local.set({ criteria });
  });
  await new Promise(r => setTimeout(r, 2500));
  const after = await sw.evaluate(async () => (await chrome.storage.local.get(['stats'])).stats);
  console.log('RULE EDIT re-judge: analyzed', before.analyzed, '->', after.analyzed, '| crypto', before.byTopic.cry1, '->', after.byTopic.cry1, '(analyzed must not grow)');

  await new Promise(r => setTimeout(r, 600));
  const stats = await sw.evaluate(async () => (await chrome.storage.local.get(['stats'])).stats);
  console.log('stats in storage:', JSON.stringify(stats));
  await page.screenshot({ path: path.join(OUT, 'timeline.png'), fullPage: true });

  // Popup: share bars and takeover line
  const popup = await browser.newPage();
  await popup.setViewport({ width: 400, height: 900 });
  // The popup only renders when the active tab is X; in this harness it is its own tab
  await popup.evaluateOnNewDocument(() => {
    chrome.tabs.query = async () => [{ id: 999999, url: 'https://x.com/home' }];
    chrome.tabs.sendMessage = async () => ({});
  });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 800));
  await popup.evaluate(() => document.querySelector('.criteria-header')?.click());
  await new Promise(r => setTimeout(r, 300));
  const popupInfo = await popup.evaluate(() => ({
    jevRule: document.querySelector('.criteria-jev-input')?.value?.slice(0, 60),
    takeover: document.getElementById('takeover')?.textContent,
    shares: Array.from(document.querySelectorAll('.criteria-share .share-text')).map(e => e.textContent)
  }));
  console.log('popup:', JSON.stringify(popupInfo));
  await popup.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });

  // Options: Jev section + Test button (real call through the host permission)
  const opts = await browser.newPage();
  await opts.setViewport({ width: 900, height: 1200 });
  await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
  await opts.click('#testLlmBtn');
  await new Promise(r => setTimeout(r, 300));
  console.log('llm test (no key in this harness):', await opts.$eval('#llmTestResult', e => e.textContent));
  await opts.click('#testJevBtn');
  await opts.waitForFunction(() => /Connected|failed/.test(document.getElementById('jevTestResult').textContent), { timeout: 15000 });
  console.log('options test:', await opts.$eval('#jevTestResult', e => e.textContent));
  await opts.$eval('#jevApiKey', e => { e.value = 'hidden-for-screenshot'; });
  const section = await opts.$('#jevFields');
  await section.evaluate(e => e.closest('.section').scrollIntoView());
  await (await opts.$('#jevFields')).evaluateHandle(e => e.closest('.section')).then(h => h.asElement().screenshot({ path: path.join(OUT, 'options-jev.png') }));
} finally {
  await browser.close();
  fs.rmSync(path.join(OUT, 'profile'), { recursive: true, force: true }); // the profile held the API key
}
