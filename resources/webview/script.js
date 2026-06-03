// ── State ───────────────────────────────────────────────────
const state = {
  connections: [],
  activeName: '',
  lastConnectedMap: {},
  modelsByServer: {},
  copilotEnabled: {}, // modelKey → boolean (absent = true)
  loadingProgress: null,
};

const vscode = acquireVsCodeApi();

// Global error handler
window.onerror = function(message, source, lineno, colno, _error) {
  const errText = `[Webview Error] ${message} at ${source}:${lineno}:${colno}`;
  console.error(errText);
  try { vscode.postMessage({ type: 'operationFailed', error: errText }); } catch(e) {}
};

let confirmResolve = null;

// ── Helpers ─────────────────────────────────────────────────
function post(msg) {
  try { vscode.postMessage(msg); } catch (e) { console.error('[Webview] Failed to post message:', e); }
}

function formatSize(bytes) {
  if (bytes == null || bytes === 0) return 'Unknown';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatContext(value) {
  if (!value || value === 0) return 'Unknown';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
}

function showProgress(message) {
  state.loadingProgress = message;
  renderModelBrowser();
}

function clearProgress() {
  state.loadingProgress = null;
  renderModelBrowser();
}

// Returns true if the model is copilot-enabled (absent key defaults to true)
function isCopilotEnabled(modelKey) {
  const val = state.copilotEnabled[modelKey];
  return val === undefined ? true : val;
}

// ── Confirm Dialog ──────────────────────────────────────────
async function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    document.getElementById('confirm-message').textContent = message;
    overlay.classList.remove('hidden');
    confirmResolve = resolve;

    document.getElementById('btn-confirm-ok').onclick = () => {
      overlay.classList.add('hidden');
      confirmResolve(true);
      confirmResolve = null;
    };
    document.getElementById('btn-confirm-cancel').onclick = () => {
      overlay.classList.add('hidden');
      confirmResolve(false);
      confirmResolve = null;
    };
  });
}

// ── Server Form Modal ───────────────────────────────────────
let serverFormMode = 'add'; // 'add' | 'edit'
let serverFormEditingName = '';

function showServerForm(mode, existingConfig) {
  serverFormMode = mode;
  const overlay = document.getElementById('server-form-overlay');
  document.getElementById('server-form-title').textContent = mode === 'add' ? 'Add Server' : 'Edit Server';

  ['err-sf-name', 'err-sf-host', 'err-sf-port', 'err-sf-connect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
      if (id === 'err-sf-connect') {
        document.getElementById('err-sf-connect-text').textContent = '';
        document.getElementById('btn-save-anyway').classList.add('hidden');
      } else {
        el.textContent = '';
      }
    }
  });

  if (mode === 'edit' && existingConfig) {
    serverFormEditingName = existingConfig.name;
    document.getElementById('sf-name').value = existingConfig.name;
    document.getElementById('sf-scheme').value = existingConfig.scheme || 'http';
    document.getElementById('sf-host').value = existingConfig.host || '';
    document.getElementById('sf-port').value = existingConfig.port || 1234;
    document.getElementById('sf-token').value = '';
  } else {
    serverFormEditingName = '';
    document.getElementById('sf-name').value = '';
    document.getElementById('sf-scheme').value = 'http';
    document.getElementById('sf-host').value = '';
    document.getElementById('sf-port').value = '1234';
    document.getElementById('sf-token').value = '';
  }

  overlay.classList.remove('hidden');
  setTimeout(() => document.getElementById(`sf-${mode === 'edit' ? 'host' : 'name'}`).focus(), 50);
}

function hideServerForm() {
  document.getElementById('server-form-overlay').classList.add('hidden');
}

// ── Render Functions ────────────────────────────────────────
function renderServers() {
  const list = document.getElementById('server-list');
  list.innerHTML = '';

  if (state.connections.length === 0) {
    list.innerHTML = '<div class="empty-state">No servers configured. Click + to add one.</div>';
    return;
  }

  for (const conn of state.connections) {
    const tpl = document.getElementById('tpl-server-card');
    const card = tpl.content.cloneNode(true);

    const el = card.querySelector('.server-card');
    if (conn.name === state.activeName) el.classList.add('active');

    if (conn.name !== state.activeName) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        if (e.target.closest('.server-actions')) return;
        post({ type: 'switchConnection', name: conn.name });
      });
    } else {
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        if (e.target.closest('.server-actions')) return;
        if (state.loadingProgress) return;
        post({ type: 'fetchModels', serverName: state.activeName });
      });
    }

    const dot = card.querySelector('.status-dot');
    const isConnected = state.lastConnectedMap[conn.name];
    dot.className = `status-dot ${isConnected ? 'connected' : 'disconnected'}`;

    card.querySelector('.name').textContent = conn.name;
    card.querySelector('.server-address').textContent = `${conn.scheme}://${conn.host}:${conn.port}`;

    const btnSwitch = card.querySelector('.btn-switch');
    if (conn.name === state.activeName) {
      btnSwitch.disabled = true;
      btnSwitch.title = 'Active connection';
    } else {
      btnSwitch.addEventListener('click', () => post({ type: 'switchConnection', name: conn.name }));
    }

    const btnEdit = card.querySelector('.btn-edit');
    btnEdit.addEventListener('click', () => showServerForm('edit', conn));

    const btnRemove = card.querySelector('.btn-remove');
    if (state.connections.length <= 1) {
      btnRemove.disabled = true;
      btnRemove.title = 'Cannot remove the last connection';
    } else {
      btnRemove.addEventListener('click', async () => {
        const ok = await confirmDialog(`Remove connection "${conn.name}"?`);
        if (ok) post({ type: 'removeServer', name: conn.name });
      });
    }

    list.appendChild(el);
  }
}

function renderModelBrowser() {
  const container = document.getElementById('model-browser');
  container.innerHTML = '';

  if (!state.activeName) {
    container.innerHTML = '<div class="empty-state">No active server selected.</div>';
    return;
  }

  if (state.loadingProgress) {
    const progEl = document.createElement('div');
    progEl.className = 'progress-bar';
    progEl.innerHTML = `<div class="progress-fill"></div>`;
    container.appendChild(progEl);
    const msgEl = document.createElement('div');
    msgEl.style.cssText = 'font-size:12px;padding:4px 0;color:var(--text-secondary);';
    msgEl.textContent = state.loadingProgress;
    container.appendChild(msgEl);
  }

  const models = (state.modelsByServer[state.activeName] || []).filter(m => m && Array.isArray(m.loaded_instances));
  if (!models) return;

  // Loaded Models section
  const loadedSection = document.createElement('div');
  loadedSection.className = 'section';
  const loadedHeader = document.createElement('div');
  loadedHeader.className = 'section-header';
  loadedHeader.innerHTML = `<span class="section-title"><span class="section-chevron">&#x25BC;</span> Loaded Models</span>`;
  loadedSection.appendChild(loadedHeader);

  const loadedBody = document.createElement('div');
  loadedBody.className = 'section-body';
  const loadedModels = models.filter(m => m.loaded_instances && m.loaded_instances.length > 0);
  if (loadedModels.length === 0) {
    loadedBody.innerHTML = '<div class="empty-state">No models loaded.</div>';
  } else {
    for (const model of loadedModels) {
      loadedBody.appendChild(createModelCard(model, 'loaded'));
    }
  }
  loadedSection.appendChild(loadedBody);

  // Available Models section
  const availableSection = document.createElement('div');
  availableSection.className = 'section';
  const availHeader = document.createElement('div');
  availHeader.className = 'section-header';
  availHeader.innerHTML = `<span class="section-title"><span class="section-chevron">&#x25BC;</span> Available Models</span>`;
  availableSection.appendChild(availHeader);

  const availBody = document.createElement('div');
  availBody.className = 'section-body';
  const availableModels = models.filter(m => !m.loaded_instances || m.loaded_instances.length === 0);
  if (availableModels.length === 0) {
    availBody.innerHTML = '<div class="empty-state">No available models found.</div>';
  } else {
    for (const model of availableModels) {
      availBody.appendChild(createModelCard(model, 'available'));
    }
  }
  availableSection.appendChild(availBody);

  container.appendChild(loadedSection);
  container.appendChild(availableSection);

  const unloadAllBtn = document.getElementById('btn-unload-all');
  if (loadedModels.length > 0) {
    unloadAllBtn.classList.remove('hidden');
  } else {
    unloadAllBtn.classList.add('hidden');
  }
}

function createModelCard(model, type) {
  const tpl = document.getElementById('tpl-model-card');
  const card = tpl.content.cloneNode(true);
  const el = card.querySelector('.model-card');

  if (type === 'loaded') el.classList.add('loaded');

  // Apply copilot-disabled class for visual dimming
  const enabled = isCopilotEnabled(model.key);
  if (!enabled) el.classList.add('copilot-disabled');

  card.querySelector('.model-name').textContent = model.display_name;
  const quantName = model.quantization?.name || '';
  const bits = model.quantization?.bits_per_weight ?? '';
  const metaParts = [];
  if (quantName && bits) metaParts.push(`${quantName} · ${bits}bit`);
  if (model.params_string) metaParts.push(model.params_string);
  card.querySelector('.model-meta').textContent = metaParts.join(' · ');

  const badgesEl = card.querySelector('.badges');
  if (model.capabilities?.vision) {
    badgesEl.innerHTML += '<span class="badge">&#x1f441; Vision</span>';
  }
  if (model.capabilities?.trained_for_tool_use) {
    badgesEl.innerHTML += '<span class="badge">&#x1f527; Tool Use</span>';
  }

  const promotedMeta = card.querySelector('.model-promoted-meta');
  if (model.architecture) {
    const archSpan = document.createElement('span');
    archSpan.innerHTML = `<span class="meta-label">${escHtml(model.architecture)}</span>`;
    promotedMeta.appendChild(archSpan);
  }
  if (type === 'loaded' && model.loaded_instances[0]?.config) {
    const cfg = model.loaded_instances[0].config;
    if (cfg.context_length || model.max_context_length) {
      const ctxSpan = document.createElement('span');
      const loadedStr = formatContext(cfg.context_length);
      const maxStr = model.max_context_length ? ` of ${formatContext(model.max_context_length)}` : '';
      ctxSpan.innerHTML = `<span class="meta-label">Context:</span> ${loadedStr}${maxStr}`;
      promotedMeta.appendChild(ctxSpan);
    }
  } else if (type === 'available' && model.max_context_length) {
    const ctxSpan = document.createElement('span');
    ctxSpan.innerHTML = `<span class="meta-label">Context:</span> ${formatContext(model.max_context_length)}`;
    promotedMeta.appendChild(ctxSpan);
  }

  // Copilot checkbox
  const checkbox = card.querySelector('.copilot-checkbox');
  checkbox.checked = enabled;
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    const newEnabled = e.target.checked;
    el.classList.toggle('copilot-disabled', !newEnabled);
    state.copilotEnabled[model.key] = newEnabled;
    post({ type: 'setCopilotEnabled', modelKey: model.key, enabled: newEnabled });
  });

  // Actions
  const actionsEl = card.querySelector('.model-actions');
  if (type === 'loaded') {
    const instId = model.loaded_instances[0]?.id;
    if (instId) {
      const unloadBtn = document.createElement('button');
      unloadBtn.className = 'unload-btn';
      unloadBtn.title = 'Unload';
      unloadBtn.textContent = '✖';
      unloadBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog(`Unload "${model.display_name}"?`);
        if (ok) post({ type: 'unloadModel', instanceId: instId });
      });
      actionsEl.appendChild(unloadBtn);

      const reloadBtn = document.createElement('button');
      reloadBtn.className = 'btn-icon btn-small';
      reloadBtn.title = 'Reload Settings';
      reloadBtn.textContent = '⚙️';
      reloadBtn.addEventListener('click', (e) => { e.stopPropagation(); showLoadSettingsForm(model, instId); });
      actionsEl.appendChild(reloadBtn);
    }
  } else {
    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn-icon btn-small';
    loadBtn.title = 'Load with defaults';
    loadBtn.textContent = '▶️';
    loadBtn.addEventListener('click', (e) => { e.stopPropagation(); post({ type: 'loadModelDefault', modelKey: model.key }); });
    actionsEl.appendChild(loadBtn);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'btn-icon btn-small';
    settingsBtn.title = 'Load with Settings';
    settingsBtn.textContent = '⚙️';
    settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); showLoadSettingsForm(model, undefined); });
    actionsEl.appendChild(settingsBtn);
  }

  // Expandable details
  const header = card.querySelector('.model-card-header');
  const details = card.querySelector('.model-details');
  header.addEventListener('click', (e) => {
    if (e.target.closest('.btn-icon') || e.target.closest('.unload-btn') || e.target.closest('.copilot-toggle')) return;
    el.classList.toggle('expanded');
    details.classList.toggle('hidden');
  });

  // Build detail content
  let detailHTML = '';
  if (model.architecture) detailHTML += `<div class="detail-row"><span class="detail-label">Architecture:</span> ${escHtml(model.architecture)}</div>`;
  if (model.format) detailHTML += `<div class="detail-row"><span class="detail-label">Format:</span> ${model.format}</div>`;

  if (type === 'loaded' && model.loaded_instances[0]?.config) {
    const cfg = model.loaded_instances[0].config;
    const ctxLoaded = formatContext(cfg.context_length);
    const ctxMax = formatContext(model.max_context_length);
    detailHTML += `<div class="detail-row"><span class="detail-label">Context:</span> ${ctxLoaded}${model.max_context_length ? ` of ${ctxMax}` : ''}</div>`;
    if (cfg.flash_attention !== undefined) {
      detailHTML += `<div class="detail-row"><span class="detail-label">Flash Attention:</span> ${cfg.flash_attention ? 'Yes' : 'No'}</div>`;
    }
    if (cfg.offload_kv_cache_to_gpu !== undefined) {
      detailHTML += `<div class="detail-row"><span class="detail-label">GPU KV Cache:</span> ${cfg.offload_kv_cache_to_gpu ? 'Yes' : 'No'}</div>`;
    }
    if (cfg.parallel !== undefined) {
      detailHTML += `<div class="detail-row"><span class="detail-label">Parallel Slots:</span> ${cfg.parallel}</div>`;
    }
    if (cfg.eval_batch_size !== undefined) {
      detailHTML += `<div class="detail-row"><span class="detail-label">Eval Batch Size:</span> ${cfg.eval_batch_size}</div>`;
    }
  } else {
    const sizeStr = formatSize(model.size_bytes);
    if (sizeStr !== 'Unknown') detailHTML += `<div class="detail-row"><span class="detail-label">Size:</span> ${sizeStr}</div>`;
    if (model.max_context_length) detailHTML += `<div class="detail-row"><span class="detail-label">Max Context:</span> ${formatContext(model.max_context_length)}</div>`;
  }

  details.innerHTML = detailHTML;

  return el;
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ── Model Settings Form ──────────────────────────────────────

let settingsFormInstanceId = '';

function showLoadSettingsForm(model, instanceId) {
  document.querySelectorAll('.model-settings-form').forEach(f => f.remove());

  const card = Array.from(document.querySelectorAll('.model-card')).find(c => c.querySelector('.model-name')?.textContent === model.display_name);
  if (!card) return;

  const details = card.querySelector('.model-details');
  settingsFormInstanceId = instanceId || '';

  card.classList.add('expanded');
  details.classList.remove('hidden');

  details.innerHTML = buildSettingsDetailContent(model, instanceId);

  const contextInput = document.getElementById('lsf-context');
  if (contextInput) contextInput.focus();

  document.getElementById('btn-ls-cancel').addEventListener('click', () => {
    rebuildReadOnlyDetails(card, model);
    card.classList.remove('expanded');
    details.classList.add('hidden');
  });
  document.getElementById('btn-ls-save').addEventListener('click', handleSaveLoadSettings);

  const cancelHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      rebuildReadOnlyDetails(card, model);
      card.classList.remove('expanded');
      details.classList.add('hidden');
      document.removeEventListener('keydown', cancelHandler);
    }
  };
  document.addEventListener('keydown', cancelHandler);
}

function buildSettingsDetailContent(model, instanceId) {
  const isLoaded = instanceId !== undefined;
  const actionLabel = isLoaded ? 'Reload' : 'Load';

  let html = '<div class="settings-section"><h4 class="settings-section-title">Model Info</h4>';
  if (model.architecture) html += `<div class="detail-row"><span class="detail-label">Architecture:</span> ${escHtml(model.architecture)}</div>`;
  if (model.format) html += `<div class="detail-row"><span class="detail-label">Format:</span> ${model.format}</div>`;

  const isGguf = model.format === 'gguf';
  const maxContext = model.max_context_length || undefined;
  let contextVal = maxContext;
  if (isLoaded && model.loaded_instances[0]?.config?.context_length) {
    contextVal = model.loaded_instances[0].config.context_length;
  }

  if (isLoaded && model.loaded_instances[0]?.config) {
    const cfg = model.loaded_instances[0].config;
    html += `<div class="detail-row"><span class="detail-label">Current Context:</span> ${formatContext(cfg.context_length)}</div>`;
  }

  html += '</div>';
  html += '<div class="settings-section"><h4 class="settings-section-title">Configuration</h4>';

  html += `
    <div class="form-group">
      <label for="lsf-context">Context Length${maxContext ? ` (max: ${maxContext})` : ''}</label>
      <input type="number" id="lsf-context" value="${contextVal || ''}" min="1"${maxContext ? ` max="${maxContext}"` : ''}>
    </div>
  `;

  if (isGguf) {
    const faDefault = isLoaded && model.loaded_instances[0]?.config?.flash_attention !== undefined
      ? (model.loaded_instances[0].config.flash_attention ? '1' : '0') : '1';
    const gpuDefault = isLoaded && model.loaded_instances[0]?.config?.offload_kv_cache_to_gpu !== undefined
      ? (model.loaded_instances[0].config.offload_kv_cache_to_gpu ? '1' : '0') : '1';

    html += `
      <div class="form-group">
        <label for="lsf-flash-attention">Flash Attention</label>
        <select id="lsf-flash-attention">
          <option value="1" ${faDefault === '1' ? 'selected' : ''}>Yes (default)</option>
          <option value="0">No</option>
        </select>
        <div class="form-hint">Enable flash attention for faster inference on supported GPUs.</div>
      </div>
    `;
    html += `
      <div class="form-group">
        <label for="lsf-gpu-kv">GPU KV Cache Offload</label>
        <select id="lsf-gpu-kv">
          <option value="1" ${gpuDefault === '1' ? 'selected' : ''}>Yes (default)</option>
          <option value="0">No</option>
        </select>
        <div class="form-hint">Offload KV cache to GPU for better performance.</div>
      </div>
    `;
  }

  html += '</div>';
  html += `
    <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px;">
      <button id="btn-ls-cancel" class="btn-small">Cancel</button>
      <button id="btn-ls-save" class="btn-small">${actionLabel}</button>
    </div>
  `;

  const el = document.querySelector('.model-card.expanded .model-details');
  if (el) { el.setAttribute('data-model-key', model.key); }

  return html;
}

function rebuildReadOnlyDetails(card, model) {
  const details = card.querySelector('.model-details');
  const isLoaded = card.classList.contains('loaded');
  buildReadOnlyDetailContent(details, model, isLoaded ? 'loaded' : 'available');
}

function buildReadOnlyDetailContent(details, model, type) {
  let detailHTML = '';
  if (model.architecture) detailHTML += `<div class="detail-row"><span class="detail-label">Architecture:</span> ${escHtml(model.architecture)}</div>`;
  if (model.format) detailHTML += `<div class="detail-row"><span class="detail-label">Format:</span> ${model.format}</div>`;

  if (type === 'loaded' && model.loaded_instances[0]?.config) {
    const cfg = model.loaded_instances[0].config;
    const ctxLoaded = formatContext(cfg.context_length);
    const ctxMax = formatContext(model.max_context_length);
    detailHTML += `<div class="detail-row"><span class="detail-label">Context:</span> ${ctxLoaded}${model.max_context_length ? ` of ${ctxMax}` : ''}</div>`;
    if (cfg.flash_attention !== undefined) {
      detailHTML += `<div class="detail-row"><span class="detail-label">Flash Attention:</span> ${cfg.flash_attention ? 'Yes' : 'No'}</div>`;
    }
    if (cfg.offload_kv_cache_to_gpu !== undefined) {
      detailHTML += `<div class="detail-row"><span class="detail-label">GPU KV Cache:</span> ${cfg.offload_kv_cache_to_gpu ? 'Yes' : 'No'}</div>`;
    }
    if (cfg.parallel !== undefined) {
      detailHTML += `<div class="detail-row"><span class="detail-label">Parallel Slots:</span> ${cfg.parallel}</div>`;
    }
    if (cfg.eval_batch_size !== undefined) {
      detailHTML += `<div class="detail-row"><span class="detail-label">Eval Batch Size:</span> ${cfg.eval_batch_size}</div>`;
    }
  } else {
    const sizeStr = formatSize(model.size_bytes);
    if (sizeStr !== 'Unknown') detailHTML += `<div class="detail-row"><span class="detail-label">Size:</span> ${sizeStr}</div>`;
    if (model.max_context_length) detailHTML += `<div class="detail-row"><span class="detail-label">Max Context:</span> ${formatContext(model.max_context_length)}</div>`;
  }

  details.innerHTML = detailHTML;
}

async function handleSaveLoadSettings() {
  const contextInput = document.getElementById('lsf-context');
  if (!contextInput) return;

  const rawValue = contextInput.value.trim();
  if (rawValue === '') { toast('Context length cannot be empty.', 'error'); return; }
  const context = parseInt(rawValue, 10);
  if (isNaN(context) || context < 1) { toast('Please enter a valid context length.', 'error'); return; }

  const detailsEl = document.querySelector('.model-card.expanded .model-details');
  const modelKey = detailsEl ? detailsEl.getAttribute('data-model-key') : null;
  if (!modelKey) { toast('Unable to identify model. Please try again.', 'error'); return; }

  const models = state.modelsByServer[state.activeName] || [];
  const modelData = models.find(m => m.key === modelKey);
  if (!modelData) { toast('Model not found. Please refresh the model list.', 'error'); return; }

  if (modelData.max_context_length && context > modelData.max_context_length) {
    toast(`Context length must be <= ${modelData.max_context_length}.`, 'error');
    return;
  }

  const config = { context_length: context };

  if (modelData.format === 'gguf') {
    const faEl = document.getElementById('lsf-flash-attention');
    if (faEl) config.flash_attention = faEl.value === '1';
    const gpuEl = document.getElementById('lsf-gpu-kv');
    if (gpuEl) config.offload_kv_cache_to_gpu = gpuEl.value === '1';
  }

  post({ type: settingsFormInstanceId ? 'reloadModelSettings' : 'loadModelSettings', payload: { modelKey, instanceId: settingsFormInstanceId, config } });
}

// ── Connection test result handler ───────────────────────────
function handleConnectionTested(success, error) {
  if (success) {
    toast('Connection successful!', 'success');
  } else {
    toast(`Connection failed: ${error || 'Unknown error'}`, 'error');
  }
}

// ── Message Handler ─────────────────────────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'connectionsUpdated':
        state.connections = msg.connections;
        state.activeName = msg.activeName;
        state.lastConnectedMap = msg.lastConnectedMap || {};
        renderServers();
        renderModelBrowser();
        break;

      case 'connectionTested':
        handleConnectionTested(msg.success, msg.error);
        break;

      case 'modelsUpdated':
        if (msg.models !== undefined) {
          state.modelsByServer[msg.serverName] = msg.models;
        }
        if (msg.copilotEnabled !== undefined) {
          state.copilotEnabled = msg.copilotEnabled;
        }
        renderModelBrowser();
        break;

      case 'operationProgress':
        showProgress(msg.message);
        break;

      case 'operationComplete':
        clearProgress();
        toast(msg.message, 'success');
        post({ type: 'refreshServer', serverName: state.activeName });
        break;

      case 'operationFailed':
        clearProgress();
        toast(msg.error, 'error');
        break;

      case 'tokenRequiredForServer':
        toast(`Authentication required for "${msg.serverName}". Please update the API token.`, 'warning');
        break;
    }
  } catch (e) {
    console.error('[Webview] Failed to process message:', e);
  }
});

// ── Event Listeners ─────────────────────────────────────────
function initializeWebview() {
  setTimeout(() => { post({ type: 'init' }); }, 100);

  const btnRefreshAll = document.getElementById('btn-refresh-all');
  if (btnRefreshAll) { btnRefreshAll.addEventListener('click', () => post({ type: 'refreshAll' })); }

  const btnAddServer = document.getElementById('btn-add-server');
  if (btnAddServer) { btnAddServer.addEventListener('click', () => showServerForm('add')); }

  const btnServerCancel = document.getElementById('btn-server-cancel');
  if (btnServerCancel) { btnServerCancel.addEventListener('click', hideServerForm); }

  const btnSaveAnyway = document.getElementById('btn-save-anyway');
  if (btnSaveAnyway) { btnSaveAnyway.addEventListener('click', () => { saveServerData(); }); }

  const btnServerSave = document.getElementById('btn-server-save');
  if (btnServerSave) {
    btnServerSave.addEventListener('click', async () => {
      const nameEl = document.getElementById('sf-name');
      const schemeEl = document.getElementById('sf-scheme');
      const hostEl = document.getElementById('sf-host');
      const portEl = document.getElementById('sf-port');
      const tokenEl = document.getElementById('sf-token');

      if (!nameEl || !schemeEl || !hostEl || !portEl || !tokenEl) return;

      const name = nameEl.value.trim();
      const scheme = schemeEl.value;
      const host = hostEl.value.trim();
      const port = parseInt(portEl.value, 10);
      const token = tokenEl.value;
      const config = { name, scheme, host, port };

      const errConnectEl = document.getElementById('err-sf-connect');
      if (errConnectEl) errConnectEl.classList.add('hidden');
      hideServerForm();

      const msg = {
        type: serverFormMode === 'add' ? 'addServer' : 'editServer',
        config,
        token: token || undefined
      };
      if (serverFormMode === 'edit') {
        msg.name = serverFormEditingName;
      }
      post(msg);
    });
  }

  const btnUnloadAll = document.getElementById('btn-unload-all');
  if (btnUnloadAll) {
    btnUnloadAll.addEventListener('click', async () => {
      const ok = await confirmDialog('Unload all loaded models?');
      if (ok) post({ type: 'unloadAllModels' });
    });
  }

  document.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const section = header.closest('.section');
      if (section) section.classList.toggle('collapsed');
    });
  });

  const serverFormOverlay = document.getElementById('server-form-overlay');
  if (serverFormOverlay) {
    serverFormOverlay.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) hideServerForm();
    });
  }

  const confirmOverlayEl = document.getElementById('confirm-overlay');
  if (confirmOverlayEl) {
    confirmOverlayEl.addEventListener('click', (e) => {
      if (e.target === e.currentTarget && confirmResolve) {
        confirmOverlayEl.classList.add('hidden');
        confirmResolve(false);
        confirmResolve = null;
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideServerForm();
      const overlay = document.getElementById('confirm-overlay');
      if (overlay && !overlay.classList.contains('hidden') && confirmResolve) {
        overlay.classList.add('hidden');
        confirmResolve(false);
        confirmResolve = null;
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeWebview);
} else {
  initializeWebview();
}
