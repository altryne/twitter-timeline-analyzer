# Twitter Timeline Analyzer



https://github.com/user-attachments/assets/a778d076-4fe7-4c3e-82e8-6307ab0ae29f



A Chrome extension that uses AI to analyze and filter your Twitter/X timeline based on custom topics you define.

## Features

- **AI-Powered Topic Detection**: Define topics in natural language, and the extension generates regex patterns automatically
- **Real-time Tweet Classification**: Tweets are analyzed and tagged with matching topics as you scroll
- **Learning from Feedback**: Manually categorize tweets to improve pattern matching over time
- **Visual Actions**: Tag, highlight, or hide tweets based on topics
- **Multiple LLM Providers**: Works with any OpenAI-compatible API (Cerebras, Groq, OpenAI, Together AI, OpenRouter, etc.)
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

1. When you add a topic, the LLM generates regex patterns for fast matching
2. As you scroll, tweets are analyzed:
   - First, regex patterns are tested (instant)
   - If no regex match, the LLM analyzes the tweet content
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
