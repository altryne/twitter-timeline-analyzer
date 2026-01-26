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
  let stats = { analyzed: 0, tagged: 0, hidden: 0 };

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

    // Restore cache from storage
    if (data[CACHE_STORAGE_KEY]) {
      try {
        const cached = JSON.parse(data[CACHE_STORAGE_KEY]);
        Object.entries(cached).forEach(([id, value]) => {
          tweetCache.set(id, value);
        });
        console.log(`[Twitter Analyzer] Restored ${tweetCache.size} cached tweets`);
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

    console.log('[Twitter Analyzer] Content script initialized');
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

      clearTimeout(mutationTimeout);
      mutationTimeout = setTimeout(() => {
        processVisibleTweets();
      }, 150);
    });

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
          prioritizeVisibleTweets();
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
    if (!cached || !cached.result.matchedCriteria.length) return true;

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
    const tweets = document.querySelectorAll(SELECTORS.tweet);

    tweets.forEach(tweet => {
      const tweetId = getTweetId(tweet);
      if (!tweetId) return;

      // Check if already cached
      if (tweetCache.has(tweetId)) {
        applyVisualChanges(tweet, tweetCache.get(tweetId).result, tweetId);
        return;
      }

      // Check if already pending
      if (pendingTweets.has(tweetId)) return;

      // Check if already in queue
      if (tweetQueue.some(t => t.id === tweetId)) return;

      const tweetText = getTweetText(tweet);
      if (tweetText) {
        tweetQueue.push({
          id: tweetId,
          element: tweet,
          text: tweetText
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

  // Process tweet queue
  async function processQueue() {
    if (isProcessing || tweetQueue.length === 0 || criteria.length === 0) return;

    isProcessing = true;

    while (tweetQueue.length > 0 && isActive) {
      const tweet = tweetQueue.shift();

      // Skip if already cached (might have been processed while in queue)
      if (tweetCache.has(tweet.id)) {
        const element = document.querySelector(`[data-ta-tweet-id="${tweet.id}"]`) || tweet.element;
        if (document.contains(element)) {
          applyVisualChanges(element, tweetCache.get(tweet.id).result, tweet.id);
        }
        continue;
      }

      // Mark as pending
      pendingTweets.add(tweet.id);

      try {
        const result = await analyzeTweet(tweet);

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

        stats.analyzed++;
        if (result.matchedCriteria.length > 0) {
          if (result.matchedCriteria.some(c => c.actions.hide)) {
            stats.hidden++;
          } else {
            stats.tagged++;
          }
        }

        // Update popup stats
        chrome.runtime.sendMessage({ type: 'STATS_UPDATE', stats }).catch(() => {});
      } catch (err) {
        console.error('[Twitter Analyzer] Error processing tweet:', err);
      } finally {
        pendingTweets.delete(tweet.id);
      }

      // Small delay to avoid overwhelming the API
      await sleep(50);
    }

    isProcessing = false;

    // Save cache periodically
    saveCacheToStorage();
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
      const cacheObj = {};
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

    // First, try regex matching (fast path)
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

    // If no regex matches and we have unmatched criteria, use LLM
    const unmatchedCriteria = criteria.filter(
      c => !matchedCriteria.some(m => m.id === c.id)
    );

    if (unmatchedCriteria.length > 0 && tweet.text.length > 10) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'ANALYZE_TWEET',
          tweetText: tweet.text,
          criteria: unmatchedCriteria
        });

        if (response?.matches) {
          for (const matchId of response.matches) {
            const matched = unmatchedCriteria.find(c => c.id === matchId);
            if (matched && !matchedCriteria.some(m => m.id === matchId)) {
              matchedCriteria.push(matched);
            }
          }
        }
      } catch (err) {
        console.error('[Twitter Analyzer] LLM analysis failed:', err);
      }
    }

    return { matchedCriteria };
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
      return;
    }

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
            pill.textContent = `${emoji} ${text}`;
            pill.title = criteriaItem.description;

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

  // Remove all visual modifications from an element
  function cleanVisuals(element) {
    element.querySelectorAll('.ta-pill, .ta-highlight-overlay').forEach(el => el.remove());
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
  function getTweetText(element) {
    const texts = [];

    // Get regular tweetText elements (main tweet + quoted tweet)
    const textElements = element.querySelectorAll(SELECTORS.tweetText);
    texts.push(...Array.from(textElements).map(el => el.textContent?.trim()).filter(Boolean));

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
