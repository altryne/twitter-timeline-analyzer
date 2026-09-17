// Popup state
let criteria = [];
let isActive = false;
let currentTabId = null;
let stats = { analyzed: 0, tagged: 0, hidden: 0, byTopic: {} };

// Current topic customization state
let selectedEmoji = '🏷️';
let selectedColor = '#1d9bf0';

// Color presets
const COLOR_PRESETS = [
  '#1d9bf0', '#00ba7c', '#f91880', '#ffd400',
  '#7856ff', '#ff7a00', '#00d4ff', '#94d82d'
];

// Common emoji options for topics
const EMOJI_OPTIONS = [
  '🏷️', '📌', '⭐', '🔥', '💡', '🎯',
  '🗞️', '📰', '🤖', '🧠', '💻', '🎮',
  '💰', '📈', '🏛️', '⚖️', '🌍', '🌱',
  '🎨', '🎬', '🎵', '📚', '🔬', '🏆',
  '❤️', '😂', '🤔', '😡', '🚀', '✨',
  '⚠️', '🚫', '✅', '❌', '🔴', '🟢'
];

// Generate unique ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Check if we're on Twitter
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;

  const isTwitter = tab?.url?.includes('twitter.com') || tab?.url?.includes('x.com');

  if (!isTwitter) {
    document.getElementById('notOnTwitter').style.display = 'block';
    document.getElementById('mainContent').style.display = 'none';
    return;
  }

  // Load saved state
  await loadState();

  // Check API configuration
  const settings = await chrome.storage.local.get(['apiKey', 'apiBaseUrl', 'model', 'jevEnabled', 'jevApiKey']);
  if (!settings.apiKey) {
    const warning = document.getElementById('apiWarning');
    warning.style.display = 'block';
    // With Jev on, tweets still get decided; the LLM is only missing for writing topic criteria
    if (settings.jevEnabled && settings.jevApiKey) {
      const link = warning.querySelector('a');
      warning.textContent = 'Jev is deciding tweets. Add an LLM key so new topics get a written decision rule. ';
      if (link) warning.appendChild(link);
    }
  }

  // Set up event listeners
  setupEventListeners();

  // Initialize customizer
  initializeCustomizer();

  // Render criteria list
  renderCriteria();

  // Update stats display
  updateStatsDisplay();

  // Set toggle state
  document.getElementById('analysisToggle').checked = isActive;
});

async function loadState() {
  const data = await chrome.storage.local.get(['criteria', 'isActive', 'stats']);
  criteria = data.criteria || [];
  isActive = data.isActive || false;
  stats = data.stats || { analyzed: 0, tagged: 0, hidden: 0 };
  if (!stats.byTopic) stats.byTopic = {};
}

async function saveState() {
  await chrome.storage.local.set({ criteria, isActive, stats });
}

function initializeCustomizer() {
  // Populate color presets
  const colorPresets = document.getElementById('colorPresets');
  colorPresets.innerHTML = COLOR_PRESETS.map(color =>
    `<button type="button" class="color-preset" data-color="${color}" style="background: ${color}"></button>`
  ).join('');

  // Set initial values
  document.getElementById('newTopicEmoji').value = selectedEmoji;
  document.getElementById('newTopicColor').value = selectedColor;
  updatePreview();
}

function setupEventListeners() {
  // Settings button
  document.getElementById('settingsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Open settings link
  document.getElementById('openSettings')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Analysis toggle
  document.getElementById('analysisToggle').addEventListener('change', async (e) => {
    isActive = e.target.checked;
    await saveState();

    // Notify content script
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, {
        type: 'TOGGLE_ANALYSIS',
        isActive
      }).catch(() => {
        injectContentScript();
      });
    }
  });

  // Show customizer when typing
  const criteriaInput = document.getElementById('criteriaInput');
  criteriaInput.addEventListener('input', (e) => {
    const customizer = document.getElementById('topicCustomizer');
    if (e.target.value.trim().length > 0) {
      customizer.style.display = 'block';
      updatePreview();
    } else {
      customizer.style.display = 'none';
    }
  });

  // Add criteria button
  document.getElementById('addCriteriaBtn').addEventListener('click', addCriteria);

  // Enter key in textarea (Cmd+Enter)
  criteriaInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.metaKey) {
      addCriteria();
    }
  });

  // Emoji input change
  document.getElementById('newTopicEmoji').addEventListener('input', (e) => {
    // Take only the last character if multiple are pasted (to get emoji)
    const value = e.target.value;
    if (value.length > 4) {
      e.target.value = value.slice(-4);
    }
    selectedEmoji = e.target.value || '🏷️';
    updatePreview();
  });

  // Color picker change
  document.getElementById('newTopicColor').addEventListener('input', (e) => {
    selectedColor = e.target.value;
    updateColorPresetSelection();
    updatePreview();
  });

  // Color preset click
  document.getElementById('colorPresets').addEventListener('click', (e) => {
    if (e.target.classList.contains('color-preset')) {
      selectedColor = e.target.dataset.color;
      document.getElementById('newTopicColor').value = selectedColor;
      updateColorPresetSelection();
      updatePreview();
    }
  });
}

function updateColorPresetSelection() {
  document.querySelectorAll('.color-preset').forEach(preset => {
    preset.classList.toggle('active', preset.dataset.color === selectedColor);
  });
}

function updatePreview() {
  const input = document.getElementById('criteriaInput');
  const preview = document.getElementById('tagPreview');
  const description = input.value.trim() || 'Topic name';
  const displayText = truncateText(description, 20);
  const emoji = document.getElementById('newTopicEmoji')?.value || selectedEmoji;

  preview.textContent = `${emoji} ${displayText}`;
  preview.style.backgroundColor = selectedColor;
}

async function injectContentScript() {
  if (!currentTabId) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      files: ['content/content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId: currentTabId },
      files: ['content/content.css']
    });
  } catch (err) {
    console.error('Failed to inject content script:', err);
  }
}

async function addCriteria() {
  const input = document.getElementById('criteriaInput');
  const description = input.value.trim();

  if (!description) return;

  const btn = document.getElementById('addCriteriaBtn');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  // Get emoji from input
  const emojiInput = document.getElementById('newTopicEmoji');
  const currentEmoji = emojiInput?.value || selectedEmoji || '🏷️';

  const newCriteria = {
    id: generateId(),
    description,
    emoji: currentEmoji,
    color: selectedColor,
    regexPatterns: [],
    actions: {
      tag: true,
      highlight: false,
      hide: false
    },
    generating: true
  };

  criteria.push(newCriteria);
  await saveState();
  renderCriteria();

  // Reset input and customizer
  input.value = '';
  document.getElementById('topicCustomizer').style.display = 'none';

  // Request regex patterns AND emoji suggestion from background script
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GENERATE_PATTERNS',
      criteriaId: newCriteria.id,
      description
    });

    const idx = criteria.findIndex(c => c.id === newCriteria.id);
    if (idx !== -1) {
      if (response?.patterns) {
        // Save patterns in object format with isLearned: false for originals
        criteria[idx].regexPatterns = response.patterns.map(p => ({
          pattern: p,
          isLearned: false
        }));
      }
      // The LLM's one-sentence decision rule: this is what Jev judges every tweet against
      if (response?.jevInstruction) {
        criteria[idx].jevInstruction = response.jevInstruction;
      }
      // Use LLM-suggested emoji if available and user hadn't changed from default
      if (response?.emoji && currentEmoji === '🏷️') {
        criteria[idx].emoji = response.emoji;
      }
      criteria[idx].generating = false;
      await saveState();
      renderCriteria();
      notifyContentScript();
    }
  } catch (err) {
    console.error('Failed to generate patterns:', err);
    const idx = criteria.findIndex(c => c.id === newCriteria.id);
    if (idx !== -1) {
      criteria[idx].generating = false;
      await saveState();
      renderCriteria();
    }
  }

  // Reset customizer for next topic
  selectedEmoji = '🏷️';
  selectedColor = COLOR_PRESETS[Math.floor(Math.random() * COLOR_PRESETS.length)];
  document.getElementById('newTopicEmoji').value = selectedEmoji;
  document.getElementById('newTopicColor').value = selectedColor;
  updateColorPresetSelection();

  btn.disabled = false;
  btn.textContent = 'Add Topic';
}

// Track which criteria are expanded
let expandedCriteria = new Set();

function renderCriteria() {
  const list = document.getElementById('criteriaList');

  if (criteria.length === 0) {
    list.innerHTML = '<p style="color: #6e767d; font-size: 13px; text-align: center; padding: 20px;">No topics added yet</p>';
    return;
  }

  list.innerHTML = criteria.map(c => {
    const isExpanded = expandedCriteria.has(c.id);
    const patterns = c.regexPatterns || [];
    const originalPatterns = patterns.filter(p => !p.isLearned);
    const learnedPatterns = patterns.filter(p => p.isLearned);

    // Handle both old format (string array) and new format (object array)
    const normalizePattern = (p) => typeof p === 'string' ? { pattern: p, isLearned: false } : p;
    const allPatterns = patterns.map(normalizePattern);
    const originals = allPatterns.filter(p => !p.isLearned);
    const learned = allPatterns.filter(p => p.isLearned);

    return `
    <div class="criteria-item ${c.generating ? 'generating' : ''} ${isExpanded ? 'expanded' : ''}" style="--topic-color: ${c.color}" data-id="${c.id}">
      <div class="criteria-header" data-id="${c.id}">
        <span class="criteria-name">
          <span class="criteria-expand-icon">▶</span>
          <span class="criteria-emoji">${c.emoji || '🏷️'}</span>
          ${escapeHtml(truncateText(c.description, 30))}
        </span>
        <button class="criteria-delete" data-id="${c.id}">&times;</button>
      </div>
      <div class="criteria-share" data-share-id="${c.id}" title="Share of the tweets you have scrolled past that match this topic">
        <div class="share-bar"><div class="share-fill" style="width: ${topicShare(c.id).pct}%"></div></div>
        <span class="share-text">${shareLabel(c.id)}</span>
      </div>
      <div class="criteria-actions">
        <button class="action-toggle ${c.actions.tag ? 'active' : ''}" data-action="tag" data-id="${c.id}" style="--toggle-color: ${c.color}">
          Tag
        </button>
        <button class="action-toggle ${c.actions.highlight ? 'active' : ''}" data-action="highlight" data-id="${c.id}" style="--toggle-color: ${c.color}">
          Highlight
        </button>
        <button class="action-toggle ${c.actions.hide ? 'active' : ''}" data-action="hide" data-id="${c.id}" style="--toggle-color: #f4212e">
          Hide
        </button>
      </div>

      <div class="criteria-expanded">
        <div class="criteria-edit-row">
          <div class="criteria-edit-field">
            <label>Emoji</label>
            <input type="text" class="emoji-input criteria-emoji-input" data-id="${c.id}" value="${c.emoji || '🏷️'}" maxlength="4">
          </div>
          <div class="criteria-edit-field">
            <label>Color</label>
            <input type="color" class="criteria-color-input" data-id="${c.id}" value="${c.color || '#1d9bf0'}">
          </div>
          <button class="criteria-save-btn" data-id="${c.id}">Save</button>
        </div>

        <div class="criteria-edit-field criteria-jev-field">
          <label>Jev decision rule <span class="jev-hint">written by the LLM, judged by Jev on every tweet. Edit and Save to sharpen it.</span></label>
          <textarea class="criteria-jev-input" data-id="${c.id}" rows="3" placeholder="The tweet is about ...">${escapeHtml(c.jevInstruction || '')}</textarea>
        </div>

        <div class="rules-section">
          <h4>Original Rules <span class="rule-count">${originals.length}</span></h4>
          ${originals.length > 0 ? `
            <div class="rules-list">
              ${originals.map((p, idx) => `
                <div class="rule-item" data-id="${c.id}" data-pattern-idx="${idx}" data-learned="false">
                  <span class="rule-pattern" title="${escapeHtml(p.pattern)}">${escapeHtml(p.pattern)}</span>
                  <span class="rule-badge original">Original</span>
                  <button class="rule-delete" data-id="${c.id}" data-pattern="${escapeHtml(p.pattern)}" data-learned="false">&times;</button>
                </div>
              `).join('')}
            </div>
          ` : '<p class="no-rules">No original rules</p>'}
        </div>

        <div class="rules-section">
          <h4>Learned Rules <span class="rule-count">${learned.length}</span></h4>
          ${learned.length > 0 ? `
            <div class="rules-list">
              ${learned.map((p, idx) => `
                <div class="rule-item learned" data-id="${c.id}" data-pattern-idx="${idx}" data-learned="true">
                  <span class="rule-pattern" title="${escapeHtml(p.pattern)}">${escapeHtml(p.pattern)}</span>
                  <span class="rule-badge learned">Learned</span>
                  <button class="rule-delete" data-id="${c.id}" data-pattern="${escapeHtml(p.pattern)}" data-learned="true">&times;</button>
                </div>
              `).join('')}
            </div>
          ` : '<p class="no-rules">No learned rules yet</p>'}
        </div>
      </div>
    </div>
  `}).join('');

  // Add event listeners for expand/collapse
  list.querySelectorAll('.criteria-header').forEach(header => {
    header.addEventListener('click', (e) => {
      // Don't toggle if clicking delete button
      if (e.target.classList.contains('criteria-delete')) return;
      toggleExpand(header.dataset.id);
    });
  });

  // Add event listeners for delete topic
  list.querySelectorAll('.criteria-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCriteria(btn.dataset.id);
    });
  });

  // Add event listeners for action toggles
  list.querySelectorAll('.action-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAction(btn.dataset.id, btn.dataset.action);
    });
  });

  // Add event listeners for save buttons
  list.querySelectorAll('.criteria-save-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveCriteriaEdit(btn.dataset.id);
    });
  });

  // Add event listeners for rule delete
  list.querySelectorAll('.rule-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteRule(btn.dataset.id, btn.dataset.pattern, btn.dataset.learned === 'true');
    });
  });
}

function toggleExpand(id) {
  if (expandedCriteria.has(id)) {
    expandedCriteria.delete(id);
  } else {
    expandedCriteria.add(id);
  }
  renderCriteria();
}

async function saveCriteriaEdit(id) {
  const idx = criteria.findIndex(c => c.id === id);
  if (idx === -1) return;

  const item = document.querySelector(`.criteria-item[data-id="${id}"]`);
  const newEmoji = item.querySelector('.criteria-emoji-input').value || '🏷️';
  const newColor = item.querySelector('.criteria-color-input').value;

  criteria[idx].emoji = newEmoji;
  criteria[idx].color = newColor;

  const jevInput = item.querySelector('.criteria-jev-input');
  if (jevInput) {
    const rule = jevInput.value.trim();
    if (rule) criteria[idx].jevInstruction = rule;
    else delete criteria[idx].jevInstruction;
  }

  await saveState();
  renderCriteria();
  notifyContentScript();
}

async function deleteRule(criteriaId, pattern, isLearned) {
  const idx = criteria.findIndex(c => c.id === criteriaId);
  if (idx === -1) return;

  // Normalize patterns to object format if needed
  criteria[idx].regexPatterns = criteria[idx].regexPatterns
    .map(p => typeof p === 'string' ? { pattern: p, isLearned: false } : p)
    .filter(p => p.pattern !== pattern);

  await saveState();
  renderCriteria();
  notifyContentScript();
}

async function deleteCriteria(id) {
  criteria = criteria.filter(c => c.id !== id);
  await saveState();
  renderCriteria();
  notifyContentScript();
}

async function toggleAction(id, action) {
  const idx = criteria.findIndex(c => c.id === id);
  if (idx === -1) return;

  criteria[idx].actions[action] = !criteria[idx].actions[action];

  // If hide is enabled, disable tag and highlight
  if (action === 'hide' && criteria[idx].actions.hide) {
    criteria[idx].actions.tag = false;
    criteria[idx].actions.highlight = false;
  }
  // If tag or highlight is enabled, disable hide
  if ((action === 'tag' || action === 'highlight') && criteria[idx].actions[action]) {
    criteria[idx].actions.hide = false;
  }

  await saveState();
  renderCriteria();
  notifyContentScript();
}

function notifyContentScript() {
  if (!currentTabId) return;

  chrome.tabs.sendMessage(currentTabId, {
    type: 'UPDATE_CRITERIA',
    criteria,
    isActive
  }).catch(() => {});
}

// Share of seen tweets that matched a topic: how much of the For You feed it has taken over
function topicShare(id) {
  const count = stats.byTopic?.[id] || 0;
  const seen = stats.analyzed || 0;
  const pct = seen > 0 ? Math.min(100, (count / seen) * 100) : 0;
  return { count, seen, pct };
}

function shareLabel(id) {
  const { count, seen, pct } = topicShare(id);
  if (seen === 0) return 'no tweets seen yet';
  const shown = pct > 0 && pct < 1 ? '<1' : Math.round(pct);
  return `${count} ${count === 1 ? 'tweet' : 'tweets'} · ${shown}% of seen`;
}

// Update the share bars in place so an open topic editor is not re-rendered under the user
function updateShares() {
  document.querySelectorAll('.criteria-share').forEach(el => {
    const id = el.dataset.shareId;
    const fill = el.querySelector('.share-fill');
    const text = el.querySelector('.share-text');
    if (fill) fill.style.width = `${topicShare(id).pct}%`;
    if (text) text.textContent = shareLabel(id);
  });

  const takeover = document.getElementById('takeover');
  if (!takeover) return;
  const ranked = criteria
    .map(c => ({ c, ...topicShare(c.id) }))
    .filter(t => t.count > 0)
    .sort((a, b) => b.count - a.count);
  if (ranked.length === 0 || !stats.analyzed) {
    takeover.textContent = '';
    return;
  }
  const top = ranked[0];
  takeover.textContent = `${top.c.emoji || '🏷️'} ${truncateText(top.c.description, 28)} is ${Math.round(top.pct)}% of the ${stats.analyzed} tweets you have seen`;
}

function updateStatsDisplay() {
  document.getElementById('tweetsAnalyzed').textContent = stats.analyzed;
  document.getElementById('tweetsTagged').textContent = stats.tagged;
  document.getElementById('tweetsHidden').textContent = stats.hidden;
  updateShares();
}

async function resetStats() {
  stats = { analyzed: 0, tagged: 0, hidden: 0, byTopic: {} };
  await chrome.storage.local.set({ stats });
  updateStatsDisplay();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'RESET_STATS' });
  } catch {
    // No content script on this tab
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('resetStatsBtn')?.addEventListener('click', resetStats);
});

// The background worker writes Jev decision rules for older topics: keep our copy current
// so a later save from the popup does not overwrite them with stale criteria.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.criteria?.newValue) return;
  const byId = new Map(changes.criteria.newValue.map(c => [c.id, c]));
  let changed = false;
  criteria.forEach(c => {
    const fresh = byId.get(c.id);
    if (fresh && fresh.jevInstruction && fresh.jevInstruction !== c.jevInstruction) {
      c.jevInstruction = fresh.jevInstruction;
      changed = true;
    }
  });
  if (changed) {
    document.querySelectorAll('.criteria-jev-input').forEach(el => {
      const c = criteria.find(x => x.id === el.dataset.id);
      if (c && document.activeElement !== el) el.value = c.jevInstruction || '';
    });
  }
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 1) + '...';
}

// Listen for stats updates from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STATS_UPDATE') {
    stats = message.stats;
    updateStatsDisplay();
  }
});
