// Background service worker for Twitter Timeline Analyzer
import * as weave from '../lib/weaveShim.js';

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
});

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    analyzeTweet(message.tweetText, message.criteria)
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('Tweet analysis error:', err);
        sendResponse({ matches: [], error: err.message });
      });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'model'])
      .then(settings => sendResponse(settings));
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

Rules for patterns:
- Generate patterns that are case-insensitive (will be used with /i flag)
- Focus on keywords, phrases, and common variations
- Include word boundaries where appropriate (\\b)
- Avoid overly broad patterns that would match too much
- Include common hashtags related to the topic

Rules for emoji:
- Choose ONE emoji that best visually represents the topic
- Be specific - for "AI" use 🤖, for "politics" use 🏛️, for "sports" use ⚽, etc.

Return ONLY a JSON object with this exact structure, nothing else:
{
  "patterns": ["pattern1", "pattern2", ...],
  "emoji": "🎯"
}

Example input: "AI and machine learning discussions"
Example output: {"patterns": ["\\\\bAI\\\\b", "\\\\bartificial intelligence\\\\b", "\\\\bmachine learning\\\\b", "\\\\bML\\\\b", "\\\\bdeep learning\\\\b", "#MachineLearning", "#AI\\\\b", "\\\\bGPT", "\\\\bLLM\\\\b"], "emoji": "🤖"}`;

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

      const output = { patterns, emoji };
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

// Analyze a tweet against criteria using LLM
async function analyzeTweet(tweetText, criteria) {
  const settings = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'model']);

  if (!settings.apiKey || !settings.apiBaseUrl || !settings.model) {
    return { matches: [], error: 'API not configured' };
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

  try {
    const response = await callLLM(settings, systemPrompt, `Classify this tweet:\n"${tweetText}"`, traceContext);

    const cleaned = response.trim().replace(/```json\n?|\n?```/g, '');
    const matches = JSON.parse(cleaned);

    if (Array.isArray(matches)) {
      // Validate that returned IDs exist in criteria
      const validIds = new Set(criteria.map(c => c.id));
      const validMatches = matches.filter(id => validIds.has(id));
      const output = { matches: validMatches };
      await weave.endTrace(traceContext, output);
      return output;
    }
  } catch (err) {
    console.error('Failed to parse analysis:', err);
    await weave.endTrace(traceContext, { error: err.message });
  }

  await weave.endTrace(traceContext, { matches: [] });
  return { matches: [] };
}

// Generic LLM API call with Weave tracing
async function callLLM(settings, systemPrompt, userMessage, parentContext = null) {
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
  const result = await weave.traceLLMCall(settings.model, messages, makeCall, parentContext);
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

Return ONLY a JSON object with this structure:
{
  "analysis": "Brief explanation of why existing patterns missed this",
  "newPatterns": ["pattern1", "pattern2", ...]
}`;

    const userMessage = `Tweet that should match "${topic.description}":\n"${tweetText}"`;

    try {
      const response = await callLLM(settings, systemPrompt, userMessage, traceContext);
      const cleaned = response.trim().replace(/```json\n?|\n?```/g, '');
      const result = JSON.parse(cleaned);

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
  if (updatedCriteria.length > 0) {
    await chrome.storage.local.set({ criteria });
  }

  const result = {
    success: true,
    updatedCriteria,
    message: `Learned ${updatedCriteria.reduce((sum, c) => sum + (c.newPatternsCount || 0), 0)} new patterns`
  };

  await weave.endTrace(traceContext, result);
  return result;
}

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
