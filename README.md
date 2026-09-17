# Twitter Timeline Analyzer



https://github.com/user-attachments/assets/a778d076-4fe7-4c3e-82e8-6307ab0ae29f



A Chrome extension that uses AI to analyze and filter your Twitter/X timeline based on custom topics you define.

## Features

- **AI-Powered Topic Detection**: Define topics in natural language, and the extension generates regex patterns automatically
- **Real-time Tweet Classification**: Tweets are analyzed and tagged with matching topics as you scroll
- **Learning from Feedback**: Manually categorize tweets to improve pattern matching over time
- **Visual Actions**: Tag, highlight, or hide tweets based on topics
- **Multiple LLM Providers**: Works with any OpenAI-compatible API (Cerebras, Groq, OpenAI, Together AI, OpenRouter, etc.)
- **Jev Decision Engine (optional)**: Let [TypeSafe's Jev](https://typesafe.ai), a System One model, make the per-tweet yes/no calls. Your LLM writes each topic's criteria once; Jev judges every tweet against them in ~150-300 ms for about $0.00002 per tweet
- **Timeline Takeover Tracking**: Every topic shows how many tweets matched and what percent of the tweets you have seen it accounts for, so you can see how hard the For You algorithm is leaning on one subject
- **Weave Observability**: Optional [W&B Weave](https://docs.wandb.ai/weave/) integration for tracing LLM calls

## Installation


### Load as Unpacked Extension

1. **Download or clone this repository**
   ```bash
   git clone https://github.com/altryne/twitter-timeline-analyzer.git
   ```

2. **Open Chrome Extensions page**
   - Navigate to `chrome://extensions/` in your browser
   - Or go to Menu → More Tools → Extensions

3. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner

4. **Load the extension**
   - Click "Load unpacked"
   - Select the `twitter-timeline-analyzer` folder
   - The extension icon should appear in your toolbar

5. **Pin the extension** (optional)
   - Click the puzzle piece icon in the toolbar
   - Pin "Twitter Timeline Analyzer" for easy access

## Configuration

### Setting up an LLM Provider

The extension works with any **OpenAI-compatible API**. Here are some options:

| Provider | Base URL | Free Tier | Speed |
|----------|----------|-----------|-------|
| [Cerebras](https://cloud.cerebras.ai/) | `https://api.cerebras.ai/v1` | Yes | Very Fast |
| [Groq](https://console.groq.com/) | `https://api.groq.com/openai/v1` | Yes | Very Fast |
| [OpenAI](https://platform.openai.com/) | `https://api.openai.com/v1` | No | Fast |
| [Together AI](https://together.xyz/) | `https://api.together.xyz/v1` | Limited | Fast |
| [OpenRouter](https://openrouter.ai/) | `https://openrouter.ai/api/v1` | Limited | Varies |

#### Quick Setup
<img width="649" height="848" alt="image" src="https://github.com/user-attachments/assets/ce367827-663c-4043-ba0d-c8974cd473e9" />

1. Click the extension icon → **Settings** (or right-click → Options)
2. Select a provider preset (e.g., Cerebras, Groq)
3. Enter your API key
4. Click **Refresh** to load available models
5. Select a model and click **Save Settings**

#### Using a Custom OpenAI-Compatible API

If you're running a local LLM server (like Ollama, LM Studio, or vLLM) or using another provider:

1. Select the **Custom** preset
2. Enter your API base URL (e.g., `http://localhost:11434/v1` for Ollama)
3. Enter your API key (if required)
4. Click **Refresh** to fetch models, or enter a custom model name
5. Click **Save Settings**

**Requirements**: The API must support the `/chat/completions` endpoint in OpenAI format:

```bash
POST /chat/completions
{
  "model": "model-name",
  "messages": [{"role": "user", "content": "Hello"}],
  "max_tokens": 500
}
```

## Quick start with Jev (5 minutes)

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick this folder. After pulling new code, click **Reload** on the extension card. Open X tabs pick up the new version by themselves.
2. Click the toolbar icon. In Chrome it opens as a **side panel** that stays docked while you scroll; in browsers without side panels (Arc) it opens as the usual popup.
3. Gear icon → **Decision Engine: Jev** → tick *Let Jev decide which tweets match* → paste your TypeSafe key → **Test** → **Save Settings**.
4. (Recommended) In **LLM Configuration** pick a provider, paste its key, click **Refresh**, pick a model, click **Test**. Refresh only lists models and succeeds even with no credits; Test makes a real completion and tells you about problems like `HTTP 402` (out of credits). The LLM is only used to write a rule when you add a topic.
5. Back in the panel: switch **Analysis** on, type a topic in plain words (for example `Jev from typesafe` or `Personal AI assistants like Muse, Instinct and OpenClaw`), click **Add Topic**. New topics start with Tag and Highlight on.
6. Scroll your For You feed.

What you will see:

- Matching tweets get a colored tag with Jev's probability (`Jev 95%`) and a highlight. A tweet that matched shows only its tags.
- Tweets that matched nothing show a faint chip per topic (`🤖 3%`), so you can see the engine looked at them. Hover for the full readout. Switch the chips off in settings if you prefer a clean timeline.
- Each topic in the panel shows **N tweets · X% of seen** with a bar, and the stats card says which topic is taking over your feed (`AI is 42% of the 144 tweets you have seen`). **Reset** starts the count over.

### Live performance and the on-air comparison

The **Live performance** card at the top of the panel streams while you scroll: tweets per second, median ms per call, cost per 1,000 tweets, and a sparkline of recent call latencies. Numbers animate as calls land.

The **Jev | your-LLM** switch in that card changes the decision engine with one click. Everything on screen is re-judged by the other engine, and the two comparison rows fill in side by side on the same tweets, ending in a verdict line such as *Jev is 11x faster per tweet and 14x cheaper*. Flip back and forth as often as you like; each engine keeps its own numbers until you press Reset. LLM cost is estimated from list prices for common models.

### Teaching it a tweet it missed

Open a tweet's **···** menu or its **Share** menu and choose **Categorize for Timeline Analyzer**. Tick the topic(s), optionally say why in a sentence, and submit. Your LLM reads the tweet, your comment and the current rule, then rewrites the topic's Jev decision rule (and adds regex patterns). The tweet keeps your tag no matter what the engine says later, and everything on screen is re-judged with the sharper rule.

You can also edit a rule by hand: expand the topic in the panel, change **Jev decision rule**, click Save.

### If nothing is being tagged

- Is the **Analysis** switch on? Removing and re-adding the extension resets it to off.
- Did you press **Reload** on the extension after pulling new code?
- A red banner on the page (`Jev is not answering: ...`) names the failing engine and the error. `HTTP 402` means that account is out of credits.
- Brand-new names (a model called Jev, an app called Muse) are handled: every rule ends with "if the tweet names it directly, the answer is yes", because the model has never heard of them. If a topic still under-scores, make the topic text more specific or lower **Match threshold** in settings.

### Enabling Jev as the Decision Engine (Optional, Recommended)

Classifying every tweet with an LLM is slow and adds up. [Jev](https://docs.typesafe.ai/introduction) is a different kind of model: it cannot generate text, it only answers typed questions with calibrated probabilities. That is exactly the shape of this job.

How the work is split:

| Step | Who | When |
|------|-----|------|
| Write a topic's regex patterns, emoji, and a one-sentence decision rule ("The tweet is about ...") | Your LLM | Once, when you add a topic (and again when you give feedback) |
| Give a probability for every topic on every tweet | Jev | In bulk: 8 tweets per call, one probability (Noul) question per tweet per topic, several calls in flight |
| Second opinion | Jev | Only for tweets whose bulk score is uncertain (between 20% and 80%): that tweet is re-asked alone |
| Turn probabilities into tags, highlights and hides | Extension code | Every tweet, using your match threshold |

Setup:

1. Get an API key from [console.typesafe.ai](https://console.typesafe.ai/settings/keys)
2. In extension settings, open **Decision Engine: Jev**, tick **Let Jev decide which tweets match**, paste the key
3. Click **Test**: it makes one real decision and shows the model version and latency
4. Pick a **match threshold** (default 50%). Higher means fewer, surer tags
5. Leave **Jev decides every tweet (skip regex)** on unless you want regex to match first. Regex is instant but falls for keyword traps ("Apple pie", "Transformers 7") that Jev scores near 0%
6. Save

Notes:

- Topics you created before enabling Jev get their decision rule written by your LLM in the background the first time Jev is switched on. Until then Jev uses a default rule built from the topic description
- Expand a topic in the popup to read or edit its **Jev decision rule**. Hover a tag on a tweet to see Jev's probability
- Every decided tweet shows a chip per topic with Jev's probability (for example `🤖 97%  🏛 2%`), matched or not. Tags and highlights are that same signal passed through your threshold. Switch the chips off with **Show every topic's probability on every tweet**
- A sweeper looks for undecided tweets every 400 ms and on every scroll or timeline change, so tweets that fly past during a long scroll still get decided. Measured in Chrome: 120 tweets streamed through a fast virtualized scroll in under two seconds, all 144 on the page decided
- Why bulk plus second opinions: packing tweets into one call is about 3x faster and uses fewer tokens, but it pulls borderline probabilities toward the middle (69/72 correct on the labelled set at 8 per call). Re-asking only the uncertain ones restores 72/72 while keeping most of the speed. Reproduce with `scripts/test-jev-bulk.mjs`
- If Jev is unreachable, the extension falls back to your LLM for that tweet
- The manifest includes the `https://api.typesafe.ai/*` host permission. It is required: the API does not answer CORS preflights from extension origins, so calls go through the background service worker

Testing without Twitter:

```bash
# Live accuracy and speed check of lib/jev.js (needs TYPESAFE_API_KEY in an env file)
node --env-file=path/to/.env scripts/test-jev.mjs

# Bulk batch sizes vs accuracy, and the bulk + second opinion hybrid
node --env-file=path/to/.env scripts/test-jev-bulk.mjs

# Live performance card + engine switch against a fake 650 ms LLM
node --env-file=path/to/.env scripts/e2e-perf.mjs

# Full end-to-end run in Chrome for Testing against a mock timeline (see the header of the script)
node --env-file=path/to/.env scripts/e2e-jev.mjs
```

### Enabling Weave Observability (Optional)

[W&B Weave](https://docs.wandb.ai/weave/) provides tracing and observability for LLM calls, letting you debug prompts, track token usage, and analyze latency.

1. Get your API key from [wandb.ai/settings](https://wandb.ai/settings)
2. In extension settings, scroll to **Observability**
3. Enter your **W&B API Key**
4. Enter your **W&B Project** in `entity/project` format (e.g., `your-username/twitter-analyzer`)
5. Save settings

View traces at [wandb.ai](https://wandb.ai) → Your Project → Weave tab.

Learn more: [Weave Documentation](https://docs.wandb.ai/weave/)

## Usage

### Defining Topics

1. Go to Twitter/X
2. Click the extension icon to open the popup
3. Toggle "Analysis" ON
4. Add topics by describing them in natural language:
   - "AI and machine learning discussions"
   - "Cryptocurrency and Bitcoin news"
   - "Tech startup announcements"
5. The AI will generate regex patterns and suggest an emoji for each topic
6. Choose actions for each topic:
   - **Tag**: Add a colored pill label to matching tweets
   - **Highlight**: Highlight the entire tweet background
   - **Hide**: Hide matching tweets from your timeline

### How It Works

1. When you add a topic, the LLM generates regex patterns, an emoji, and a one-sentence decision rule
2. As you scroll, tweets are analyzed:
   - With Jev enabled: Jev judges every tweet against every topic's decision rule (8 tweets in parallel)
   - Without Jev: regex patterns are tested first (instant), and if nothing matches the LLM analyzes the tweet
3. Matching tweets are modified based on your action preferences
4. Results are cached for instant display when scrolling back

### Improving Detection with Feedback

If a tweet should match a topic but wasn't detected:

1. Click the feedback button on the tweet
2. Select which topic(s) it should belong to
3. Optionally add a comment explaining why
4. The AI will learn new patterns from your feedback

## Project Structure

```
twitter-timeline-analyzer/
├── manifest.json          # Extension manifest (MV3)
├── background/
│   └── background.js      # Service worker with LLM calls
├── content/
│   ├── content.js         # Tweet detection and UI injection
│   └── content.css        # Styles for timeline UI
├── popup/
│   ├── popup.html         # Extension popup
│   └── popup.js           # Popup logic
├── options/
│   ├── options.html       # Settings page
│   └── options.js         # Settings logic
├── lib/
│   └── weaveShim.js       # Browser-compatible Weave tracing
└── icons/                 # Extension icons
```

## Privacy

- All data is stored locally in your browser
- API keys are never shared except with the configured LLM provider
- Tweet content is sent to your LLM provider for analysis
- If Weave is enabled, prompts and responses are sent to W&B for tracing

## Troubleshooting

### Extension not working on Twitter/X

- Make sure you're on `twitter.com` or `x.com`
- Try refreshing the page
- Check that the extension is enabled in `chrome://extensions/`

### API errors

- Verify your API key is correct
- Check that the API base URL ends with `/v1` (not `/v1/`)
- Try clicking "Refresh" to test the connection
- Some providers require specific model names

### Weave traces not appearing

- Ensure both API Key and Project are set
- Project must be in `entity/project` format (e.g., `altryne/twitter-analyzer`)
- Check the browser console for errors (F12 → Console)

## License

MIT

## Links

- [W&B Weave Documentation](https://docs.wandb.ai/weave/)
- [Weave Tracing via REST API](https://docs.wandb.ai/weave/cookbooks/weave_via_service_api)
- [Chrome Extension Developer Guide](https://developer.chrome.com/docs/extensions/mv3/getstarted/)
