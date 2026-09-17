// Jev (TypeSafe System One) decision client.
// The LLM writes the criteria once; Jev makes the per-tweet yes/no decisions.
// Pure ES module: works in the MV3 service worker and in Node (scripts/test-jev.mjs).

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_DEFAULT_THRESHOLD = 0.5;

// Instruction used when a topic has no LLM-written jevInstruction yet.
export function defaultInstruction(description) {
  return `The tweet is clearly about this topic: ${description}`;
}

// One Noul (yes/no probability) question per topic. Noul, not Choice, because a
// tweet can belong to several topics at once and each topic is judged independently.
// Question names are positional (t0, t1, ...) so arbitrary topic ids never reach the API.
export function buildQuestions(criteria) {
  const questions = {};
  const keyToId = {};
  criteria.forEach((c, i) => {
    const key = `t${i}`;
    keyToId[key] = c.id;
    questions[key] = {
      type: 'noul',
      instructions: (c.jevInstruction && c.jevInstruction.trim()) || defaultInstruction(c.description)
    };
  });
  return { questions, keyToId };
}

function buildState(tweetText, author) {
  const tweet = { text: tweetText };
  if (author) tweet.author = author;
  return { tweet };
}

async function postOnce({ apiKey, body, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const err = new Error(errBody.error?.message || errBody.message || `HTTP ${response.status}`);
      err.status = response.status;
      err.retryAfter = Number(response.headers.get('retry-after')) || 0;
      throw err;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Decide which topics a tweet matches.
// Returns { matches: [topicId], scores: { topicId: probability }, latencyMs, usage, model }.
export async function decideTweet({
  apiKey,
  model = JEV_DEFAULT_MODEL,
  tweetText,
  author = '',
  criteria,
  threshold = JEV_DEFAULT_THRESHOLD,
  timeoutMs = 4000,
  maxRetries = 2,
  fetchImpl = fetch
}) {
  if (!apiKey) throw new Error('Jev API key not configured');
  if (!criteria || criteria.length === 0) return { matches: [], scores: {}, latencyMs: 0 };

  const { questions, keyToId } = buildQuestions(criteria);
  const body = { state: buildState(tweetText, author), model, questions };

  const started = Date.now();
  let data;
  let attempt = 0;
  // Retry on rate limits, server errors and timeouts only.
  for (;;) {
    try {
      data = await postOnce({ apiKey, body, timeoutMs, fetchImpl });
      break;
    } catch (err) {
      const retryable = err.name === 'AbortError' || err.status === 429 || (err.status >= 500 && err.status < 600);
      if (!retryable || attempt >= maxRetries) throw err;
      attempt++;
      const waitMs = err.retryAfter ? err.retryAfter * 1000 : 150 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  const scores = {};
  const matches = [];
  for (const [key, id] of Object.entries(keyToId)) {
    const p = Number(data.answers?.[key]?.noul);
    if (Number.isFinite(p)) {
      scores[id] = p;
      if (p >= threshold) matches.push(id);
    }
  }

  return {
    matches,
    scores,
    latencyMs: Date.now() - started,
    usage: data.usage || null,
    model: data.model || model
  };
}

// Cheap connectivity check for the options page.
export async function testConnection({ apiKey, model = JEV_DEFAULT_MODEL, fetchImpl = fetch }) {
  const result = await decideTweet({
    apiKey,
    model,
    tweetText: 'OpenAI just released a new reasoning model with open weights.',
    criteria: [{ id: 'ai', description: 'AI and machine learning' }],
    fetchImpl
  });
  return { ok: true, latencyMs: result.latencyMs, model: result.model, score: result.scores.ai };
}
