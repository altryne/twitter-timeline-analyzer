// Twitter Timeline Analyzer - Content Script

(function() {
  // Prevent multiple injections
  if (window.__twitterAnalyzerInjected) return;
  window.__twitterAnalyzerInjected = true;

  // State
  let isActive = false;
  let criteria = [];
  let tweetCache = new Map(); // tweetId -> { result, timestamp }
  let pendingTweets = new Set(); // tweet IDs currently being processed
  let tweetQueue = [];
  let isProcessing = false;
  let stats = { analyzed: 0, tagged: 0, hidden: 0, byTopic: {} };

  // Decision engine. With Jev on, the LLM only writes criteria; Jev decides every tweet.
  let engine = { jev: false, decideAll: true, showScores: true, signature: '' };

  // Bulk pump (Jev mode): a sweeper keeps finding undecided tweets, batches go out continuously
  const BULK_SIZE = 8;          // tweets per Jev call (bulk accuracy holds up to here, see scripts/test-jev-bulk.mjs)
  const BULK_MAX_INFLIGHT = 3;  // batches in flight at once
  const SWEEP_INTERVAL_MS = 400;
  let inflightBatches = 0;
  let lastSweepAt = 0;

  // Failed decisions are never cached (a dead API key must not turn into "matches nothing").
  // They are retried after a pause, and the error is shown once instead of failing silently.
  const failedAt = new Map(); // tweetId -> timestamp of last failed decision
  const RETRY_AFTER_MS = 30000;
  let consecutiveFailures = 0;
  let pausedUntil = 0;
  let lastErrorShownAt = 0;
  const JEV_CONCURRENCY = 8;  // Jev answers in ~150-300ms, so run tweets in parallel
  const LLM_CONCURRENCY = 3;  // a fair fight for the live comparison, still gentle on rate limits

  // ---- Live performance, per engine, streamed to the popup / side panel ----
  // Rough list prices in $ per million tokens [input, output]; override in settings.
  const LLM_PRICES = [
    [/llama-?3\.3-?70b/i, 0.85, 1.20], [/llama-?3\.1-?8b/i, 0.10, 0.10], [/gpt-oss-120b/i, 0.35, 0.75],
    [/qwen-?3-?235b/i, 0.60, 1.20], [/qwen-?3-?32b/i, 0.40, 0.80], [/gpt-4o-mini/i, 0.15, 0.60],
    [/gpt-4o/i, 2.50, 10.0], [/haiku/i, 0.80, 4.0]
  ];
  const JEV_PRICE_IN = 0.042; // $ per million input tokens, output free
  const newPerf = () => ({ tweets: 0, calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, busyMs: 0, latencies: [], stamps: [], model: '', peakTps: 0 });
  let perf = { jev: newPerf(), llm: newPerf() };
  let engineInfo = { llmModel: '', jevModel: '', llmConfigured: false, jevKeySet: false, priceIn: null, priceOut: null };
  let perfTimer = null;

  function llmPrice(model) {
    if (Number.isFinite(engineInfo.priceIn) && Number.isFinite(engineInfo.priceOut)) return [engineInfo.priceIn, engineInfo.priceOut];
    const hit = LLM_PRICES.find(([re]) => re.test(model || ''));
    return hit ? [hit[1], hit[2]] : [0.60, 0.60];
  }

  // One finished request: how many tweets it settled, how many API calls it took, how long we waited
  function recordPerf(which, { tweets, calls = 1, wallMs, usage, model }) {
    const e = perf[which];
    const now = Date.now();
    e.tweets += tweets;
    e.calls += calls;
    e.busyMs += wallMs || 0;
    if (model) e.model = model;
    const tin = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const tout = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
    e.tokensIn += tin;
    e.tokensOut += tout;
    if (which === 'jev') e.cost += tin * JEV_PRICE_IN / 1e6;
    else { const [pi, po] = llmPrice(e.model); e.cost += (tin * pi + tout * po) / 1e6; }
    if (wallMs) { e.latencies.push(Math.round(wallMs)); if (e.latencies.length > 60) e.latencies.shift(); }
    for (let i = 0; i < tweets; i++) e.stamps.push(now);
    while (e.stamps.length && now - e.stamps[0] > 3000) e.stamps.shift();
    e.peakTps = Math.max(e.peakTps, e.stamps.length / 3);
    schedulePerfBroadcast();
  }

  function perfSnapshot() {
    const now = Date.now();
    const view = (e) => {
      const stamps = e.stamps.filter(t => now - t <= 3000);
      const sorted = [...e.latencies].sort((a, b) => a - b);
      return {
        tweets: e.tweets, calls: e.calls, tokensIn: e.tokensIn, tokensOut: e.tokensOut, cost: e.cost, model: e.model,
        tpsNow: stamps.length / 3, peakTps: e.peakTps,
        medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
        lastMs: e.latencies[e.latencies.length - 1] || 0,
        msPerTweet: e.tweets ? e.busyMs / e.tweets : 0,
        costPer1k: e.tweets ? (e.cost / e.tweets) * 1000 : 0,
        latencies: e.latencies.slice(-40)
      };
    };
    return { active: engine.jev ? 'jev' : 'llm', jev: view(perf.jev), llm: view(perf.llm), info: engineInfo, queued: tweetQueue.length, at: now };
  }

  function schedulePerfBroadcast() {
    if (perfTimer) return;
    perfTimer = setTimeout(() => {
      perfTimer = null;
      const snap = perfSnapshot();
      chrome.runtime.sendMessage({ type: 'PERF_UPDATE', perf: snap }).catch(() => {});
      chrome.storage.local.set({ perf: snap }).catch(() => {});
      // keep the "tweets/s right now" number decaying to zero after a burst
      if (snap.jev.tpsNow > 0 || snap.llm.tpsNow > 0) schedulePerfBroadcast();
    }, 120);
  }

  // Cache settings
  const CACHE_MAX_SIZE = 500;
  const CACHE_STORAGE_KEY = 'tweetCache';

  // Selectors for Twitter DOM
  const SELECTORS = {
    tweet: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    userName: '[data-testid="User-Name"]',
    timeline: 'div[aria-label*="Timeline"]',
    tweetLink: 'a[href*="/status/"] time',
    moreButton: '[data-testid="caret"]',
    dropdownMenu: '[role="menu"][data-testid="Dropdown"]'
  };

  // Track which tweet's menu was opened
  let lastMenuTweet = null;

  // Initialize
  async function init() {
    // Load saved state
    const data = await chrome.storage.local.get(['criteria', 'isActive', 'stats', CACHE_STORAGE_KEY]);
    criteria = data.criteria || [];
    isActive = data.isActive || false;
    stats = data.stats || { analyzed: 0, tagged: 0, hidden: 0 };
    if (!stats.byTopic) stats.byTopic = {};

    await loadEngineSettings();
    chrome.storage.onChanged.addListener(handleStorageChange);

    // Restore cache from storage
    if (data[CACHE_STORAGE_KEY]) {
      try {
        const cached = JSON.parse(data[CACHE_STORAGE_KEY]);
        if (cached.__sig === engine.signature) {
          Object.entries(cached).forEach(([id, value]) => {
            if (id !== '__sig') tweetCache.set(id, value);
          });
          console.log(`[Twitter Analyzer] Restored ${tweetCache.size} cached tweets`);
        } else {
          console.log('[Twitter Analyzer] Decision engine changed since the cache was written: starting fresh');
        }
      } catch (e) {
        console.error('[Twitter Analyzer] Failed to restore cache:', e);
      }
    }

    // Set up mutation observer
    setupObserver();

    // Set up menu injection observer
    setupMenuObserver();

    // Create the categorize modal
    createCategorizeModal();

    // Process existing tweets
    if (isActive) {
      requestAnimationFrame(() => processVisibleTweets());
    }

    // Arc cannot show side panels: let the background keep the classic popup there
    try {
      if (getComputedStyle(document.documentElement).getPropertyValue('--arc-palette-title')) {
        chrome.runtime.sendMessage({ type: 'ARC_DETECTED' }).catch(() => {});
      }
    } catch { /* not fatal */ }

    console.log('[Twitter Analyzer] Content script initialized');
  }

  // Which engine decides? The background worker owns the keys; we only learn what is on.
  async function loadEngineSettings() {
    try {
      const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      engine = {
        jev: Boolean(settings?.jevConfigured),
        decideAll: settings?.jevDecideAll !== false,
        showScores: settings?.jevShowScores !== false
      };
      // Anything that changes what a decision would be. Cached results from another setup are stale.
      engineInfo = {
        llmModel: settings?.model || '',
        jevModel: settings?.jevModel || 'jev-latest',
        llmConfigured: Boolean(settings?.llmConfigured),
        jevKeySet: Boolean(settings?.jevKeySet),
        provider: settings?.preset || '',
        priceIn: settings?.llmPriceIn === '' || settings?.llmPriceIn == null ? null : Number(settings.llmPriceIn),
        priceOut: settings?.llmPriceOut === '' || settings?.llmPriceOut == null ? null : Number(settings.llmPriceOut)
      };
      engine.signature = [
        'rules-v2', // bump when the way rules are phrased changes, so old scores are not reused
        engine.jev ? 'jev' : 'llm',
        engine.decideAll,
        settings?.jevModel || '',
        settings?.jevThreshold ?? '',
        settings?.model || ''
      ].join('|');
    } catch {
      engine = { jev: false, decideAll: true, showScores: true, signature: 'unknown' };
    }
  }

  // Forget every decision and re-judge what is on screen (engine or threshold changed)
  function resetDecisions() {
    failedAt.clear();
    consecutiveFailures = 0;
    pausedUntil = 0;
    tweetCache.clear();
    pendingTweets.clear();
    tweetQueue = [];
    document.querySelectorAll('[data-ta-processed]').forEach(el => {
      cleanVisuals(el);
      delete el.dataset.taProcessed;
      delete el.dataset.taTweetId;
    });
    if (isActive) processVisibleTweets();
  }

  async function handleStorageChange(changes, area) {
    if (area !== 'local') return;

    if (changes.llmPriceIn || changes.llmPriceOut || changes.model || changes.apiKey || changes.apiBaseUrl) {
      await loadEngineSettings();
      schedulePerfBroadcast();
      if (!changes.jevEnabled && !changes.jevApiKey && !changes.jevThreshold && !changes.jevModel && !changes.jevDecideAll && !changes.criteria && !changes.jevShowScores) {
        // a different LLM only matters for decisions when the LLM is the engine
        if (!engine.jev && (changes.model || changes.apiKey || changes.apiBaseUrl)) resetDecisions();
        return;
      }
    }

    // Display-only setting: redraw what we already know
    if (changes.jevShowScores && !changes.jevEnabled && !changes.jevApiKey && !changes.jevThreshold && !changes.jevModel && !changes.jevDecideAll) {
      engine.showScores = changes.jevShowScores.newValue !== false;
      document.querySelectorAll('[data-ta-tweet-id]').forEach(el => {
        const cached = tweetCache.get(el.dataset.taTweetId);
        if (cached) { cleanVisuals(el); applyVisualChanges(el, cached.result, el.dataset.taTweetId); }
      });
      return;
    }

    // Jev switched on/off, re-keyed, or threshold moved: old decisions no longer apply
    if (changes.jevEnabled || changes.jevApiKey || changes.jevThreshold || changes.jevModel || changes.jevDecideAll) {
      await loadEngineSettings();
      resetDecisions();
      return;
    }

    // A Jev decision rule was written or edited (by the LLM in the background, from feedback, or
    // by hand in the popup). Every score on screen was judged against the old wording, and Jev is
    // cheap, so throw those decisions away and re-judge with the new rule.
    if (changes.criteria?.newValue) {
      const byId = new Map(changes.criteria.newValue.map(c => [c.id, c]));
      let ruleChanged = false;
      criteria = criteria.map(c => {
        const fresh = byId.get(c.id);
        if (fresh && fresh.jevInstruction !== c.jevInstruction) {
          ruleChanged = true;
          return { ...c, jevInstruction: fresh.jevInstruction };
        }
        return c;
      });
      if (ruleChanged && engine.jev) resetDecisions();
    }
  }

  // Set up MutationObserver for dynamic content
  function setupObserver() {
    let mutationTimeout;
    let reapplyTimeout;

    const observer = new MutationObserver((mutations) => {
      if (!isActive) return;

      // Check if any mutations are relevant (new tweets added)
      const hasRelevantMutation = mutations.some(m =>
        m.addedNodes.length > 0 &&
        Array.from(m.addedNodes).some(n =>
          n.nodeType === 1 && (n.matches?.(SELECTORS.tweet) || n.querySelector?.(SELECTORS.tweet))
        )
      );

      // Check if mutations affect our processed tweets (Twitter re-rendering)
      const affectsProcessedTweets = mutations.some(m => {
        const target = m.target;
        return target?.closest?.('[data-ta-tweet-id]') ||
               target?.dataset?.taTweetId ||
               (m.removedNodes.length > 0 && Array.from(m.removedNodes).some(n =>
                 n.classList?.contains('ta-highlight-overlay') || n.classList?.contains('ta-pill')
               ));
      });

      if (affectsProcessedTweets) {
        // Debounce reapply to avoid excessive calls
        clearTimeout(reapplyTimeout);
        reapplyTimeout = setTimeout(() => reapplyVisuals(), 10);
      }

      if (!hasRelevantMutation) {
        return;
      }

      // Throttle, do not debounce: during a long continuous scroll a debounce never fires and
      // tweets scroll past undecided. Run now if we have not swept recently, else very soon.
      if (Date.now() - lastSweepAt > 120) {
        processVisibleTweets();
      } else if (!mutationTimeout) {
        mutationTimeout = setTimeout(() => {
          mutationTimeout = null;
          processVisibleTweets();
        }, 120);
      }
    });

    // Safety net: keep sweeping for undecided tweets no matter which DOM events we missed
    setInterval(() => {
      if (isActive && criteria.length > 0 && Date.now() - lastSweepAt >= SWEEP_INTERVAL_MS) {
        processVisibleTweets();
      }
    }, SWEEP_INTERVAL_MS);

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });

    // Scroll handler - just re-apply visuals, don't reprocess
    let scrollTimeout;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        if (isActive) {
          reapplyVisuals();
          processVisibleTweets();
        }
      }, 50);
    }, { passive: true });

    // Mouse event handlers to catch Twitter's hover re-renders
    document.addEventListener('mouseenter', (e) => {
      if (!isActive) return;
      const tweet = e.target.closest?.(SELECTORS.tweet);
      if (tweet && tweet.dataset.taTweetId) {
        // Schedule a quick reapply after Twitter's hover effects
        setTimeout(() => reapplyVisualsForTweet(tweet), 50);
      }
    }, true);

    document.addEventListener('mouseleave', (e) => {
      if (!isActive) return;
      const tweet = e.target.closest?.(SELECTORS.tweet);
      if (tweet && tweet.dataset.taTweetId) {
        // Schedule reapply after Twitter's hover-out effects
        setTimeout(() => reapplyVisualsForTweet(tweet), 50);
      }
    }, true);
  }

  // Re-apply visuals for a single tweet
  function reapplyVisualsForTweet(tweet) {
    if (!tweet || !tweet.dataset.taTweetId) return;

    const tweetId = tweet.dataset.taTweetId;
    const cached = tweetCache.get(tweetId);

    if (cached && !hasIntactVisuals(tweet)) {
      applyVisualChanges(tweet, cached.result, tweetId);
    }
  }

  // Re-apply visual changes to tweets that have cached results
  function reapplyVisuals() {
    const tweets = document.querySelectorAll(SELECTORS.tweet);

    tweets.forEach(tweet => {
      // Skip if already has our marker and visuals are intact
      if (tweet.dataset.taProcessed && hasIntactVisuals(tweet)) {
        return;
      }

      const tweetId = getTweetId(tweet);
      if (!tweetId) return;

      const cached = tweetCache.get(tweetId);
      if (cached) {
        applyVisualChanges(tweet, cached.result, tweetId);
      }
    });
  }

  // Check if tweet still has its visual modifications intact
  function hasIntactVisuals(element) {
    const tweetId = element.dataset.taTweetId;
    if (!tweetId) return false;

    const cached = tweetCache.get(tweetId);
    if (!cached) return true;

    // The element may have been recycled for another tweet
    if (getTweetId(element) !== tweetId) return false;

    // The per-topic probability row should be there whenever we have scores to show
    const showsTag = cached.result.matchedCriteria.some(c => c.actions?.tag && !c.actions?.hide);
    const hasChips = !showsTag && cached.result.scores && Object.keys(cached.result.scores).length > 0;
    if (engine.showScores && hasChips && !element.querySelector('.ta-scores')) return false;

    if (!cached.result.matchedCriteria.length) return true;

    // Check if expected visuals exist and have correct styles
    for (const c of cached.result.matchedCriteria) {
      if (c.actions.hide) {
        if (element.style.display !== 'none') return false;
      }
      if (c.actions.tag) {
        if (!element.querySelector(`.ta-pill[data-criteria="${c.id}"]`)) return false;
      }
      if (c.actions.highlight) {
        const overlay = element.querySelector('.ta-highlight-overlay');
        if (!overlay) return false;
        // Also check if overlay styles are intact (Twitter may have reset them)
        const overlayStyle = overlay.style;
        if (!overlayStyle.backgroundColor || overlayStyle.position !== 'absolute') {
          return false;
        }
        // Check if element has highlight background
        if (!element.classList.contains('ta-highlighted')) return false;
      }
    }

    return true;
  }

  // Process all visible tweets
  function processVisibleTweets() {
    lastSweepAt = Date.now();
    const tweets = document.querySelectorAll(SELECTORS.tweet);

    tweets.forEach(tweet => {
      const tweetId = getTweetId(tweet);
      if (!tweetId) return;

      // X recycles timeline cells: an element that now holds a different tweet must not keep
      // the previous tweet's tags, scores or "already processed" marker
      if (tweet.dataset.taTweetId && tweet.dataset.taTweetId !== tweetId) {
        cleanVisuals(tweet);
        delete tweet.dataset.taProcessed;
        delete tweet.dataset.taTweetId;
      }

      // Check if already cached
      if (tweetCache.has(tweetId)) {
        applyVisualChanges(tweet, tweetCache.get(tweetId).result, tweetId);
        return;
      }

      // Check if already pending
      if (pendingTweets.has(tweetId)) return;

      // Decision failed recently: wait before trying again
      const failed = failedAt.get(tweetId);
      if (failed && Date.now() - failed < RETRY_AFTER_MS) return;

      // Check if already in queue
      if (tweetQueue.some(t => t.id === tweetId)) return;

      const tweetText = getTweetText(tweet);
      if (tweetText) {
        tweetQueue.push({
          id: tweetId,
          element: tweet,
          text: tweetText,
          author: getTweetAuthor(tweet)
        });
      }
    });

    // Process queue
    processQueue();
  }

  // Prioritize tweets currently in viewport
  function prioritizeVisibleTweets() {
    if (tweetQueue.length === 0) return;

    tweetQueue.sort((a, b) => {
      const rectA = a.element.getBoundingClientRect();
      const rectB = b.element.getBoundingClientRect();

      const aInView = rectA.top >= 0 && rectA.bottom <= window.innerHeight;
      const bInView = rectB.top >= 0 && rectB.bottom <= window.innerHeight;

      if (aInView && !bInView) return -1;
      if (!aInView && bInView) return 1;
      return rectA.top - rectB.top;
    });
  }

  // Process tweet queue with a small worker pool.
  // Jev: 8 tweets in flight, visible ones first. LLM: one at a time with a pause.
  async function processQueue() {
    if (engine.jev) {
      pumpBulk();
      return;
    }

    if (isProcessing || tweetQueue.length === 0 || criteria.length === 0) return;
    if (Date.now() < pausedUntil) return;

    isProcessing = true;
    prioritizeVisibleTweets();

    const concurrency = engine.jev ? JEV_CONCURRENCY : LLM_CONCURRENCY;
    const workers = Array.from({ length: concurrency }, () => queueWorker());
    await Promise.all(workers);

    isProcessing = false;

    // Tweets that arrived while the last workers were finishing
    if (tweetQueue.length > 0 && isActive) {
      processQueue();
      return;
    }

    // Save cache periodically
    saveCacheToStorage();
    chrome.storage.local.set({ stats }).catch(() => {});
  }

  // Jev mode: ship undecided tweets in batches, several batches in flight, visible tweets first.
  // Never waits for a previous batch to finish before sending the next one.
  function pumpBulk() {
    if (criteria.length === 0 || Date.now() < pausedUntil) return;

    while (tweetQueue.length > 0 && inflightBatches < BULK_MAX_INFLIGHT && isActive) {
      prioritizeVisibleTweets();
      const batch = [];
      while (tweetQueue.length > 0 && batch.length < BULK_SIZE) {
        const t = tweetQueue.shift();
        if (tweetCache.has(t.id) || pendingTweets.has(t.id)) continue;
        if (!t.text || t.text.length <= 10) {
          // Nothing to judge (image-only tweet): settle it locally, no call needed
          settleTweet(t, { matchedCriteria: [], scores: {}, engine: 'skipped' });
          continue;
        }
        pendingTweets.add(t.id);
        batch.push(t);
      }
      if (batch.length > 0) sendBatch(batch);
    }
  }

  async function sendBatch(batch) {
    inflightBatches++;
    const sentAt = Date.now();
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ANALYZE_TWEETS_BULK',
        tweets: batch.map(t => ({ id: t.id, text: t.text, author: t.author || '' })),
        criteria: criteria.map(c => ({ id: c.id, description: c.description, jevInstruction: c.jevInstruction }))
      });

      if (response?.error || !response?.results) {
        batch.forEach(t => handleDecisionFailure(t.id, response?.error || 'no response'));
        return;
      }

      recordPerf('jev', { tweets: batch.length, calls: response.calls || 1, wallMs: Date.now() - sentAt, usage: response.usage, model: response.model });

      for (const t of batch) {
        const r = response.results[t.id];
        if (!r || !r.scores || Object.keys(r.scores).length === 0) {
          handleDecisionFailure(t.id, 'no answer for this tweet');
          continue;
        }
        consecutiveFailures = 0;
        failedAt.delete(t.id);
        settleTweet(t, {
          matchedCriteria: criteria.filter(c => r.matches.includes(c.id)),
          scores: r.scores,
          engine: 'jev',
          refined: Boolean(r.refined)
        });
      }
      chrome.runtime.sendMessage({ type: 'STATS_UPDATE', stats }).catch(() => {});
    } catch (err) {
      console.error('[Twitter Analyzer] Bulk decision failed:', err);
      batch.forEach(t => handleDecisionFailure(t.id, err.message));
    } finally {
      batch.forEach(t => pendingTweets.delete(t.id));
      inflightBatches--;
      if (inflightBatches === 0 && tweetQueue.length === 0) {
        saveCacheToStorage();
        chrome.storage.local.set({ stats }).catch(() => {});
      }
      // Whatever arrived meanwhile goes out now
      if (tweetQueue.length > 0) pumpBulk();
    }
  }

  // Record a decision: cache it, draw it, count it
  function settleTweet(tweet, result) {
    cacheResult(tweet.id, result);

    let element = document.querySelector(`[data-ta-tweet-id="${tweet.id}"]`);
    if (!element && document.contains(tweet.element) && getTweetId(tweet.element) === tweet.id) {
      element = tweet.element;
    }
    if (element) applyVisualChanges(element, result, tweet.id);

    countDecision(tweet.id, result);
  }

  // Each tweet counts once toward "seen" and toward its topics, even when it is re-judged
  // (rule edited, threshold moved). Re-judging replaces the tweet's earlier contribution.
  const counted = new Map(); // tweetId -> { topics: [ids], hidden, tagged }
  function countDecision(tweetId, result) {
    const prev = counted.get(tweetId);
    if (prev) {
      stats.analyzed = Math.max(0, stats.analyzed - 1);
      if (prev.hidden) stats.hidden = Math.max(0, stats.hidden - 1);
      if (prev.tagged) stats.tagged = Math.max(0, stats.tagged - 1);
      for (const id of prev.topics) stats.byTopic[id] = Math.max(0, (stats.byTopic[id] || 0) - 1);
    }
    const entry = { topics: result.matchedCriteria.map(c => c.id), hidden: false, tagged: false };
    stats.analyzed++;
    if (entry.topics.length > 0) {
      if (result.matchedCriteria.some(c => c.actions.hide)) { stats.hidden++; entry.hidden = true; }
      else { stats.tagged++; entry.tagged = true; }
      for (const id of entry.topics) stats.byTopic[id] = (stats.byTopic[id] || 0) + 1;
    }
    counted.set(tweetId, entry);
    if (counted.size > 5000) counted.delete(counted.keys().next().value);
  }

  async function queueWorker() {
    while (tweetQueue.length > 0 && isActive && Date.now() >= pausedUntil) {
      const tweet = tweetQueue.shift();

      // Skip if already cached (might have been processed while in queue)
      if (tweetCache.has(tweet.id)) {
        const element = document.querySelector(`[data-ta-tweet-id="${tweet.id}"]`) || tweet.element;
        if (document.contains(element)) {
          applyVisualChanges(element, tweetCache.get(tweet.id).result, tweet.id);
        }
        continue;
      }

      // Another worker already has it
      if (pendingTweets.has(tweet.id)) continue;
      pendingTweets.add(tweet.id);

      try {
        const result = await analyzeTweet(tweet);

        if (result.failed) {
          handleDecisionFailure(tweet.id, result.error);
          continue;
        }
        consecutiveFailures = 0;
        failedAt.delete(tweet.id);

        // Cache the result
        cacheResult(tweet.id, result);

        // Find the element (might have changed)
        let element = document.querySelector(`[data-ta-tweet-id="${tweet.id}"]`);
        if (!element && document.contains(tweet.element)) {
          element = tweet.element;
        }

        if (element) {
          applyVisualChanges(element, result, tweet.id);
        }

        // Per-topic share: this is what shows how hard the algorithm leans on one topic
        countDecision(tweet.id, result);

        // Update popup stats
        chrome.runtime.sendMessage({ type: 'STATS_UPDATE', stats }).catch(() => {});
      } catch (err) {
        console.error('[Twitter Analyzer] Error processing tweet:', err);
      } finally {
        pendingTweets.delete(tweet.id);
      }

      // no pause: the worker count is the rate limit
    }
  }

  // Cache a result with LRU eviction
  function cacheResult(tweetId, result) {
    // Evict oldest if at capacity
    if (tweetCache.size >= CACHE_MAX_SIZE) {
      const oldestKey = tweetCache.keys().next().value;
      tweetCache.delete(oldestKey);
    }

    tweetCache.set(tweetId, {
      result,
      timestamp: Date.now()
    });
  }

  // Save cache to chrome.storage.local
  async function saveCacheToStorage() {
    try {
      const cacheObj = { __sig: engine.signature };
      tweetCache.forEach((value, key) => {
        cacheObj[key] = value;
      });
      await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: JSON.stringify(cacheObj) });
    } catch (e) {
      console.error('[Twitter Analyzer] Failed to save cache:', e);
    }
  }

  // Analyze a single tweet
  async function analyzeTweet(tweet) {
    const matchedCriteria = [];
    const scores = {};
    let usedEngine = 'regex';

    // Regex fast path. Skipped when Jev decides everything: Jev is cheap, fast, and does not
    // fall for keyword traps ("Apple pie", "Transformers the movie") the way patterns do.
    const useRegex = !(engine.jev && engine.decideAll);
    if (useRegex) {
      for (const c of criteria) {
        if (!c.regexPatterns || c.regexPatterns.length === 0) continue;

        for (const patternEntry of c.regexPatterns) {
          try {
            // Handle both old format (string) and new format (object with pattern property)
            const patternStr = typeof patternEntry === 'string' ? patternEntry : patternEntry.pattern;
            const regex = new RegExp(patternStr, 'i');
            if (regex.test(tweet.text)) {
              matchedCriteria.push(c);
              break;
            }
          } catch {
            // Invalid regex, skip
          }
        }
      }
    }

    // Everything regex did not settle goes to the decision engine (Jev, or the LLM as fallback)
    const unmatchedCriteria = criteria.filter(
      c => !matchedCriteria.some(m => m.id === c.id)
    );

    if (unmatchedCriteria.length > 0 && tweet.text.length > 10) {
      const askedAt = Date.now();
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'ANALYZE_TWEET',
          tweetText: tweet.text,
          author: tweet.author || '',
          // Only what the decision needs; regex lists can be long
          criteria: unmatchedCriteria.map(c => ({ id: c.id, description: c.description, jevInstruction: c.jevInstruction }))
        });

        if (response?.matches) {
          for (const matchId of response.matches) {
            const matched = unmatchedCriteria.find(c => c.id === matchId);
            if (matched && !matchedCriteria.some(m => m.id === matchId)) {
              matchedCriteria.push(matched);
            }
          }
        }
        if (response?.scores) Object.assign(scores, response.scores);
        if (response?.engine) usedEngine = response.engine;
        if (response?.engine && !response.error) {
          recordPerf(response.engine === 'jev' ? 'jev' : 'llm', { tweets: 1, calls: response.calls || 1, wallMs: Date.now() - askedAt, usage: response.usage, model: response.model });
        }

        // The engine answered with an error and decided nothing: this is not a "no match"
        if (response?.error && !response.matches?.length && matchedCriteria.length === 0) {
          return { matchedCriteria, scores, engine: usedEngine, failed: true, error: response.error };
        }
      } catch (err) {
        console.error('[Twitter Analyzer] Decision engine failed:', err);
        if (matchedCriteria.length === 0) {
          return { matchedCriteria, scores, engine: usedEngine, failed: true, error: err.message };
        }
      }
    }

    return { matchedCriteria, scores, engine: usedEngine };
  }

  // A decision could not be made. Do not cache it, retry later, and tell the user why.
  function handleDecisionFailure(tweetId, error) {
    failedAt.set(tweetId, Date.now());
    consecutiveFailures++;

    if (consecutiveFailures >= 3) {
      // Stop hammering a dead endpoint; everything queued is retried after the pause
      pausedUntil = Date.now() + RETRY_AFTER_MS;
      tweetQueue = [];
      setTimeout(() => { if (isActive) processVisibleTweets(); }, RETRY_AFTER_MS + 100);

      if (Date.now() - lastErrorShownAt > 60000) {
        lastErrorShownAt = Date.now();
        const who = engine.jev ? 'Jev' : 'Your LLM provider';
        const hint = /402/.test(error || '') ? ' (HTTP 402 means the account is out of credits)' : '';
        showNotification(`Timeline Analyzer: ${who} is not answering: ${error || 'unknown error'}${hint}. Retrying in 30s. Check the extension settings.`, 'error');
      }
    }
  }

  // Apply visual changes to tweet (non-destructive)
  function applyVisualChanges(element, result, tweetId) {
    if (!result || !element) return;

    // Mark element with tweet ID for future lookups
    element.dataset.taTweetId = tweetId;
    element.dataset.taProcessed = 'true';

    // No matches - ensure clean state
    if (!result.matchedCriteria || result.matchedCriteria.length === 0) {
      cleanVisuals(element);
      renderScores(element, result);
      return;
    }
    renderScores(element, result);

    // Process each criteria
    for (const criteriaItem of result.matchedCriteria) {
      // Hide action takes priority
      if (criteriaItem.actions.hide) {
        element.style.display = 'none';
        element.classList.add('ta-hidden');
        continue; // Don't apply other visuals if hidden
      }

      // Highlight action
      if (criteriaItem.actions.highlight) {
        // Always ensure the class and styles are applied (Twitter may remove them)
        element.classList.add('ta-highlighted');
        element.style.setProperty('--ta-highlight-color', criteriaItem.color + '20', 'important');
        element.style.setProperty('background-color', criteriaItem.color + '15', 'important');
        element.style.setProperty('position', 'relative', 'important');

        // Add highlight overlay if not exists
        let overlay = element.querySelector('.ta-highlight-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = 'ta-highlight-overlay';
          overlay.dataset.criteriaId = criteriaItem.id;
          element.insertBefore(overlay, element.firstChild);
        }
        // Always ensure overlay styles are set (Twitter may reset them)
        overlay.style.cssText = `
          position: absolute !important;
          top: 0 !important;
          left: 0 !important;
          width: 4px !important;
          height: 100% !important;
          background-color: ${criteriaItem.color} !important;
          opacity: 0.9 !important;
          pointer-events: none !important;
          z-index: 1 !important;
        `;
      }

      // Tag action (pill) - check if already exists before adding
      if (criteriaItem.actions.tag) {
        const existingPill = element.querySelector(`.ta-pill[data-criteria="${criteriaItem.id}"]`);
        if (!existingPill) {
          const userNameEl = element.querySelector(SELECTORS.userName);
          if (userNameEl) {
            const pill = document.createElement('span');
            pill.className = 'ta-pill';
            pill.dataset.criteria = criteriaItem.id;
            pill.style.backgroundColor = criteriaItem.color;

            // Show emoji + truncated description
            const emoji = criteriaItem.emoji || '🏷️';
            const text = truncateText(criteriaItem.description, 15);
            const p = result.scores?.[criteriaItem.id];
            pill.textContent = Number.isFinite(p) ? `${emoji} ${text} ${Math.round(p * 100)}%` : `${emoji} ${text}`;
            pill.title = Number.isFinite(p)
              ? `${criteriaItem.description} · ${Math.round(p * 100)}% (Jev)`
              : criteriaItem.description;

            // Find best insertion point
            const container = userNameEl.closest('div');
            if (container) {
              container.appendChild(pill);
            }
          }
        }
      }
    }
  }

  // Jev's probability for EVERY topic, on every decided tweet, matched or not.
  // This is the raw signal; tags and highlights are just that signal passed through the threshold.
  function renderScores(element, result) {
    const existing = element.querySelector('.ta-scores');
    if (!engine.showScores || !result?.scores) { existing?.remove(); return; }
    // A tweet that matched shows its tag(s) and nothing else: the decision is made, extra chips
    // are noise. Chips are for tweets that matched nothing, where they are the only signal.
    const showsTag = (result.matchedCriteria || []).some(c => c.actions?.tag && !c.actions?.hide);
    if (showsTag) { existing?.remove(); return; }
    const entries = criteria.filter(c => Number.isFinite(result.scores[c.id]));
    if (entries.length === 0) { existing?.remove(); return; }

    // Redraw only when something changed, so we do not feed our own MutationObserver
    const sig = entries.map(c => `${c.id}:${Math.round(result.scores[c.id] * 100)}:${c.emoji}:${c.color}`).join(',');
    if (existing && existing.dataset.sig === sig) return;
    existing?.remove();

    const userNameEl = element.querySelector(SELECTORS.userName);
    const container = userNameEl?.closest('div');
    if (!container) return;

    const row = document.createElement('span');
    row.className = 'ta-scores';
    row.dataset.sig = sig;
    row.title = criteria.filter(c => Number.isFinite(result.scores[c.id])).map(c => `${c.description}: ${Math.round(result.scores[c.id] * 100)}%`).join('\n')
      + (result.refined ? '\n(second opinion asked for this tweet)' : '');
    for (const c of entries) {
      const p = result.scores[c.id];
      const chip = document.createElement('span');
      chip.className = 'ta-score-chip';
      chip.textContent = `${c.emoji || '🏷️'} ${Math.round(p * 100)}%`;
      chip.style.setProperty('--ta-score-color', c.color || '#1d9bf0');
      chip.style.opacity = String(0.35 + 0.65 * p);
      row.appendChild(chip);
    }
    container.appendChild(row);
  }

  // Remove all visual modifications from an element
  function cleanVisuals(element) {
    element.querySelectorAll('.ta-pill, .ta-highlight-overlay, .ta-scores').forEach(el => el.remove());
    element.style.removeProperty('display');
    element.classList.remove('ta-hidden', 'ta-highlighted');
    element.style.removeProperty('--ta-highlight-color');
  }

  // Get tweet ID from element - prefer status ID, fallback to content hash
  function getTweetId(element) {
    // Method 1: Get from status link (most reliable)
    const timeLink = element.querySelector(SELECTORS.tweetLink);
    if (timeLink) {
      const link = timeLink.closest('a');
      if (link) {
        const match = link.href.match(/\/status\/(\d+)/);
        if (match) return match[1];
      }
    }

    // Method 2: Any status link
    const statusLink = element.querySelector('a[href*="/status/"]');
    if (statusLink) {
      const match = statusLink.href.match(/\/status\/(\d+)/);
      if (match) return match[1];
    }

    // Method 3: Fallback to content hash (less reliable but works for edge cases)
    const text = getTweetText(element);
    const userName = element.querySelector(SELECTORS.userName)?.textContent || '';
    if (text || userName) {
      return 'hash_' + hashCode(userName + text).toString();
    }

    return null;
  }

  // Get tweet text content (including quoted tweets, reply context, articles, etc.)
  // "@handle" of the tweet's author, used as context for the decision
  function getTweetAuthor(element) {
    const nameEl = element.querySelector(SELECTORS.userName);
    const match = nameEl?.textContent?.match(/@[A-Za-z0-9_]{1,15}/);
    return match ? match[0] : '';
  }

  function getTweetText(element) {
    const texts = [];

    // Main tweet text, then any quoted tweet, labelled so the decision engine knows which is which.
    // The quote often carries the actual subject ("Finally something new" + a quoted Jev benchmark).
    const textElements = Array.from(element.querySelectorAll(SELECTORS.tweetText));
    textElements.forEach((el, i) => {
      const t = el.textContent?.trim();
      if (!t) return;
      if (i === 0) { texts.push(t); return; }
      const quoteBox = el.closest('div[role="link"]');
      const handle = quoteBox?.querySelector(SELECTORS.userName)?.textContent?.match(/@[A-Za-z0-9_]{1,15}/)?.[0];
      texts.push(`[Quoted tweet${handle ? ` by ${handle}` : ''}: ${t}]`);
    });

    // Get article content if present (articles don't have tweetText)
    // Article title - usually in a specific styled div
    const articleTitle = element.querySelector('[data-testid="article-cover-image"] + div [class*="r-1inkyih"], [data-testid="card.wrapper"] [class*="r-1inkyih"]');
    if (articleTitle) {
      texts.push(articleTitle.textContent?.trim());
    }

    // Also try to get any card/article description text
    const articleDesc = element.querySelector('[data-testid="article-cover-image"] + div [class*="r-8akbws"], [data-testid="card.wrapper"] [class*="r-8akbws"]');
    if (articleDesc) {
      texts.push(articleDesc.textContent?.trim());
    }

    // Fallback: if no text found yet, try to get any substantial text content from the tweet
    // This catches edge cases like articles with different structures
    if (texts.filter(Boolean).length === 0) {
      // Look for the article content area
      const articleArea = element.querySelector('[data-testid="article-cover-image"]')?.parentElement;
      if (articleArea) {
        // Get text from sibling divs that contain the title/description
        const siblingDivs = articleArea.parentElement?.querySelectorAll(':scope > div');
        siblingDivs?.forEach(div => {
          if (div !== articleArea.parentElement && div.textContent?.trim().length > 10) {
            texts.push(div.textContent?.trim());
          }
        });
      }

      // Also check for card wrappers (links, polls, etc.)
      const cardWrapper = element.querySelector('[data-testid="card.wrapper"]');
      if (cardWrapper) {
        const cardText = cardWrapper.textContent?.trim();
        if (cardText && cardText.length > 10) {
          texts.push(cardText);
        }
      }
    }

    return texts.filter(Boolean).join(' ');
  }

  // Message handling from popup/background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TOGGLE_ANALYSIS') {
      isActive = message.isActive;
      if (isActive) {
        processVisibleTweets();
      }
      sendResponse({ ok: true });
    }

    if (message.type === 'UPDATE_CRITERIA') {
      const oldCriteriaIds = new Set(criteria.map(c => c.id));
      criteria = message.criteria || [];
      isActive = message.isActive;
      const newCriteriaIds = new Set(criteria.map(c => c.id));

      // Check if criteria changed (not just actions)
      const criteriaChanged =
        oldCriteriaIds.size !== newCriteriaIds.size ||
        [...oldCriteriaIds].some(id => !newCriteriaIds.has(id));

      if (criteriaChanged) {
        // Clear cache only if criteria fundamentally changed
        tweetCache.clear();
        pendingTweets.clear();
        tweetQueue = [];

        // Remove all visual modifications
        document.querySelectorAll('[data-ta-processed]').forEach(el => {
          cleanVisuals(el);
          delete el.dataset.taProcessed;
          delete el.dataset.taTweetId;
        });
      } else {
        // Just actions changed - re-apply visuals with new actions
        document.querySelectorAll('[data-ta-tweet-id]').forEach(el => {
          const tweetId = el.dataset.taTweetId;
          const cached = tweetCache.get(tweetId);
          if (cached) {
            // Update cached criteria with new actions
            cached.result.matchedCriteria = cached.result.matchedCriteria.map(mc => {
              const updated = criteria.find(c => c.id === mc.id);
              return updated || mc;
            });
            cleanVisuals(el);
            applyVisualChanges(el, cached.result, tweetId);
          }
        });
      }

      // Re-process if active
      if (isActive) {
        processVisibleTweets();
      }

      sendResponse({ ok: true });
    }

    if (message.type === 'RESET_STATS') {
      stats = { analyzed: 0, tagged: 0, hidden: 0, byTopic: {} };
      counted.clear();
      perf = { jev: newPerf(), llm: newPerf() };
      schedulePerfBroadcast();
      sendResponse({ ok: true });
    }

    if (message.type === 'GET_PERF') {
      sendResponse({ perf: perfSnapshot() });
    }

    if (message.type === 'GET_STATS') {
      sendResponse({ stats });
    }

    return true;
  });

  // Utility functions
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 1) + '...';
  }

  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  // ========== MENU INJECTION & LEARNING SYSTEM ==========

  // Watch for Twitter's dropdown menu and inject our item
  function setupMenuObserver() {
    // Track clicks on the "more" button to know which tweet's menu is opening
    document.addEventListener('click', (e) => {
      const moreBtn = e.target.closest('[data-testid="caret"]');
      if (moreBtn) {
        const tweet = moreBtn.closest(SELECTORS.tweet);
        if (tweet) {
          lastMenuTweet = tweet;
          console.log('[Twitter Analyzer] Tracked menu click for tweet');
        }
      }
    }, true);

    // Watch for menu appearing - Twitter renders menus in a layer/portal
    const menuObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;

          // Look for the dropdown menu - it appears in layers
          let menu = null;

          // Check if this node is a menu
          if (node.matches?.('[role="menu"]')) {
            menu = node;
          } else if (node.querySelector) {
            // Check children
            menu = node.querySelector('[role="menu"]');
          }

          // Also check for the layer container that Twitter uses
          if (!menu && node.matches?.('[data-testid="Dropdown"]')) {
            menu = node.closest('[role="menu"]') || node;
          }

          if (menu && !menu.querySelector('.ta-categorize-item')) {
            console.log('[Twitter Analyzer] Found menu, injecting item');
            injectMenuItem(menu);
          }
        }
      }
    });

    menuObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Also watch for attribute changes that might indicate menu visibility
    const layerObserver = new MutationObserver(() => {
      // Check for any menu that doesn't have our item
      const menus = document.querySelectorAll('[role="menu"]');
      menus.forEach(menu => {
        if (lastMenuTweet && !menu.querySelector('.ta-categorize-item')) {
          console.log('[Twitter Analyzer] Found menu via layer observer');
          injectMenuItem(menu);
        }
      });
    });

    // Watch the layers container where Twitter puts dropdowns
    const setupLayerObserver = () => {
      const layersContainer = document.getElementById('layers');
      if (layersContainer) {
        layerObserver.observe(layersContainer, {
          childList: true,
          subtree: true
        });
        console.log('[Twitter Analyzer] Layer observer attached to #layers');
      } else {
        // Retry after a short delay - layers might not exist yet
        setTimeout(setupLayerObserver, 1000);
      }
    };
    setupLayerObserver();
  }

  // Inject our menu item into Twitter's dropdown
  function injectMenuItem(menu) {
    if (!criteria.length) {
      console.log('[Twitter Analyzer] No criteria, skipping menu injection');
      return;
    }

    if (!lastMenuTweet) {
      console.log('[Twitter Analyzer] No tweet tracked, skipping menu injection');
      return;
    }

    // Already injected?
    if (menu.querySelector('.ta-categorize-item')) {
      return;
    }

    // Find the dropdown container - try multiple selectors
    let dropdown = menu.querySelector('[data-testid="Dropdown"]');
    if (!dropdown) {
      // Fallback: the menu itself might be the container, or first child div
      dropdown = menu.querySelector('div[role="group"]') || menu.firstElementChild || menu;
    }

    if (!dropdown) {
      console.log('[Twitter Analyzer] Could not find dropdown container');
      return;
    }

    // Create our menu item with Twitter's styling
    const menuItem = document.createElement('div');
    menuItem.className = 'ta-categorize-item';
    menuItem.setAttribute('role', 'menuitem');
    menuItem.setAttribute('tabindex', '0');
    menuItem.style.cssText = `
      display: flex;
      align-items: center;
      padding: 12px 16px;
      cursor: pointer;
      transition: background-color 0.2s;
      border-bottom: 1px solid rgb(56, 68, 77);
    `;
    menuItem.innerHTML = `
      <div style="margin-right: 12px; display: flex; align-items: center;">
        <svg viewBox="0 0 24 24" width="18" height="18" style="fill: rgb(29, 155, 240);">
          <g><path d="M4 4.5C4 3.12 5.12 2 6.5 2h11C18.88 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zm2 0v13.56l6-4.29 6 4.29V4.5c0-.28-.22-.5-.5-.5h-11c-.28 0-.5.22-.5.5z"></path></g>
        </svg>
      </div>
      <div style="flex: 1;">
        <span style="color: rgb(29, 155, 240); font-size: 15px; font-weight: 400;">Categorize for Timeline Analyzer</span>
      </div>
    `;

    menuItem.addEventListener('mouseenter', () => {
      menuItem.style.backgroundColor = 'rgba(29, 155, 240, 0.1)';
    });

    menuItem.addEventListener('mouseleave', () => {
      menuItem.style.backgroundColor = 'transparent';
    });

    menuItem.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      console.log('[Twitter Analyzer] Categorize clicked');

      // Close Twitter's menu by clicking outside or pressing escape
      const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(escEvent);

      // Show our categorize modal
      setTimeout(() => showCategorizeModal(), 150);
    });

    // Insert at the top of the menu
    dropdown.insertBefore(menuItem, dropdown.firstChild);
    console.log('[Twitter Analyzer] Menu item injected successfully');
  }

  // Create the categorize modal (hidden by default)
  function createCategorizeModal() {
    if (document.getElementById('ta-categorize-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'ta-categorize-modal';
    modal.className = 'ta-modal-overlay';
    modal.innerHTML = `
      <div class="ta-modal">
        <div class="ta-modal-header">
          <h3>Categorize Tweet</h3>
          <button class="ta-modal-close">&times;</button>
        </div>
        <div class="ta-modal-body">
          <div class="ta-modal-section">
            <label>Select topic(s) this tweet belongs to:</label>
            <div id="ta-topic-list" class="ta-topic-list"></div>
          </div>
          <div class="ta-modal-section">
            <label>Why should this tweet match? (optional)</label>
            <textarea id="ta-feedback-comment" placeholder="e.g., 'It mentions Railway which is related to deployment infrastructure'"></textarea>
          </div>
          <div class="ta-modal-preview">
            <label>Tweet preview:</label>
            <div id="ta-tweet-preview" class="ta-tweet-preview"></div>
          </div>
        </div>
        <div class="ta-modal-footer">
          <button class="ta-btn ta-btn-secondary" id="ta-modal-cancel">Cancel</button>
          <button class="ta-btn ta-btn-primary" id="ta-modal-submit">Learn & Categorize</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event listeners
    modal.querySelector('.ta-modal-close').addEventListener('click', hideCategorizeModal);
    modal.querySelector('#ta-modal-cancel').addEventListener('click', hideCategorizeModal);
    modal.querySelector('#ta-modal-submit').addEventListener('click', submitCategorization);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideCategorizeModal();
    });
  }

  // Show the categorize modal
  function showCategorizeModal() {
    if (!lastMenuTweet || !criteria.length) return;

    const modal = document.getElementById('ta-categorize-modal');
    if (!modal) return;

    // Populate topics
    const topicList = modal.querySelector('#ta-topic-list');
    topicList.innerHTML = criteria.map(c => `
      <label class="ta-topic-option">
        <input type="checkbox" value="${c.id}">
        <span class="ta-topic-emoji">${c.emoji || '🏷️'}</span>
        <span class="ta-topic-name">${c.description}</span>
        <span class="ta-topic-color" style="background: ${c.color}"></span>
      </label>
    `).join('');

    // Populate tweet preview
    const tweetText = getTweetText(lastMenuTweet);
    const userName = lastMenuTweet.querySelector(SELECTORS.userName)?.textContent || '';
    modal.querySelector('#ta-tweet-preview').textContent = `@${userName.split('@')[1] || userName}: ${tweetText.substring(0, 200)}${tweetText.length > 200 ? '...' : ''}`;

    // Clear comment
    modal.querySelector('#ta-feedback-comment').value = '';

    // Show modal
    modal.classList.add('ta-modal-visible');
  }

  // Hide the categorize modal
  function hideCategorizeModal() {
    const modal = document.getElementById('ta-categorize-modal');
    if (modal) {
      modal.classList.remove('ta-modal-visible');
    }
  }

  // Submit the categorization and learn
  async function submitCategorization() {
    const modal = document.getElementById('ta-categorize-modal');
    if (!modal || !lastMenuTweet) return;

    // Get selected topics
    const selectedTopics = Array.from(modal.querySelectorAll('#ta-topic-list input:checked'))
      .map(input => input.value);

    if (selectedTopics.length === 0) {
      alert('Please select at least one topic');
      return;
    }

    const comment = modal.querySelector('#ta-feedback-comment').value.trim();
    const tweetText = getTweetText(lastMenuTweet);
    const tweetId = getTweetId(lastMenuTweet);

    // Show loading state
    const submitBtn = modal.querySelector('#ta-modal-submit');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Learning...';

    try {
      // Send to background for learning
      const response = await chrome.runtime.sendMessage({
        type: 'LEARN_FROM_FEEDBACK',
        tweetText,
        selectedTopicIds: selectedTopics,
        userComment: comment
      });

      if (response?.success) {
        // Update local criteria with new patterns
        if (response.updatedCriteria) {
          for (const updated of response.updatedCriteria) {
            const idx = criteria.findIndex(c => c.id === updated.id);
            if (idx !== -1) {
              criteria[idx].regexPatterns = updated.regexPatterns;
            }
          }
          // Save updated criteria
          await chrome.storage.local.set({ criteria });
        }

        // Mark this tweet as matching the selected topics
        const matchedCriteria = criteria.filter(c => selectedTopics.includes(c.id));
        const result = { matchedCriteria };
        cacheResult(tweetId, result);
        applyVisualChanges(lastMenuTweet, result, tweetId);

        // Update stats
        stats.tagged++;
        chrome.runtime.sendMessage({ type: 'STATS_UPDATE', stats }).catch(() => {});

        // Show success notification
        showNotification('Learned! Future similar tweets will be categorized automatically.', 'success');
      } else {
        showNotification(response?.error || 'Failed to learn from feedback', 'error');
      }
    } catch (err) {
      console.error('[Twitter Analyzer] Learning failed:', err);
      showNotification('Failed to learn from feedback', 'error');
    }

    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
    hideCategorizeModal();
  }

  // Show a notification toast
  function showNotification(message, type = 'info') {
    const existing = document.querySelector('.ta-notification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.className = `ta-notification ta-notification-${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    // Animate in
    requestAnimationFrame(() => {
      notification.classList.add('ta-notification-visible');
    });

    // Remove after 4 seconds
    setTimeout(() => {
      notification.classList.remove('ta-notification-visible');
      setTimeout(() => notification.remove(), 300);
    }, 4000);
  }

  // Start
  init();
})();
