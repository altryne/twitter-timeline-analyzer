// Provider presets (fallback models if API fetch fails)
const PRESETS = {
  cerebras: {
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    fallbackModels: ['llama-3.3-70b', 'llama-3.1-8b'],
    info: 'Get your API key from <a href="https://cloud.cerebras.ai/" target="_blank">cloud.cerebras.ai</a>. Cerebras offers extremely fast inference.'
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    fallbackModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    info: 'Get your API key from <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>.'
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    fallbackModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    info: 'Get your API key from <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a>. Groq offers very fast inference with generous free tier.'
  },
  together: {
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    fallbackModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'],
    info: 'Get your API key from <a href="https://api.together.xyz/settings/api-keys" target="_blank">together.xyz</a>.'
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    fallbackModels: ['meta-llama/llama-3.3-70b-instruct', 'anthropic/claude-3-haiku', 'google/gemini-flash-1.5'],
    info: 'Get your API key from <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai</a>. Access multiple providers through one API.'
  },
  custom: {
    name: 'Custom',
    baseUrl: '',
    fallbackModels: [],
    info: 'Enter your custom OpenAI-compatible API endpoint. Click "Refresh" to fetch available models.'
  }
};

let currentPreset = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Load saved settings
  const settings = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'model', 'preset', 'wandbApiKey', 'wandbProject',
    'jevEnabled', 'jevApiKey', 'jevModel', 'jevThreshold', 'jevDecideAll', 'jevShowScores']);

  // Jev decision engine
  document.getElementById('jevEnabled').checked = Boolean(settings.jevEnabled);
  document.getElementById('jevApiKey').value = settings.jevApiKey || '';
  document.getElementById('jevModel').value = settings.jevModel || '';
  document.getElementById('jevThreshold').value = Number.isFinite(Number(settings.jevThreshold)) && settings.jevThreshold !== undefined
    ? settings.jevThreshold : 0.5;
  document.getElementById('jevDecideAll').checked = settings.jevDecideAll !== false;
  document.getElementById('jevShowScores').checked = settings.jevShowScores !== false;
  syncJevUi();

  document.getElementById('jevEnabled').addEventListener('change', syncJevUi);
  document.getElementById('jevThreshold').addEventListener('input', syncJevUi);
  document.getElementById('toggleJevPassword').addEventListener('click', () => {
    const input = document.getElementById('jevApiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('testJevBtn').addEventListener('click', testJev);

  if (settings.apiKey) {
    document.getElementById('apiKey').value = settings.apiKey;
  }
  if (settings.apiBaseUrl) {
    document.getElementById('apiBaseUrl').value = settings.apiBaseUrl;
  }
  if (settings.wandbApiKey) {
    document.getElementById('wandbApiKey').value = settings.wandbApiKey;
  }
  if (settings.wandbProject) {
    document.getElementById('wandbProject').value = settings.wandbProject;
  }
  if (settings.preset) {
    selectPreset(settings.preset, false);
  }
  if (settings.model) {
    // After models are loaded, try to select the saved model
    setTimeout(() => {
      const modelSelect = document.getElementById('model');
      if (modelSelect.querySelector(`option[value="${settings.model}"]`)) {
        modelSelect.value = settings.model;
      } else if (settings.model) {
        // Add custom option if not in list
        const option = document.createElement('option');
        option.value = settings.model;
        option.textContent = settings.model;
        modelSelect.appendChild(option);
        modelSelect.value = settings.model;
      }
    }, 0);
  }

  // Set up preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectPreset(btn.dataset.preset, true);
    });
  });

  // Toggle password visibility
  document.getElementById('togglePassword').addEventListener('click', () => {
    const input = document.getElementById('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Toggle W&B API key visibility
  document.getElementById('toggleWandbPassword').addEventListener('click', () => {
    const input = document.getElementById('wandbApiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Save button
  document.getElementById('saveBtn').addEventListener('click', saveSettings);

  // Refresh models button
  document.getElementById('refreshModelsBtn').addEventListener('click', refreshModels);

  // Allow custom model input when custom preset is selected
  document.getElementById('model').addEventListener('change', (e) => {
    if (e.target.value === '__custom__') {
      const customModel = prompt('Enter custom model name:');
      if (customModel) {
        const option = document.createElement('option');
        option.value = customModel;
        option.textContent = customModel;
        e.target.appendChild(option);
        e.target.value = customModel;
      }
    }
  });
});

function selectPreset(presetKey, updateUrl) {
  const preset = PRESETS[presetKey];
  if (!preset) return;

  currentPreset = presetKey;

  // Update active button
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === presetKey);
  });

  // Update URL if requested
  if (updateUrl) {
    document.getElementById('apiBaseUrl').value = preset.baseUrl;
  }

  // Show placeholder in model dropdown - user should click refresh
  const modelSelect = document.getElementById('model');
  modelSelect.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Click "Refresh" to load models...';
  modelSelect.appendChild(placeholder);

  // Add fallback models as options (in case refresh fails)
  if (preset.fallbackModels && preset.fallbackModels.length > 0) {
    const divider = document.createElement('option');
    divider.disabled = true;
    divider.textContent = '── Fallback models ──';
    modelSelect.appendChild(divider);

    preset.fallbackModels.forEach(model => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      modelSelect.appendChild(option);
    });
  }

  // Always allow custom model entry
  const customOption = document.createElement('option');
  customOption.value = '__custom__';
  customOption.textContent = '+ Enter custom model...';
  modelSelect.appendChild(customOption);

  // Update info box
  document.getElementById('providerInfo').innerHTML = preset.info;
}

// Fetch models from the API's /models endpoint
async function refreshModels() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const apiBaseUrl = document.getElementById('apiBaseUrl').value.trim();

  if (!apiKey) {
    showStatus('Please enter an API key first', 'error');
    return;
  }

  if (!apiBaseUrl) {
    showStatus('Please enter an API base URL first', 'error');
    return;
  }

  const btn = document.getElementById('refreshModelsBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Loading...';

  try {
    const response = await fetch(`${apiBaseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    let models = [];

    // Handle different API response formats
    if (data.data && Array.isArray(data.data)) {
      // OpenAI format: { data: [{ id: "model-name", ... }] }
      models = data.data.map(m => ({
        id: m.id,
        name: m.id,
        owned_by: m.owned_by || ''
      }));
    } else if (Array.isArray(data)) {
      // Simple array format
      models = data.map(m => ({
        id: typeof m === 'string' ? m : m.id,
        name: typeof m === 'string' ? m : (m.name || m.id),
        owned_by: m.owned_by || ''
      }));
    } else if (data.models && Array.isArray(data.models)) {
      // Alternative format: { models: [...] }
      models = data.models.map(m => ({
        id: typeof m === 'string' ? m : m.id,
        name: typeof m === 'string' ? m : (m.name || m.id),
        owned_by: m.owned_by || ''
      }));
    }

    if (models.length === 0) {
      throw new Error('No models found in API response');
    }

    // Sort models alphabetically
    models.sort((a, b) => a.id.localeCompare(b.id));

    // Update dropdown
    const modelSelect = document.getElementById('model');
    const currentValue = modelSelect.value;
    modelSelect.innerHTML = '';

    // Group by owner if available
    const grouped = {};
    models.forEach(m => {
      const group = m.owned_by || 'Models';
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(m);
    });

    // If only one group, don't use optgroups
    const groupKeys = Object.keys(grouped);
    if (groupKeys.length === 1 || groupKeys.every(k => k === 'Models' || k === '')) {
      models.forEach(m => {
        const option = document.createElement('option');
        option.value = m.id;
        option.textContent = m.name;
        modelSelect.appendChild(option);
      });
    } else {
      // Use optgroups for organization
      groupKeys.sort().forEach(group => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group;
        grouped[group].forEach(m => {
          const option = document.createElement('option');
          option.value = m.id;
          option.textContent = m.name;
          optgroup.appendChild(option);
        });
        modelSelect.appendChild(optgroup);
      });
    }

    // Add custom option at the end
    const customOption = document.createElement('option');
    customOption.value = '__custom__';
    customOption.textContent = '+ Enter custom model...';
    modelSelect.appendChild(customOption);

    // Restore previous selection if it exists
    if (currentValue && modelSelect.querySelector(`option[value="${currentValue}"]`)) {
      modelSelect.value = currentValue;
    }

    showStatus(`Loaded ${models.length} models`, 'success');
  } catch (err) {
    console.error('Failed to fetch models:', err);
    showStatus(`Failed to fetch models: ${err.message}`, 'error');
  }

  btn.disabled = false;
  btn.textContent = originalText;
}

function syncJevUi() {
  const enabled = document.getElementById('jevEnabled').checked;
  document.getElementById('jevFields').classList.toggle('disabled', !enabled);
  const threshold = Number(document.getElementById('jevThreshold').value);
  document.getElementById('jevThresholdValue').textContent = `${Math.round(threshold * 100)}%`;
}

function readJevSettings() {
  return {
    jevEnabled: document.getElementById('jevEnabled').checked,
    jevApiKey: document.getElementById('jevApiKey').value.trim(),
    jevModel: document.getElementById('jevModel').value.trim() || 'jev-latest',
    jevThreshold: Number(document.getElementById('jevThreshold').value),
    jevDecideAll: document.getElementById('jevDecideAll').checked,
    jevShowScores: document.getElementById('jevShowScores').checked
  };
}

// One real Jev decision, so the key, the model name and the latency are all verified
async function testJev() {
  const out = document.getElementById('jevTestResult');
  const btn = document.getElementById('testJevBtn');
  const { jevApiKey, jevModel } = readJevSettings();
  if (!jevApiKey) {
    out.className = 'jev-test-result error';
    out.textContent = 'Enter a TypeSafe API key first';
    return false;
  }
  btn.disabled = true;
  out.className = 'jev-test-result';
  out.textContent = 'Asking Jev...';
  try {
    const { testConnection } = await import('../lib/jev.js');
    const result = await testConnection({ apiKey: jevApiKey, model: jevModel });
    out.className = 'jev-test-result ok';
    out.textContent = `Connected to ${result.model}: decided in ${result.latencyMs} ms (test tweet scored ${Math.round(result.score * 100)}% for "AI")`;
    return true;
  } catch (err) {
    out.className = 'jev-test-result error';
    out.textContent = `Jev test failed: ${err.message}`;
    return false;
  } finally {
    btn.disabled = false;
  }
}

async function saveSettings() {
  // Jev settings save on their own, so a flaky LLM provider cannot block them
  const jev = readJevSettings();
  if (jev.jevEnabled) {
    const ok = await testJev();
    if (!ok) {
      showStatus('Jev is enabled but the connection test failed. Fix the key or switch Jev off.', 'error');
      return;
    }
  }
  await chrome.storage.local.set(jev);

  const apiKey = document.getElementById('apiKey').value.trim();
  const apiBaseUrl = document.getElementById('apiBaseUrl').value.trim();
  const model = document.getElementById('model').value;
  const wandbApiKey = document.getElementById('wandbApiKey').value.trim();
  const wandbProject = document.getElementById('wandbProject').value.trim();

  if (!apiKey) {
    showStatus('Please enter an API key', 'error');
    return;
  }

  if (!apiBaseUrl) {
    showStatus('Please enter an API base URL', 'error');
    return;
  }

  if (!model) {
    showStatus('Please select a model', 'error');
    return;
  }

  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Testing connection...';

  // Test the API connection
  try {
    const response = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 5
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `HTTP ${response.status}`);
    }

    // Save settings
    await chrome.storage.local.set({
      apiKey,
      apiBaseUrl,
      model,
      preset: currentPreset,
      wandbApiKey,
      wandbProject
    });

    showStatus('Settings saved successfully!', 'success');
  } catch (err) {
    // Say which connection failed: Jev settings were already saved above
    const hint = /402/.test(err.message) ? ' (the provider says payment required: out of credits?)' : '';
    const prefix = jev.jevEnabled ? 'Jev settings saved and working. ' : '';
    showStatus(`${prefix}LLM connection failed: ${err.message}${hint}. The LLM is only needed to write rules for new topics.`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Save Settings';
}

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;

  if (type === 'success') {
    setTimeout(() => {
      status.className = 'status';
    }, 3000);
  }
}
