// Jev (TypeSafe System One) decision client.
// The LLM writes the criteria once; Jev makes the per-tweet yes/no decisions.
// Pure ES module: works in the MV3 service worker and in Node (scripts/test-jev.mjs).

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_DEFAULT_THRESHOLD = 0.5;

// Jev has never heard of brand-new names (a model called "Jev", an app called "Muse"). Measured on
// real tweets: without this clause, tweets that only say the name score 38-55%; with it 60-97%,
// while unrelated tweets stay under 10%. So every rule gets it, LLM-written or not.
const NAME_CLAUSE = 'If the tweet names it directly, in any capitalization, the answer is yes.';

// Instruction used when a topic has no LLM-written jevInstruction yet: whatever the user typed
// as the topic has to work on its own.
export function defaultInstruction(description) {
  return `The tweet mentions or discusses: ${description}.`;
}

// The full instruction Jev judges against for one topic
export function instructionFor(c) {
  const rule = (c.jevInstruction && c.jevInstruction.trim()) || defaultInstruction(c.description);
  return rule.includes(NAME_CLAUSE) ? rule : `${rule.replace(/\s+$/, '')} ${NAME_CLAUSE}`;
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
      instructions: instructionFor(c)
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

// Bulk decisions: many tweets in ONE call. The state holds every tweet under a short key and
// there is one Noul question per (tweet, topic), so a batch of 10 tweets x 3 topics is a single
// request with 30 probability questions. Jev answers all questions in parallel, which makes this
// far cheaper and faster than one request per tweet.
// tweets: [{ id, text, author }]. Returns { results: { tweetId: { scores, matches } }, latencyMs, usage, model }.
export async function decideTweets({
  apiKey,
  model = JEV_DEFAULT_MODEL,
  tweets,
  criteria,
  threshold = JEV_DEFAULT_THRESHOLD,
  timeoutMs = 6000,
  maxRetries = 2,
  fetchImpl = fetch
}) {
  if (!apiKey) throw new Error('Jev API key not configured');
  if (!tweets?.length || !criteria?.length) return { results: {}, latencyMs: 0 };

  const state = { tweets: {} };
  const questions = {};
  const keyMap = {}; // question name -> [tweetId, topicId]
  tweets.forEach((t, ti) => {
    const tKey = `tweet_${ti + 1}`;
    state.tweets[tKey] = t.author ? { author: t.author, text: t.text } : { text: t.text };
    criteria.forEach((c, ci) => {
      const rule = instructionFor(c);
      const qName = `${tKey}__topic_${ci + 1}`;
      keyMap[qName] = [t.id, c.id];
      questions[qName] = {
        type: 'noul',
        instructions: `Judge ONLY ${tKey} and ignore every other tweet in the state. ${rule}`
      };
    });
  });

  const body = { state, model, questions };
  const started = Date.now();
  let data;
  let attempt = 0;
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

  const results = {};
  tweets.forEach(t => { results[t.id] = { scores: {}, matches: [] }; });
  for (const [qName, [tweetId, topicId]] of Object.entries(keyMap)) {
    const p = Number(data.answers?.[qName]?.noul);
    if (!Number.isFinite(p)) continue;
    results[tweetId].scores[topicId] = p;
    if (p >= threshold) results[tweetId].matches.push(topicId);
  }

  return { results, latencyMs: Date.now() - started, usage: data.usage || null, model: data.model || model };
}

// Bulk first, then a second opinion only where it matters (confidence-gated routing).
// Packing tweets into one call squashes probabilities toward the middle, so a score inside the
// uncertain band is re-asked for that tweet alone, where Jev is at its most accurate. Clear
// yes/no tweets (the vast majority of a timeline) never cost a second call.
export const JEV_UNCERTAIN_BAND = [0.2, 0.8];

export async function decideTweetsHybrid({
  apiKey,
  model = JEV_DEFAULT_MODEL,
  tweets,
  criteria,
  threshold = JEV_DEFAULT_THRESHOLD,
  band = JEV_UNCERTAIN_BAND,
  fetchImpl = fetch
}) {
  const bulk = await decideTweets({ apiKey, model, tweets, criteria, threshold, fetchImpl });
  const [lo, hi] = band;

  const uncertain = tweets.filter(t => {
    const scores = bulk.results[t.id]?.scores || {};
    return criteria.some(c => !Number.isFinite(scores[c.id]) || (scores[c.id] > lo && scores[c.id] < hi));
  });

  let refinedCount = 0;
  let usage = bulk.usage ? { ...bulk.usage } : null;
  await Promise.all(uncertain.map(async t => {
    try {
      const single = await decideTweet({ apiKey, model, tweetText: t.text, author: t.author, criteria, threshold, fetchImpl });
      bulk.results[t.id] = { scores: single.scores, matches: single.matches, refined: true };
      refinedCount++;
      if (usage && single.usage) usage.input_tokens = (usage.input_tokens || 0) + (single.usage.input_tokens || 0);
    } catch {
      // Keep the bulk answer for this tweet: a slightly fuzzier decision beats none
    }
  }));

  return { ...bulk, usage, refinedCount, latencyMs: undefined, bulkLatencyMs: bulk.latencyMs };
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
