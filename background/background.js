// Background service worker for Twitter Timeline Analyzer
import * as weave from '../lib/weaveShim.js';
import { decideTweet, decideTweetsHybrid, JEV_DEFAULT_MODEL, JEV_DEFAULT_THRESHOLD } from '../lib/jev.js';

const JEV_SETTING_KEYS = ['jevEnabled', 'jevApiKey', 'jevModel', 'jevThreshold', 'jevDecideAll', 'jevShowScores', 'showHud', 'llmPriceIn', 'llmPriceOut', 'preset'];

// Initialize Weave when settings are available
async function initWeave() {
  const settings = await chrome.storage.local.get(['wandbApiKey', 'wandbProject']);
  if (settings.wandbApiKey && settings.wandbProject) {
    weave.init(settings.wandbProject, { apiKey: settings.wandbApiKey });
  }
}
initWeave();

// Re-initialize Weave when settings change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.wandbApiKey || changes.wandbProject)) {
    initWeave();
  }
  // When Jev gets switched on, have the LLM write decision criteria for topics that lack them
  // Same when the LLM starts working again (new key, model or provider): topics added while it
  // was down never got their rule written
  if (area === 'local' && (changes.jevEnabled?.newValue || changes.jevApiKey?.newValue ||
      changes.apiKey?.newValue || changes.model?.newValue || changes.apiBaseUrl?.newValue)) {
    backfillJevInstructions();
  }
});
backfillJevInstructions();

// Open as a native side panel where the browser has one; fall back to the popup elsewhere.
// Arc exposes chrome.sidePanel but never shows it, so a content script tells us when it sees Arc.
async function applyPanelMode() {
  const { isArc, useSidePanel } = await chrome.storage.local.get(['isArc', 'useSidePanel']);
  const canPanel = Boolean(chrome.sidePanel?.setPanelBehavior) && !isArc && useSidePanel !== false;
  try {
    if (canPanel) {
      await chrome.action.setPopup({ popup: '' });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } else {
      if (chrome.sidePanel?.setPanelBehavior) await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.action.setPopup({ popup: 'popup/popup.html' });
    }
  } catch (err) {
    console.error('Panel mode failed, using the popup:', err);
    chrome.action.setPopup({ popup: 'popup/popup.html' }).catch(() => {});
  }
}
applyPanelMode();
chrome.runtime.onStartup.addListener(applyPanelMode);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.isArc || changes.useSidePanel)) applyPanelMode();
});

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ARC_DETECTED') {
    chrome.storage.local.set({ isArc: true });
    return false;
  }

  if (message.type === 'GENERATE_PATTERNS') {
    generatePatternsAndEmoji(message.description)
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('Pattern generation error:', err);
        sendResponse({ patterns: [], emoji: null, error: err.message });
      });
    return true; // Keep channel open for async response
  }

  if (message.type === 'ANALYZE_TWEET') {
    analyzeTweet(message.tweetText, message.criteria, message.author)
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('Tweet analysis error:', err);
        sendResponse({ matches: [], error: err.message });
      });
    return true;
  }

  if (message.type === 'ANALYZE_TWEETS_BULK') {
    analyzeTweetsBulk(message.tweets, message.criteria)
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('Bulk analysis error:', err);
        sendResponse({ results: {}, error: err.message });
      });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'model', ...JEV_SETTING_KEYS])
      .then(settings => {
        // Never hand API keys to the content script; it only needs to know what is on
        const { apiKey, jevApiKey, ...rest } = settings;
        sendResponse({ ...rest, llmConfigured: Boolean(apiKey && settings.apiBaseUrl && settings.model), jevKeySet: Boolean(jevApiKey), jevConfigured: Boolean(settings.jevEnabled && jevApiKey) });
      });
    return true;
  }

  if (message.type === 'LEARN_FROM_FEEDBACK') {
    learnFromFeedback(message.tweetText, message.selectedTopicIds, message.userComment)
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('Learning error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});

// Generate regex patterns and emoji suggestion from natural language description
async function generatePatternsAndEmoji(description) {
  const settings = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'model']);

  if (!settings.apiKey || !settings.apiBaseUrl || !settings.model) {
    return { patterns: [], emoji: null };
  }

  // Start parent trace for this operation
  const traceContext = await weave.startTrace('generate_patterns', { description });

  const systemPrompt = `You are a topic analyzer. Given a topic description, generate:
1. 3-8 regex patterns that would match tweets about that topic
2. A single emoji that best represents this topic
3. A decision criterion: ONE declarative sentence a fast yes/no classifier will judge each tweet against

Rules for patterns:
- Generate patterns that are case-insensitive (will be used with /i flag)
- Focus on keywords, phrases, and common variations
- Include word boundaries where appropriate (\\b)
- Avoid overly broad patterns that would match too much
- Include common hashtags related to the topic

Rules for emoji:
- Choose ONE emoji that best visually represents the topic
- Be specific - for "AI" use 🤖, for "politics" use 🏛️, for "sports" use ⚽, etc.

Rules for the decision criterion:
- Start with "The tweet is about" and state the topic precisely
- Name what counts (entities, subtopics, typical phrasing) and, if the topic has an obvious false friend, what does NOT count
- One sentence, under 40 words, no questions, no instructions to the reader

Return ONLY a JSON object with this exact structure, nothing else:
{
  "patterns": ["pattern1", "pattern2", ...],
  "emoji": "🎯",
  "jevInstruction": "The tweet is about ..."
}

Example input: "AI and machine learning discussions"
Example output: {"patterns": ["\\\\bAI\\\\b", "\\\\bartificial intelligence\\\\b", "\\\\bmachine learning\\\\b", "\\\\bML\\\\b", "\\\\bdeep learning\\\\b", "#MachineLearning", "#AI\\\\b", "\\\\bGPT", "\\\\bLLM\\\\b"], "emoji": "🤖", "jevInstruction": "The tweet is about artificial intelligence: AI models, labs, research, agents, or AI products and tools, not the movie or unrelated uses of the letters AI."}`;

  try {
    const response = await callLLM(settings, systemPrompt, `Analyze this topic: "${description}"`, traceContext);

    // Try to parse as JSON object
    const cleaned = response.trim().replace(/```json\n?|\n?```/g, '');
    const result = JSON.parse(cleaned);

    if (result && typeof result === 'object') {
      const patterns = Array.isArray(result.patterns)
        ? result.patterns.filter(p => {
            try {
              new RegExp(p, 'i');
              return true;
            } catch {
              return false;
            }
          })
        : [];

      const emoji = typeof result.emoji === 'string' && result.emoji.length > 0
        ? result.emoji
        : null;

      const jevInstruction = typeof result.jevInstruction === 'string' && result.jevInstruction.trim().length > 0
        ? result.jevInstruction.trim()
        : null;

      const output = { patterns, emoji, jevInstruction };
      await weave.endTrace(traceContext, output);
      return output;
    }
  } catch (err) {
    console.error('Failed to parse response:', err);
    await weave.endTrace(traceContext, { error: err.message });
  }

  await weave.endTrace(traceContext, { patterns: [], emoji: null });
  return { patterns: [], emoji: null };
}

// Decide with Jev (TypeSafe System One): one call per tweet, one yes/no question per topic
async function analyzeTweetWithJev(tweetText, criteria, author, settings) {
  const traceContext = await weave.startTrace('jev_decide_tweet', {
    tweetText: tweetText.substring(0, 200),
    criteriaCount: criteria.length
  });
  try {
    const result = await decideTweet({
      apiKey: settings.jevApiKey,
      model: settings.jevModel || JEV_DEFAULT_MODEL,
      threshold: Number.isFinite(Number(settings.jevThreshold)) ? Number(settings.jevThreshold) : JEV_DEFAULT_THRESHOLD,
      tweetText,
      author,
      criteria
    });
    const output = { matches: result.matches, scores: result.scores, engine: 'jev', latencyMs: result.latencyMs, usage: result.usage || null, model: result.model, calls: 1 };
    await weave.endTrace(traceContext, output, { model: result.model, usage: result.usage });
    return output;
  } catch (err) {
    await weave.endTrace(traceContext, { error: err.message });
    throw err;
  }
}

// Bulk decisions with Jev: up to a screenful of tweets in one call, a probability for every
// (tweet, topic) pair, and a second single-tweet opinion only for uncertain scores.
async function analyzeTweetsBulk(tweets, criteria) {
  const settings = await chrome.storage.local.get(JEV_SETTING_KEYS);
  if (!settings.jevEnabled || !settings.jevApiKey) {
    return { results: {}, error: 'Jev not configured' };
  }

  const traceContext = await weave.startTrace('jev_decide_bulk', {
    tweetCount: tweets.length,
    criteriaCount: criteria.length
  });
  try {
    const out = await decideTweetsHybrid({
      apiKey: settings.jevApiKey,
      model: settings.jevModel || JEV_DEFAULT_MODEL,
      threshold: Number.isFinite(Number(settings.jevThreshold)) ? Number(settings.jevThreshold) : JEV_DEFAULT_THRESHOLD,
      tweets,
      criteria
    });
    const result = {
      results: out.results,
      engine: 'jev',
      model: out.model,
      bulkLatencyMs: out.bulkLatencyMs,
      refinedCount: out.refinedCount,
      calls: 1 + (out.refinedCount || 0),
      usage: out.usage || null
    };
    await weave.endTrace(traceContext, { tweetCount: tweets.length, refinedCount: out.refinedCount, bulkLatencyMs: out.bulkLatencyMs }, { model: out.model, usage: out.usage });
    return result;
  } catch (err) {
    await weave.endTrace(traceContext, { error: err.message });
    return { results: {}, error: `Jev: ${err.message}` };
  }
}

// Analyze a tweet against criteria. Jev decides when enabled; the LLM is the fallback.
async function analyzeTweet(tweetText, criteria, author = '') {
  const settings = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'model', ...JEV_SETTING_KEYS]);

  let jevError = null;
  if (settings.jevEnabled && settings.jevApiKey) {
    try {
      return await analyzeTweetWithJev(tweetText, criteria, author, settings);
    } catch (err) {
      console.error('Jev decision failed, falling back to LLM:', err);
      jevError = err.message;
    }
  }

  if (!settings.apiKey || !settings.apiBaseUrl || !settings.model) {
    // Report the engine that actually failed, not the missing fallback
    return { matches: [], error: jevError ? `Jev: ${jevError}` : 'API not configured' };
  }

  // Start parent trace for this operation
  const traceContext = await weave.startTrace('analyze_tweet', {
    tweetText: tweetText.substring(0, 200), // Truncate for trace readability
    criteriaCount: criteria.length
  });

  const criteriaList = criteria.map((c, i) => `${i + 1}. "${c.description}" (ID: ${c.id})`).join('\n');

  const systemPrompt = `You are a tweet classifier. Analyze the given tweet and determine which topics/criteria it matches.

Available criteria:
${criteriaList}

Rules:
- A tweet can match multiple criteria
- Only match if the tweet is clearly related to the topic
- Consider context, not just keywords
- Return ONLY a JSON array of matching criteria IDs, nothing else
- If no criteria match, return an empty array []

Example output: ["abc123", "def456"]`;

  const llmMeta = {};
  try {
    const response = await callLLM(settings, systemPrompt, `Classify this tweet:\n"${tweetText}"`, traceContext, llmMeta);

    const cleaned = response.trim().replace(/```json\n?|\n?```/g, '');
    const matches = JSON.parse(cleaned);

    if (Array.isArray(matches)) {
      // Validate that returned IDs exist in criteria
      const validIds = new Set(criteria.map(c => c.id));
      const validMatches = matches.filter(id => validIds.has(id));
      const output = { matches: validMatches, engine: 'llm', model: settings.model, latencyMs: llmMeta.latencyMs, usage: llmMeta.usage || null, calls: 1 };
      await weave.endTrace(traceContext, output);
      return output;
    }
  } catch (err) {
    console.error('Failed to parse analysis:', err);
    await weave.endTrace(traceContext, { error: err.message });
    // A provider error (402 out of credits, 401 bad key, 429) is a failed decision, not a "no match"
    if (!(err instanceof SyntaxError)) {
      return { matches: [], error: err.message, engine: 'llm' };
    }
  }

  await weave.endTrace(traceContext, { matches: [] });
  return { matches: [] };
}

// Have the LLM write a Jev decision criterion for one topic
async function generateJevInstruction(description, settings, extraContext = '') {
  const systemPrompt = `You write decision criteria for a fast yes/no tweet classifier.
Given a topic, return ONE declarative sentence the classifier will judge each tweet against.

Rules:
- Start with "The tweet is about" and state the topic precisely
- Name what counts (entities, subtopics, typical phrasing) and, if the topic has an obvious false friend, what does NOT count
- One sentence, under 40 words, no questions, no instructions to the reader

Return ONLY a JSON object: {"jevInstruction": "The tweet is about ..."}`;
  const response = await callLLM(settings, systemPrompt, `Topic: "${description}"${extraContext}`);
  const cleaned = response.trim().replace(/```json\n?|\n?```/g, '');
  const parsed = JSON.parse(cleaned);
  return typeof parsed.jevInstruction === 'string' ? parsed.jevInstruction.trim() : null;
}

// Topics created before Jev was enabled have no decision criterion yet: write them once
let backfillInFlight = false;
async function backfillJevInstructions() {
  if (backfillInFlight) return;
  backfillInFlight = true;
  try {
    const settings = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'model', 'criteria', 'jevEnabled', 'jevApiKey']);
    if (!settings.jevEnabled || !settings.jevApiKey) return;
    if (!settings.apiKey || !settings.apiBaseUrl || !settings.model) return;

    const missing = (settings.criteria || []).filter(c => !c.jevInstruction && !c.generating);
    if (missing.length === 0) return;

    const written = {};
    for (const topic of missing) {
      try {
        const instruction = await generateJevInstruction(topic.description, settings);
        if (instruction) written[topic.id] = instruction;
      } catch (err) {
        console.error(`Failed to write Jev criterion for topic ${topic.id}:`, err);
      }
    }

    if (Object.keys(written).length > 0) {
      // Re-read so edits made while the LLM was working are not clobbered
      const fresh = await chrome.storage.local.get(['criteria']);
      const criteria = (fresh.criteria || []).map(c => written[c.id] && !c.jevInstruction ? { ...c, jevInstruction: written[c.id] } : c);
      await chrome.storage.local.set({ criteria });
    }
  } finally {
    backfillInFlight = false;
  }
}

// Generic LLM API call with Weave tracing
async function callLLM(settings, systemPrompt, userMessage, parentContext = null, meta = null) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  const makeCall = async () => {
    const response = await fetch(`${settings.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        messages: messages,
        max_tokens: 500,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage
    };
  };

  // Trace with Weave if enabled
  const started = Date.now();
  const result = await weave.traceLLMCall(settings.model, messages, makeCall, parentContext);
  if (meta) {
    meta.latencyMs = Date.now() - started;
    meta.usage = result.usage || null;
  }
  return result.content;
}

// Learn from user feedback - analyze why tweet wasn't matched and update patterns
async function learnFromFeedback(tweetText, selectedTopicIds, userComment) {
  const settings = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'model', 'criteria']);

  if (!settings.apiKey || !settings.apiBaseUrl || !settings.model) {
    return { success: false, error: 'API not configured' };
  }

  const criteria = settings.criteria || [];
  const selectedTopics = criteria.filter(c => selectedTopicIds.includes(c.id));

  if (selectedTopics.length === 0) {
    return { success: false, error: 'No valid topics selected' };
  }

  // Start parent trace for this operation
  const traceContext = await weave.startTrace('learn_from_feedback', {
    tweetText: tweetText.substring(0, 200),
    topicCount: selectedTopics.length,
    hasComment: Boolean(userComment)
  });

  const updatedCriteria = [];
  const instructionUpdates = [];

  for (const topic of selectedTopics) {
    const existingPatterns = topic.regexPatterns || [];

    const systemPrompt = `You are a pattern learning system. A user has manually categorized a tweet as belonging to a topic, but the existing regex patterns didn't catch it.

Topic: "${topic.description}"
Existing patterns: ${JSON.stringify(existingPatterns)}

${userComment ? `User's explanation: "${userComment}"` : ''}

Your task:
1. Analyze why the existing patterns didn't match this tweet
2. Generate 2-5 NEW regex patterns that would catch this tweet AND similar tweets
3. Focus on extracting the key terms, entities, or patterns that indicate this topic
4. Don't duplicate existing patterns
5. Patterns should be case-insensitive (will use /i flag)
6. Use word boundaries (\\b) where appropriate

7. Also rewrite the topic's decision criterion so a yes/no classifier would say yes to this tweet and similar ones: ONE declarative sentence starting with "The tweet is about", under 45 words, keeping what the current criterion already covers
Current decision criterion: ${JSON.stringify(topic.jevInstruction || `The tweet is about ${topic.description}`)}

Return ONLY a JSON object with this structure:
{
  "analysis": "Brief explanation of why existing patterns missed this",
  "newPatterns": ["pattern1", "pattern2", ...],
  "jevInstruction": "The tweet is about ..."
}`;

    const userMessage = `Tweet that should match "${topic.description}":\n"${tweetText}"`;

    try {
      const response = await callLLM(settings, systemPrompt, userMessage, traceContext);
      const cleaned = response.trim().replace(/```json\n?|\n?```/g, '');
      const result = JSON.parse(cleaned);

      // Refined Jev criterion: saved even when no new regex patterns survive validation
      const refinedInstruction = result && typeof result.jevInstruction === 'string' && result.jevInstruction.trim().length > 0
        ? result.jevInstruction.trim()
        : null;
      if (refinedInstruction) {
        const topicIdx = criteria.findIndex(c => c.id === topic.id);
        if (topicIdx !== -1 && criteria[topicIdx].jevInstruction !== refinedInstruction) {
          criteria[topicIdx].jevInstruction = refinedInstruction;
          instructionUpdates.push({ id: topic.id, jevInstruction: refinedInstruction });
        }
      }

      if (result && Array.isArray(result.newPatterns)) {
        // Normalize existing patterns to check for duplicates
        const existingPatternStrings = existingPatterns.map(p =>
          typeof p === 'string' ? p.toLowerCase() : p.pattern.toLowerCase()
        );

        // Validate and add new patterns
        const validNewPatterns = result.newPatterns.filter(p => {
          try {
            new RegExp(p, 'i');
            // Don't add if it already exists
            return !existingPatternStrings.includes(p.toLowerCase());
          } catch {
            return false;
          }
        });

        if (validNewPatterns.length > 0) {
          // Normalize existing patterns to object format
          const normalizedExisting = existingPatterns.map(p =>
            typeof p === 'string' ? { pattern: p, isLearned: false } : p
          );

          // Add new patterns with isLearned: true
          const newPatternObjects = validNewPatterns.map(p => ({
            pattern: p,
            isLearned: true
          }));

          const updatedPatterns = [...normalizedExisting, ...newPatternObjects];

          // Find and update in the criteria array
          const idx = criteria.findIndex(c => c.id === topic.id);
          if (idx !== -1) {
            criteria[idx].regexPatterns = updatedPatterns;
            updatedCriteria.push({
              id: topic.id,
              regexPatterns: updatedPatterns,
              analysis: result.analysis,
              newPatternsCount: validNewPatterns.length
            });
          }
        }
      }
    } catch (err) {
      console.error(`Failed to learn patterns for topic ${topic.id}:`, err);
    }
  }

  // Save updated criteria
  if (updatedCriteria.length > 0 || instructionUpdates.length > 0) {
    await chrome.storage.local.set({ criteria });
  }

  const result = {
    success: true,
    updatedCriteria,
    instructionUpdates,
    message: `Learned ${updatedCriteria.reduce((sum, c) => sum + (c.newPatternsCount || 0), 0)} new patterns`
  };

  await weave.endTrace(traceContext, result);
  return result;
}

// After an install, update or reload, X tabs that were already open still hold the old, now dead
// content script and would silently do nothing until refreshed. Put the fresh one in.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://twitter.com/*', 'https://x.com/*'] });
    for (const tab of tabs) {
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      } catch (err) {
        // Tab not injectable (discarded, error page): it gets the script on its next load
      }
    }
  } catch (err) {
    console.error('Failed to re-inject content script:', err);
  }
});

// Handle extension icon click - ensure content script is ready
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url?.includes('twitter.com') || tab.url?.includes('x.com')) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js']
      });
    } catch (err) {
      // Script might already be injected
    }
  }
});
