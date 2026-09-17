// Live performance card: per-engine latency, throughput and cost, streamed from the content script.
(function () {
  const $ = (id) => document.getElementById(id);
  const isPanel = new URLSearchParams(location.search).has('panel');
  if (isPanel) document.body.classList.add('panel');

  let last = null;
  let switching = false;

  // ---- animated numbers ----
  const tweens = new Map();
  function tweenTo(el, target, format) {
    const from = tweens.get(el)?.value ?? 0;
    // Animations do not run while the panel is hidden: write the final value instead of freezing mid-way
    if (document.hidden || Math.abs(from - target) < 1e-9) { tweens.set(el, { value: target }); el.textContent = format(target); return; }
    const start = performance.now();
    const state = { value: from };
    tweens.set(el, state);
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    const step = (now) => {
      if (tweens.get(el) !== state) return; // superseded
      const t = Math.min(1, (now - start) / 320);
      const eased = 1 - Math.pow(1 - t, 3);
      state.value = from + (target - from) * eased;
      el.textContent = format(state.value);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const fmtTps = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
  const fmtMs = (v) => Math.round(v).toLocaleString();
  const fmtCost = (v) => (v === 0 ? '$0' : v < 0.01 ? '$' + v.toFixed(4) : v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2));
  const shortModel = (m) => (m || '').split('/').pop().replace(/-instruct|-versatile|-latest/gi, '');

  function render(p) {
    if (!p) return;
    last = p;
    const active = p.active;
    const a = p[active];
    const section = $('perfSection');
    section.dataset.active = active;
    section.style.setProperty('--active', active === 'jev' ? 'var(--jev)' : 'var(--llm)');

    // switch
    const sw = $('engineSwitch');
    sw.dataset.active = active;
    $('engineJev').classList.toggle('on', active === 'jev');
    $('engineLlm').classList.toggle('on', active === 'llm');
    const llmLabel = shortModel(p.info?.llmModel) || 'LLM';
    $('engineLlm').textContent = llmLabel;
    $('engineLlm').title = p.info?.llmConfigured ? `${p.info.llmModel} via ${p.info.provider || 'your provider'}` : 'Configure an LLM in settings first';
    $('engineLlm').disabled = !p.info?.llmConfigured || switching;
    $('engineJev').disabled = !p.info?.jevKeySet || switching;
    $('engineJev').title = p.info?.jevKeySet ? (p.jev.model || p.info.jevModel) : 'Add a TypeSafe API key in settings first';
    $('nameLlm').textContent = llmLabel;
    $('nameJev').textContent = shortModel(p.jev.model) || 'Jev';

    // big numbers follow the active engine
    tweenTo($('perfTps'), a.tpsNow > 0 ? a.tpsNow : 0, fmtTps);
    tweenTo($('perfMs'), a.medianMs, fmtMs);
    tweenTo($('perfCost'), a.costPer1k, fmtCost);
    $('perfTps').title = `peak ${fmtTps(a.peakTps)} tweets/s, ${a.tweets} tweets in ${a.calls} calls`;
    $('perfMs').title = `median of recent calls. Last call ${a.lastMs} ms. ${Math.round(a.msPerTweet)} ms of waiting per tweet`;
    $('perfCost').title = `${a.tokensIn.toLocaleString()} input + ${a.tokensOut.toLocaleString()} output tokens so far, ${fmtCost(a.cost)} total` + (active === 'llm' ? ' (estimated from list prices; set yours in settings)' : '');

    // sparkline: both engines on one scale so the difference is visible
    const spark = $('perfSpark');
    const lat = a.latencies;
    if (!lat.length) {
      spark.innerHTML = '<i class="perf-empty" style="background:none;flex:none;max-width:none;animation:none">Scroll the timeline to see calls land here</i>';
    } else {
      const scale = Math.max(...p.jev.latencies, ...p.llm.latencies, 1);
      const want = lat.length;
      const bars = [...spark.querySelectorAll('i:not(.perf-empty)')];
      spark.querySelector('.perf-empty')?.remove();
      while (bars.length > want) bars.shift().remove();
      while (bars.length < want) { const b = document.createElement('i'); spark.appendChild(b); bars.push(b); }
      bars.forEach((b, i) => {
        b.className = active === 'llm' ? 'llm' : '';
        b.style.height = Math.max(6, Math.round((lat[i] / scale) * 100)) + '%';
        b.title = lat[i] + ' ms';
      });
    }

    // comparison rows: bar = time per tweet, on a shared scale
    const worst = Math.max(p.jev.msPerTweet, p.llm.msPerTweet, 1);
    for (const [key, row, bar, val] of [['jev', 'rowJev', 'barJev', 'valJev'], ['llm', 'rowLlm', 'barLlm', 'valLlm']]) {
      const e = p[key];
      $(row).classList.toggle('has-data', e.tweets > 0);
      $(bar).style.width = e.tweets ? Math.max(3, (e.msPerTweet / worst) * 100) + '%' : '0';
      $(val).textContent = e.tweets
        ? `${Math.round(e.msPerTweet)} ms/tweet · ${fmtCost(e.costPer1k)}/1k · ${e.tweets}`
        : 'no data yet';
    }
    const v = $('perfVerdict');
    if (p.jev.tweets && p.llm.tweets && p.jev.msPerTweet > 0) {
      const speed = p.llm.msPerTweet / p.jev.msPerTweet;
      const cheap = p.jev.costPer1k > 0 ? p.llm.costPer1k / p.jev.costPer1k : 0;
      const s = speed >= 1 ? `Jev is ${speed >= 10 ? speed.toFixed(0) : speed.toFixed(1)}x faster per tweet` : `${llmLabel} is ${(1 / speed).toFixed(1)}x faster per tweet`;
      const c = cheap >= 1 ? ` and ${cheap >= 10 ? cheap.toFixed(0) : cheap.toFixed(1)}x cheaper` : cheap > 0 ? ` but ${(1 / cheap).toFixed(1)}x pricier` : '';
      v.textContent = s + c;
      v.style.color = speed >= 1 ? 'var(--jev)' : 'var(--llm)';
    } else {
      v.textContent = p.info?.llmConfigured && p.info?.jevKeySet ? 'Flip the switch to race the other engine on the same tweets' : '';
      v.style.color = '#8b98a5';
    }
  }

  function beat() {
    const d = $('perfDot');
    d.classList.remove('beat'); void d.offsetWidth; d.classList.add('beat');
  }

  // ---- engine switch: flips the setting; the content script re-judges what is on screen ----
  async function switchEngine(to) {
    if (switching || !last || last.active === to) return;
    switching = true;
    render({ ...last, active: to }); // move the thumb right away
    await chrome.storage.local.set({ jevEnabled: to === 'jev' });
    setTimeout(() => { switching = false; if (last) render(last); }, 500);
  }
  $('engineJev').addEventListener('click', () => switchEngine('jev'));
  $('engineLlm').addEventListener('click', () => switchEngine('llm'));

  document.addEventListener('visibilitychange', () => { if (!document.hidden && last) render(last); });

  // ---- data ----
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PERF_UPDATE' && message.perf) {
      const calls = (last?.jev.calls || 0) + (last?.llm.calls || 0);
      render(switching ? { ...message.perf, active: last.active } : message.perf);
      if (message.perf.jev.calls + message.perf.llm.calls > calls) beat();
    }
  });

  async function boot() {
    const stored = await chrome.storage.local.get(['perf']);
    if (stored.perf) render({ ...stored.perf, jev: { ...stored.perf.jev, tpsNow: 0 }, llm: { ...stored.perf.llm, tpsNow: 0 } });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const live = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PERF' });
        if (live?.perf) render(live.perf);
      }
    } catch {
      // no content script on this tab yet
    }
  }
  boot();

  // The side panel outlives tab switches, but the popup code binds to one tab when it loads.
  // Reload the panel when the active tab changes or finishes navigating, so it always follows you.
  if (isPanel && chrome.tabs?.onActivated) {
    let reloadTimer;
    const refresh = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => location.reload(), 250); };
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (tab.active && info.status === 'complete') refresh(); });
  }
})();
