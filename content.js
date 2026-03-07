/* ============================================
   InstaClean – Content Script
   ============================================
   Pure DOM-based Instagram activity cleaner.
   Clicks real UI buttons; no API, no cookies.
   ============================================ */

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────
  const state = {
    running: false,
    action: null,
    stats: { processed: 0, removed: 0, skipped: 0 },
    logs: [],
    friendsList: new Set(),
    ownUsername: null, // detected logged-in user's username
  };

  // ─── Constants ─────────────────────────────────
  const URLS = {
    likes:    'https://www.instagram.com/your_activity/interactions/likes',
    comments: 'https://www.instagram.com/your_activity/interactions/comments',
  };

  // Non-profile path prefixes to ignore when extracting usernames
  const NON_PROFILE_PATHS = new Set([
    'explore', 'reels', 'direct', 'your_activity', 'accounts',
    'about', 'legal', 'privacy', 'safety', 'p', 'reel', 'stories',
    'tags', 'locations', 'static', 'developer', 'emails', 'settings',
    'nametag', 'session', 'challenge', 'web', 'ar', 'lite',
  ]);

  // ─── i18n: Button text translations ───────────
  // Each key maps to an array of known translations.
  // findLocalizedClickable() tries every variant for a given action.
  const UI_TEXTS = {
    select:       ['Select', 'Seç', 'Seleccionar', 'Sélectionner', 'Auswählen', 'Seleziona', 'Selecionar', 'Выбрать', '選択', '选择', '선택'],
    deselectAll:  ['Deselect all', 'Tümünün seçimini kaldır', 'Deseleccionar todo', 'Tout désélectionner', 'Alle abwählen', 'Deseleziona tutto', 'Desmarcar tudo', 'Отменить выбор', 'すべて選択解除', '取消全选', '전체 선택 해제'],
    unlike:       ['Unlike', 'Beğenmekten vazgeç', 'Ya no me gusta', 'Je n\'aime plus', 'Gefällt mir nicht mehr', 'Non mi piace più', 'Descurtir', 'Убрать отметку', 'いいね!を取り消す', '取消赞', '좋아요 취소'],
    delete:       ['Delete', 'Sil', 'Eliminar', 'Supprimer', 'Löschen', 'Elimina', 'Excluir', 'Удалить', '削除', '删除', '삭제'],
    cancel:       ['Cancel', 'İptal', 'Cancelar', 'Annuler', 'Abbrechen', 'Annulla', 'Cancelar', 'Отмена', 'キャンセル', '取消', '취소'],
    confirm:      ['Confirm', 'Onayla', 'Confirmar', 'Confirmer', 'Bestätigen', 'Conferma', 'Confirmar', 'Подтвердить', '確認', '确认', '확인'],
    done:         ['Done', 'Bitti', 'Listo', 'Terminé', 'Fertig', 'Fine', 'Concluído', 'Готово', '完了', '完成', '완료'],
    close:        ['Close', 'Kapat', 'Cerrar', 'Fermer', 'Schließen', 'Chiudi', 'Fechar', 'Закрыть', '閉じる', '关闭', '닫기'],
    ok:           ['OK', 'Tamam', 'Aceptar', 'D\'accord', 'Ok', 'Va bene', 'Certo', 'ОК', 'OK', '好的', '확인'],
  };

  // Instagram enforces a batch limit – selecting too many items at once causes errors.
  const BATCH_SIZE = 15;

  /**
   * Try finding a clickable element using all known translations for a given action key.
   * @param {string} actionKey – key in UI_TEXTS (e.g. 'select', 'unlike', 'delete')
   * @param {Element} parent – optional parent scope
   * @returns {Element|null}
   */
  function findLocalizedClickable(actionKey, parent = document) {
    const variants = UI_TEXTS[actionKey];
    if (!variants) return findClickable(actionKey, parent);
    for (const text of variants) {
      const el = findClickable(text, parent);
      if (el) return el;
    }
    return null;
  }

  /**
   * Try finding a dialog button using all known translations for a given action key.
   */
  function findLocalizedDialogButton(actionKey) {
    const variants = UI_TEXTS[actionKey];
    if (!variants) return findDialogButton(actionKey);
    for (const text of variants) {
      const btn = findDialogButton(text);
      if (btn) return btn;
    }
    return null;
  }

  // ─── Utility ─────────────────────────────────

  /**
   * Check if the extension context is still valid.
   * After the extension is reloaded, the old content script's chrome.* APIs die.
   */
  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  }

  /** Safe wrapper for chrome.storage.local.set */
  function safeStorageSet(data) {
    if (!isContextValid()) return Promise.resolve();
    try {
      return chrome.storage.local.set(data);
    } catch {
      handleContextInvalidated();
      return Promise.resolve();
    }
  }

  /** Safe wrapper for chrome.storage.local.get */
  function safeStorageGet(keys) {
    if (!isContextValid()) return Promise.resolve({});
    try {
      return chrome.storage.local.get(keys);
    } catch {
      handleContextInvalidated();
      return Promise.resolve({});
    }
  }

  /** Safe wrapper for chrome.storage.local.remove */
  function safeStorageRemove(keys) {
    if (!isContextValid()) return Promise.resolve();
    try {
      return chrome.storage.local.remove(keys);
    } catch {
      handleContextInvalidated();
      return Promise.resolve();
    }
  }

  /** Called when the context is dead – stop everything gracefully */
  function handleContextInvalidated() {
    console.warn('[InstaClean] Extension context invalidated. Cleaning up old instance.');
    state.running = false;
    // Remove the old panel from the DOM so the fresh script can inject a new one
    const oldPanel = document.getElementById('instaclean-root');
    if (oldPanel) oldPanel.remove();
    // Remove old CSS
    document.querySelectorAll('link[href*="panel.css"]').forEach(l => l.remove());
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Human-ish random delay */
  function humanDelay(min = 600, max = 1400) {
    return delay(min + Math.random() * (max - min));
  }

  function log(msg) {
    const ts = new Date().toLocaleTimeString();
    const entry = `[${ts}] ${msg}`;
    state.logs.push(entry);
    if (state.logs.length > 200) state.logs.shift();
    console.log(`[InstaClean] ${entry}`);
    persistProgress();
  }

  function persistProgress() {
    safeStorageSet({
      cleanerProgress: {
        isRunning: state.running,
        action: state.action,
        stats: { ...state.stats },
        logs: state.logs.slice(-80),
        timestamp: Date.now(),
      },
    });
    // Live-update the injected panel
    updatePanelStats();
    updatePanelLog();

    // Update sync info if needed
    if (!state.running && panelRoot) {
      showProgress(false);
      setActionButtons(false);
      safeStorageGet('friendsList').then(stored => {
        const info = panelRoot ? panelRoot.querySelector('#ic-sync-info') : null;
        if (info && stored.friendsList && stored.friendsList.length > 0) {
          info.textContent = `${stored.friendsList.length} friends synced.`;
        }
      });
    }
  }

  function resetStats() {
    state.stats = { processed: 0, removed: 0, skipped: 0 };
    state.logs = [];
  }

  // ─── Injected Panel ────────────────────────────

  let panelRoot = null;
  let panelEl = null;
  let fabEl = null;
  let panelVisible = false;
  let panelMinimised = false;

  function injectPanel() {
    // Bail out if extension context is dead
    if (!isContextValid()) {
      handleContextInvalidated();
      return;
    }

    if (document.getElementById('instaclean-root')) {
      panelRoot = document.getElementById('instaclean-root');
      panelEl = panelRoot.querySelector('.ic-panel');
      fabEl = panelRoot.querySelector('.ic-fab');
      return;
    }

    // Inject CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    try {
      link.href = chrome.runtime.getURL('panel.css');
    } catch {
      handleContextInvalidated();
      return;
    }
    document.head.appendChild(link);

    panelRoot = document.createElement('div');
    panelRoot.id = 'instaclean-root';
    panelRoot.innerHTML = buildPanelHTML();
    document.body.appendChild(panelRoot);

    panelEl = panelRoot.querySelector('.ic-panel');
    fabEl = panelRoot.querySelector('.ic-fab');

    // Restore panel state from storage
    panelVisible = true;
    safeStorageGet('panelState').then(stored => {
      const ps = stored.panelState || {};
      panelMinimised = ps.minimised !== false; // default to minimised on first ever load
      if (panelMinimised) {
        panelEl.classList.add('ic-hidden');
        fabEl.classList.remove('ic-hidden');
      } else {
        panelEl.classList.remove('ic-hidden');
        fabEl.classList.add('ic-hidden');
      }
      refreshPanelState();
    });

    bindPanelEvents();
  }

  function buildPanelHTML() {
    return `
      <!-- FAB (minimised state) -->
      <button class="ic-fab" title="Open InstaClean">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
        </svg>
      </button>

      <!-- Panel (expanded state) -->
      <div class="ic-panel ic-hidden">
        <div class="ic-header" id="ic-drag-handle">
          <span class="ic-title">InstaClean</span>
          <div class="ic-header-actions">
            <button class="ic-header-btn" id="ic-btn-minimise" title="Minimise">─</button>
            <button class="ic-header-btn" id="ic-btn-close" title="Close">✕</button>
          </div>
        </div>
        <div class="ic-body">
          <!-- How to Use -->
          <div class="ic-section">
            <div class="ic-section-title ic-collapsible" id="ic-guide-toggle">
              How to Use
              <span class="ic-chevron">▸</span>
            </div>
            <div class="ic-guide ic-hidden" id="ic-guide">
              <ol class="ic-guide-steps">
                <li>Click <b>Remove Likes</b> or <b>Remove Comments</b></li>
                <li>The extension navigates to your activity page automatically</li>
                <li>Items are selected in batches of 15 and removed</li>
                <li>Click <b>Stop</b> anytime to pause</li>
              </ol>
              <div class="ic-guide-note">
                <b>Exclude Friends</b> (comments only): Toggle it on, sync your following/followers list first, then comments on friends' posts will be skipped.
              </div>
              <div class="ic-guide-note">
                <b>Not working?</b> Try switching your Instagram language to <b>English</b> in Settings → Language. The extension supports 11 languages, but English is the most reliable.
              </div>
            </div>
          </div>

          <!-- Options -->
          <div class="ic-section">
            <div class="ic-section-title">Options</div>
            <div class="ic-option-row">
              <label for="ic-exclude">
                <span>Exclude friends</span>
                <small>Skip comments on posts by people you follow or who follow you (comments only)</small>
              </label>
              <label class="ic-toggle">
                <input type="checkbox" id="ic-exclude">
                <span class="ic-toggle-slider"></span>
              </label>
            </div>
            <div class="ic-sync ic-hidden" id="ic-sync-section">
              <div class="ic-sync-info" id="ic-sync-info">No friends list synced yet.</div>
              <div class="ic-sync-actions">
                <button class="ic-btn ic-btn-secondary" id="ic-btn-sync-following">Sync Following</button>
                <button class="ic-btn ic-btn-secondary" id="ic-btn-sync-followers">Sync Followers</button>
              </div>
            </div>
          </div>

          <!-- Actions -->
          <div class="ic-section">
            <div class="ic-section-title">Actions</div>
            <button class="ic-btn ic-btn-primary" id="ic-btn-likes">♥ Remove Likes</button>
            <button class="ic-btn ic-btn-primary" id="ic-btn-comments">💬 Remove Comments</button>
          </div>

          <!-- Progress -->
          <div class="ic-section ic-hidden" id="ic-progress-section">
            <div class="ic-section-title">Progress</div>
            <div class="ic-progress-bar-wrap">
              <div class="ic-progress-bar indeterminate" id="ic-progress-bar"></div>
            </div>
            <div class="ic-stats">
              <div class="ic-stat"><span class="ic-stat-value" id="ic-stat-processed">0</span><span class="ic-stat-label">Processed</span></div>
              <div class="ic-stat"><span class="ic-stat-value" id="ic-stat-removed">0</span><span class="ic-stat-label">Removed</span></div>
              <div class="ic-stat"><span class="ic-stat-value" id="ic-stat-skipped">0</span><span class="ic-stat-label">Skipped</span></div>
            </div>
            <button class="ic-btn ic-btn-danger" id="ic-btn-stop">Stop</button>
          </div>

          <!-- Log -->
          <div class="ic-section">
            <div class="ic-section-title">
              Log
              <button class="ic-btn-clear" id="ic-btn-clear-log">Clear</button>
            </div>
            <div class="ic-log" id="ic-log">
              <div class="ic-log-empty">No activity yet.</div>
            </div>
          </div>
        </div>
        <div class="ic-footer">
          <small>Open-source DOM-based · No API · No credentials</small>
        </div>
      </div>
    `;
  }

  function bindPanelEvents() {
    // FAB → expand
    fabEl.addEventListener('click', (e) => {
      e.stopPropagation();
      setPanelMinimised(false);
      refreshPanelState();
    });

    // Minimise → FAB
    panelRoot.querySelector('#ic-btn-minimise').addEventListener('click', (e) => {
      e.stopPropagation();
      setPanelMinimised(true);
    });

    // Close
    panelRoot.querySelector('#ic-btn-close').addEventListener('click', (e) => {
      e.stopPropagation();
      panelVisible = false;
      panelRoot.style.display = 'none';
      safeStorageSet({ panelState: { minimised: true, hidden: true } });
    });

    // Exclude toggle
    const excludeInput = panelRoot.querySelector('#ic-exclude');
    excludeInput.addEventListener('change', async () => {
      await safeStorageSet({ excludeFriends: excludeInput.checked });
      toggleSyncUI(excludeInput.checked);
    });

    // Sync buttons
    panelRoot.querySelector('#ic-btn-sync-following').addEventListener('click', () => {
      panelLog('→ Starting Following sync…');
      setActionButtons(true);
      showProgress(true);
      syncFriendsList('following');
    });

    panelRoot.querySelector('#ic-btn-sync-followers').addEventListener('click', () => {
      panelLog('→ Starting Followers sync…');
      setActionButtons(true);
      showProgress(true);
      syncFriendsList('followers');
    });

    // Remove buttons
    panelRoot.querySelector('#ic-btn-likes').addEventListener('click', async () => {
      const exclude = excludeInput.checked;
      if (exclude) {
        const s = await safeStorageGet('friendsList');
        if (!s.friendsList || s.friendsList.length === 0) {
          panelLog('⚠ Sync your friends list first.');
          return;
        }
      }
      panelLog('→ Starting likes removal…');
      setActionButtons(true);
      showProgress(true);
      removeLikes(exclude);
    });

    panelRoot.querySelector('#ic-btn-comments').addEventListener('click', async () => {
      const exclude = excludeInput.checked;
      if (exclude) {
        const s = await safeStorageGet('friendsList');
        if (!s.friendsList || s.friendsList.length === 0) {
          panelLog('⚠ Sync your friends list first.');
          return;
        }
      }
      panelLog('→ Starting comments removal…');
      setActionButtons(true);
      showProgress(true);
      removeComments(exclude);
    });

    // Guide toggle
    panelRoot.querySelector('#ic-guide-toggle').addEventListener('click', () => {
      const guide = panelRoot.querySelector('#ic-guide');
      const chevron = panelRoot.querySelector('#ic-guide-toggle .ic-chevron');
      guide.classList.toggle('ic-hidden');
      chevron.textContent = guide.classList.contains('ic-hidden') ? '▸' : '▾';
    });

    // Stop
    panelRoot.querySelector('#ic-btn-stop').addEventListener('click', () => {
      state.running = false;
      panelLog('⏹ Stopped by user. Refreshing page…');
      persistProgress();
      showProgress(false);
      setActionButtons(false);
      // Reload page to clear any partial selections
      setTimeout(() => window.location.reload(), 500);
    });

    // Clear log
    panelRoot.querySelector('#ic-btn-clear-log').addEventListener('click', () => {
      const logEl = panelRoot.querySelector('#ic-log');
      logEl.innerHTML = '<div class="ic-log-empty">No activity yet.</div>';
      state.logs = [];
      safeStorageSet({ cleanerProgress: null });
    });

    // Drag header
    setupDrag();
  }

  function setupDrag() {
    const handle = panelRoot.querySelector('#ic-drag-handle');
    let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ic-header-btn')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panelRoot.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panelRoot.style.left = (origX + dx) + 'px';
      panelRoot.style.top = (origY + dy) + 'px';
      panelRoot.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
    });
  }

  function toggleSyncUI(show) {
    const el = panelRoot.querySelector('#ic-sync-section');
    el.classList.toggle('ic-hidden', !show);
  }

  function setActionButtons(disabled) {
    panelRoot.querySelector('#ic-btn-likes').disabled = disabled;
    panelRoot.querySelector('#ic-btn-comments').disabled = disabled;
    panelRoot.querySelector('#ic-btn-sync-following').disabled = disabled;
    panelRoot.querySelector('#ic-btn-sync-followers').disabled = disabled;
  }

  function showProgress(show) {
    const el = panelRoot.querySelector('#ic-progress-section');
    el.classList.toggle('ic-hidden', !show);
    const bar = panelRoot.querySelector('#ic-progress-bar');
    if (show) bar.classList.add('indeterminate');
    else bar.classList.remove('indeterminate');
  }

  function updatePanelStats() {
    if (!panelRoot) return;
    const p = panelRoot.querySelector('#ic-stat-processed');
    const r = panelRoot.querySelector('#ic-stat-removed');
    const s = panelRoot.querySelector('#ic-stat-skipped');
    if (p) p.textContent = state.stats.processed;
    if (r) r.textContent = state.stats.removed;
    if (s) s.textContent = state.stats.skipped;
  }

  function updatePanelLog() {
    if (!panelRoot) return;
    const logEl = panelRoot.querySelector('#ic-log');
    if (!logEl) return;
    if (state.logs.length === 0) {
      logEl.innerHTML = '<div class="ic-log-empty">No activity yet.</div>';
      return;
    }
    const last40 = state.logs.slice(-40);
    logEl.innerHTML = last40.map(entry => {
      let cls = 'ic-log-entry';
      if (entry.includes('✓') || entry.includes('Done') || entry.includes('Removed')) cls += ' success';
      else if (entry.includes('✗') || entry.includes('Error') || entry.includes('fail')) cls += ' error';
      else if (entry.includes('Skip') || entry.includes('⚠')) cls += ' warn';
      else if (entry.includes('→') || entry.includes('Start') || entry.includes('Sync')) cls += ' info';
      return `<div class="${cls}">${escapeHtml(entry)}</div>`;
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  function escapeHtml(str) {
    const d = document.createElement('span');
    d.textContent = str;
    return d.innerHTML;
  }

  /** Add a single log entry to the panel without full re-render */
  function panelLog(msg) {
    log(msg); // This also calls persistProgress which calls updatePanelStats/updatePanelLog
  }

  async function refreshPanelState() {
    if (!panelRoot) return;
    const stored = await safeStorageGet(['excludeFriends', 'friendsList', 'cleanerProgress']);
    const excludeInput = panelRoot.querySelector('#ic-exclude');
    excludeInput.checked = !!stored.excludeFriends;
    toggleSyncUI(!!stored.excludeFriends);

    const syncInfo = panelRoot.querySelector('#ic-sync-info');
    if (stored.friendsList && stored.friendsList.length > 0) {
      syncInfo.textContent = `${stored.friendsList.length} friends synced.`;
    }

    if (stored.cleanerProgress && stored.cleanerProgress.isRunning) {
      showProgress(true);
      setActionButtons(true);
    }

    if (stored.cleanerProgress && stored.cleanerProgress.logs) {
      state.logs = stored.cleanerProgress.logs;
      updatePanelLog();
    }
  }

  function setPanelMinimised(minimised) {
    panelMinimised = minimised;
    if (minimised) {
      panelEl.classList.add('ic-hidden');
      fabEl.classList.remove('ic-hidden');
    } else {
      panelEl.classList.remove('ic-hidden');
      fabEl.classList.add('ic-hidden');
    }
    safeStorageSet({ panelState: { minimised, hidden: false } });
  }

  function togglePanel() {
    if (!panelRoot) {
      injectPanel();
      panelVisible = true;
      setPanelMinimised(false);
      return;
    }
    if (panelRoot.style.display === 'none') {
      panelRoot.style.display = '';
      panelVisible = true;
      setPanelMinimised(false);
      refreshPanelState();
    } else if (!panelMinimised) {
      setPanelMinimised(true);
    } else {
      setPanelMinimised(false);
      refreshPanelState();
    }
  }

  // ─── DOM Helpers ───────────────────────────────

  /**
   * Walk up from `el` to find a clickable ancestor.
   */
  function closestClickable(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (
        cur.tagName === 'BUTTON' ||
        cur.tagName === 'A' ||
        cur.getAttribute('role') === 'button' ||
        cur.getAttribute('tabindex') != null
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return el;
  }

  /**
   * Find ALL elements matching `selector` whose **visible text**
   * exactly or partially matches `text` (case-insensitive).
   */
  function queryByText(text, { selector = '*', parent = document, exact = false } = {}) {
    const lc = text.toLowerCase();
    const els = parent.querySelectorAll(selector);
    return Array.from(els).filter((el) => {
      const t = el.textContent.trim().toLowerCase();
      return exact ? t === lc : t.includes(lc);
    });
  }

  /**
   * Find a **clickable** element by visible text.  Scans buttons first,
   * then role="button", then generic spans (Instagram wraps a lot in spans).
   */
  function findClickable(text, parent = document) {
    const selectors = ['button', '[role="button"]', '[role="menuitem"]', 'a', 'span', 'div'];
    const lc = text.toLowerCase();
    // Build a regex that matches the text as a whole word (not as a substring)
    const escaped = lc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRe = new RegExp(`^${escaped}$|\\b${escaped}\\b`, 'i');

    for (const sel of selectors) {
      const els = parent.querySelectorAll(sel);
      for (const el of els) {
        // Skip our own panel elements
        if (el.closest('#instaclean-root')) continue;
        // Only match on the element's *own* text to avoid matching huge
        // containers that happen to include the word.
        const own = ownText(el).toLowerCase().trim();
        // Exact match or word-boundary match only (prevents "sil" matching "silivrianlik")
        if (own === lc || (own.length < lc.length + 15 && wordRe.test(own))) {
          return el;
        }
      }
    }
    return null;
  }

  /** Shallow text: text nodes that are direct children. */
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        t += n.textContent;
      } else if (n.nodeType === Node.ELEMENT_NODE && n.children.length === 0) {
        t += n.textContent;
      }
    }
    return t.trim();
  }

  /**
   * Wait for an element to appear.
   * `finder` is a selector string or a function that returns an element.
   */
  function waitFor(finder, timeout = 12000) {
    return new Promise((resolve) => {
      const check = () =>
        typeof finder === 'function' ? finder() : document.querySelector(finder);

      const existing = check();
      if (existing) return resolve(existing);

      const iv = setInterval(() => {
        const el = check();
        if (el) {
          clearInterval(iv);
          clearTimeout(tm);
          resolve(el);
        }
      }, 400);

      const tm = setTimeout(() => {
        clearInterval(iv);
        resolve(null);
      }, timeout);
    });
  }

  // ─── Instagram DOM Selectors ───────────────────
  // Instagram uses the "Bloks" rendering framework on activity pages.
  // Class names are obfuscated, so we rely on structural/semantic cues.

  /**
   * Locate the activity items container.
   * On likes pages this is typically the grid inside <article>.
   * On comments pages it's a list inside <article>.
   */
  function getItemsContainer() {
    return document.querySelector('section[role="main"] article') ||
           document.querySelector('article') ||
           document.querySelector('section[role="main"]');
  }

  /**
   * Return individual selectable items on the activity page.
   *
   * After clicking "Select", Instagram shows checkboxes next to each item.
   * We use multiple strategies to find them because the DOM varies:
   *
   * 1. role="checkbox"  (most reliable)
   * 2. input[type="checkbox"]
   * 3. Clickable divs/spans that contain SVG check circles
   * 4. Fallback: all direct children of the grid/list container
   *    that look like activity items (contain images or text + links)
   */
  function getSelectableItems() {
    const container = getItemsContainer();
    if (!container) {
      log('DEBUG: No items container found on page.');
      return [];
    }

    // Strategy 1: data-testid="bulk_action_checkbox"
    let checkboxes = container.querySelectorAll('[data-testid="bulk_action_checkbox"]');
    if (checkboxes.length > 0) {
      log(`DEBUG: Found ${checkboxes.length} items via data-testid=bulk_action_checkbox`);
      return Array.from(checkboxes).map((cb) => {
        // The clickable button is inside the checkbox container
        const clickable = cb.querySelector('[role="button"], button, [tabindex]') || cb;
        const wrapper = findItemWrapper(cb);
        return { checkbox: clickable, wrapper };
      });
    }

    // Strategy 2: role="checkbox"
    checkboxes = container.querySelectorAll('[role="checkbox"]');
    if (checkboxes.length > 0) {
      log(`DEBUG: Found ${checkboxes.length} items via role=checkbox`);
      return Array.from(checkboxes).map((cb) => {
        // Walk up to find the full item row/card
        const wrapper = findItemWrapper(cb);
        return { checkbox: cb, wrapper };
      });
    }

    // Strategy 3: input[type="checkbox"]
    checkboxes = container.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length > 0) {
      log(`DEBUG: Found ${checkboxes.length} items via input checkbox`);
      return Array.from(checkboxes).map((cb) => {
        const wrapper = findItemWrapper(cb);
        return { checkbox: cb, wrapper };
      });
    }

    // Strategy 3: SVGs with circle (unchecked state indicator)
    // Instagram renders an empty circle SVG for each selectable item
    const svgs = container.querySelectorAll('svg');
    const checkSvgs = Array.from(svgs).filter(svg => {
      return svg.querySelector('circle') && !svg.closest('#instaclean-root');
    });
    if (checkSvgs.length > 0) {
      log(`DEBUG: Found ${checkSvgs.length} items via SVG circles`);
      return checkSvgs.map(svg => {
        const clickable = closestClickable(svg);
        const wrapper = findItemWrapper(svg);
        return { checkbox: clickable, wrapper };
      });
    }

    // Strategy 4: Look for clickable items that appeared after "Select"
    // In select mode, each grid item or list row becomes clickable.
    // Find all elements that have both an image/text AND a clickable behavior.
    const allClickables = container.querySelectorAll(
      '[role="button"], [tabindex], button'
    );
    const items = Array.from(allClickables).filter(el => {
      // Must contain meaningful content (image or profile link)
      const hasImg = el.querySelector('img');
      const hasLink = el.querySelector('a[href]');
      // Must not be a nav element, the select button itself, etc.
      const text = el.textContent.trim().toLowerCase();
      const isControl = text === 'select' || text === 'deselect all' ||
                        text === 'unlike' || text === 'delete';
      return (hasImg || hasLink) && !isControl && !el.closest('#instaclean-root');
    });

    if (items.length > 0) {
      log(`DEBUG: Found ${items.length} items via clickable elements`);
      return items.map(el => ({ checkbox: el, wrapper: el }));
    }

    log(`DEBUG: No selectable items found. Container HTML preview: ${container.innerHTML.substring(0, 300)}`);
    return [];
  }

  /**
   * Walk up from a checkbox/SVG to find the full item wrapper.
   * The wrapper should contain the username link + image/text.
   */
  function findItemWrapper(el) {
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 10) {
      // A good wrapper typically contains a profile link OR bold username span
      const hasLink = cur.querySelector && cur.querySelector('a[href^="/"]');
      const hasBoldSpan = cur.querySelector && cur.querySelector('span[style*="font-weight"]');
      if ((hasLink || hasBoldSpan) && cur.offsetHeight > 30) {
        return cur;
      }
      cur = cur.parentElement;
      depth++;
    }
    // Fallback: go up several levels from the checkbox
    let fb = el;
    for (let i = 0; i < 5 && fb && fb.parentElement; i++) fb = fb.parentElement;
    return fb || el;
  }

  /**
   * Extract the *post author's username* from an activity item wrapper.
   * Instagram embeds profile links as <a href="/{username}/">.
   *
   * IMPORTANT: On the comments page, the checkbox lives inside YOUR comment row,
   * which only has YOUR username link. The POST AUTHOR's link is in a sibling/
   * ancestor row. findItemWrapper() stops at your comment row because it already
   * has an <a href>. So we must walk UP from the wrapper to find the post author.
   */
  function extractUsername(wrapper) {
    if (!wrapper) return null;

    // Ensure we know our own username
    if (!state.ownUsername) {
      state.ownUsername = detectOwnUsername();
    }
    const ownLc = state.ownUsername ? state.ownUsername.toLowerCase() : null;

    /**
     * Collect profile-link usernames from <a href="/username/"> links.
     */
    function collectLinkUsernames(el) {
      const result = [];
      const links = el.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href) continue;
        const m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (m && !NON_PROFILE_PATHS.has(m[1]) && m[1].length > 1) {
          result.push(m[1]);
        }
      }
      return result;
    }

    /**
     * Collect usernames from bold text spans.
     * Instagram renders post author names as bold TextSpan elements
     * (font-weight 700) without wrapping them in <a> links.
     */
    function collectSpanUsernames(el) {
      const result = [];
      // Look for bold spans (font-weight 600 or 700) — typical for usernames
      const spans = el.querySelectorAll('span');
      for (const span of spans) {
        const style = span.style;
        const fw = style && style.fontWeight;
        // Also check computed style for class-based bold
        const isBold = fw === '700' || fw === '600' || fw === 'bold';
        if (!isBold) continue;
        const text = span.textContent.trim();
        if (text.length < 2 || text.length > 30) continue;
        // Username pattern: alphanumeric, dots, underscores
        const m = text.match(/^@?([a-zA-Z0-9._]{1,30})$/);
        if (m && !NON_PROFILE_PATHS.has(m[1]) && m[1].length > 1) {
          result.push(m[1]);
        }
      }
      return result;
    }

    /**
     * Collect all usernames (both links and bold text spans) from an element.
     */
    function collectAllUsernames(el) {
      const fromLinks = collectLinkUsernames(el);
      const fromSpans = collectSpanUsernames(el);
      // Deduplicate, prefer link-based
      const seen = new Set(fromLinks.map(u => u.toLowerCase()));
      const combined = [...fromLinks];
      for (const s of fromSpans) {
        if (!seen.has(s.toLowerCase())) {
          seen.add(s.toLowerCase());
          combined.push(s);
        }
      }
      return combined;
    }

    // 1. Collect from the wrapper itself (both links and bold spans)
    let candidates = collectAllUsernames(wrapper);

    // 2. Filter out our own username
    let others = candidates.filter(u => u.toLowerCase() !== ownLc);

    log(`DEBUG extractUsername: wrapper candidates=[${candidates}], others=[${others}], ownLc=${ownLc}`);

    // 3. If only our own username found (or none), walk UP the DOM
    //    to find the post author in a parent/sibling element.
    //    On comments pages the structure is:
    //      <div class="wbloks_1"> (group)
    //        <div> (post author row)  ← has username as bold span or <a> link
    //        <div> (your comment row) ← checkbox lives here
    if (others.length === 0) {
      let ancestor = wrapper.parentElement;
      let depth = 0;
      while (ancestor && ancestor !== document.body && depth < 10) {
        const ancestorCandidates = collectAllUsernames(ancestor);
        const ancestorOthers = ancestorCandidates.filter(u => u.toLowerCase() !== ownLc);
        if (ancestorOthers.length > 0) {
          log(`DEBUG extractUsername: found [${ancestorOthers}] at ancestor depth ${depth}`);
          others = ancestorOthers;
          break;
        }
        ancestor = ancestor.parentElement;
        depth++;
      }
    }

    const result = others.length > 0 ? others[0] : (candidates[0] || null);
    log(`DEBUG extractUsername: result=${result}`);
    return result;
  }

  /**
   * Click a checkbox-like element (toggle its selected state).
   */
  function clickCheckbox(item) {
    const el = item.checkbox;
    if (!el) return false;
    el.click();
    return true;
  }

  /**
   * Is the checkbox already checked?
   *
   * IMPORTANT: We only use reliable indicators here.
   * The previous SVG-path heuristic was causing false positives
   * (matching any SVG path as a "checkmark"), which made the
   * code think unchecked items were checked → skip → toggle wrong items.
   */
  function isChecked(item) {
    const el = item.checkbox;
    if (!el) return false;

    // 1. aria-checked (most reliable — Instagram uses this for role="checkbox")
    if (el.getAttribute('aria-checked') === 'true') return true;
    if (el.getAttribute('aria-checked') === 'false') return false;

    // 2. native checkbox
    if (el.tagName === 'INPUT' && el.type === 'checkbox') return el.checked;

    // 3. Check for a BLUE/coloured filled circle — Instagram uses a blue circle
    //    for the selected state. We specifically check for blue-ish fills.
    const svgs = el.querySelectorAll('svg');
    for (const svg of svgs) {
      const circles = svg.querySelectorAll('circle');
      for (const c of circles) {
        const fill = c.getAttribute('fill') || '';
        // Blue fills: #0095f6, rgb(0,149,246), or url(#gradient)
        if (/^#[0-9a-f]{6}$/i.test(fill) && fill.toLowerCase() !== '#ffffff' &&
            fill.toLowerCase() !== '#000000' && fill !== 'none') {
          return true;
        }
        if (fill.startsWith('rgb') && !fill.includes('255, 255, 255') &&
            !fill.includes('0, 0, 0') && fill !== 'none') {
          return true;
        }
      }
    }

    // 4. CSS class or data attribute heuristics
    if (el.classList.contains('selected') || el.dataset.selected === 'true') return true;

    // Default: assume NOT checked — safer to re-click than to skip
    return false;
  }

  /**
   * Scroll to top of page to ensure Select button is visible.
   */
  async function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    document.documentElement.scrollTop = 0;
    const container = getItemsContainer();
    if (container) {
      const scrollTarget = findScrollableChild(container);
      if (scrollTarget && scrollTarget !== document.documentElement) {
        scrollTarget.scrollTop = 0;
      }
    }
    await delay(800);
  }

  /**
   * Scroll the activity page to load more items.
   * Returns true if new content appeared.
   *
   * Instagram uses IntersectionObserver on a loading sentinel to trigger
   * lazy-loading. Simple window.scrollTo() often fails to trigger it.
   * We combine multiple strategies:
   *   1. Scroll the loading spinner/sentinel into view (most reliable)
   *   2. Dispatch synthetic wheel events to mimic real user scrolling
   *   3. Incremental scrolling to give observers time to fire
   *   4. Fallback: scroll inner containers as well
   */
  async function scrollForMore() {
    const container = getItemsContainer();
    const scrollTarget = container ? findScrollableChild(container) : null;

    const prevHeight = document.documentElement.scrollHeight;
    const prevItems = container ? container.querySelectorAll('a[href]').length : 0;

    // Strategy 1: Find the loading sentinel / spinner and scroll it into view.
    // Instagram places a small loading indicator at the end of the list.
    const sentinel = findLoadingSentinel();
    if (sentinel) {
      sentinel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(800);
    }

    // Strategy 2: Incremental scroll – scroll down in steps instead of jumping
    // to the very bottom. This gives IntersectionObserver time to fire.
    const scrollEl = scrollTarget && scrollTarget !== document.documentElement
      ? scrollTarget : document.documentElement;
    const step = Math.max(300, Math.floor(window.innerHeight * 0.7));
    for (let i = 0; i < 3; i++) {
      scrollEl.scrollTop += step;
      window.scrollBy({ top: step, behavior: 'smooth' });
      await delay(400);
    }

    // Strategy 3: Dispatch synthetic wheel events on the scroll container.
    // Instagram's scroll listeners may rely on wheel events.
    const wheelTarget = scrollTarget && scrollTarget !== document.documentElement
      ? scrollTarget : document;
    for (let i = 0; i < 3; i++) {
      wheelTarget.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 300 + Math.random() * 200,
        bubbles: true,
        cancelable: true,
      }));
      await delay(200);
    }

    // Also fire a generic scroll event on both window and container
    window.dispatchEvent(new Event('scroll', { bubbles: true }));
    if (scrollTarget && scrollTarget !== document.documentElement) {
      scrollTarget.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    // Final push: scroll all the way to the bottom
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    if (scrollTarget && scrollTarget !== document.documentElement) {
      scrollTarget.scrollTop = scrollTarget.scrollHeight;
    }

    // Wait for Instagram to render new items
    await delay(3000);

    // Re-check the sentinel – scroll it into view again if still present
    const sentinel2 = findLoadingSentinel();
    if (sentinel2) {
      sentinel2.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(1500);
    }

    const newHeight = document.documentElement.scrollHeight;
    const newItems = container ? container.querySelectorAll('a[href]').length : 0;

    return newHeight > prevHeight || newItems > prevItems;
  }

  /**
   * Find Instagram's loading sentinel / spinner element at the bottom of the list.
   * This is the element that IntersectionObserver watches to trigger lazy loading.
   * It's typically an SVG spinner or a small empty div at the end of the content.
   */
  function findLoadingSentinel() {
    // Common patterns for Instagram's loading indicator:
    // 1. SVG spinner (animated circle)
    const spinners = document.querySelectorAll('svg[aria-label]');
    for (const svg of spinners) {
      if (svg.closest('#instaclean-root')) continue;
      const label = (svg.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('loading') || label.includes('yükleniyor') ||
          label.includes('cargando') || label.includes('chargement') ||
          label.includes('laden') || label.includes('caricamento') ||
          label.includes('carregando') || label.includes('загрузка') ||
          label.includes('読み込み') || label.includes('加载') || label.includes('로드')) {
        return svg.closest('div') || svg;
      }
    }

    // 2. Any element with "loading" role
    const loadingEls = document.querySelectorAll('[role="progressbar"], [aria-busy="true"]');
    for (const el of loadingEls) {
      if (!el.closest('#instaclean-root') && el.offsetHeight > 0) {
        return el;
      }
    }

    // 3. Small container at the very end of the items container
    // (Instagram sometimes uses an empty div as sentinel)
    const container = getItemsContainer();
    if (container) {
      const lastChild = container.lastElementChild;
      if (lastChild && lastChild.offsetHeight < 80 && !lastChild.querySelector('img')) {
        return lastChild;
      }
    }

    return null;
  }

  /**
   * Find a button inside a dialog (confirmation/modal).
   */
  function findDialogButton(text) {
    const lc = text.toLowerCase();
    log(`DEBUG findDialogButton: looking for "${text}"…`);

    // Try role="dialog" first
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (const dialog of dialogs) {
      if (dialog.closest('#instaclean-root')) continue;
      const btn = findClickable(text, dialog);
      if (btn) {
        log(`DEBUG findDialogButton: found "${text}" in role=dialog`);
        return btn;
      }
      // Also try deep text search in dialog buttons/spans
      const allBtns = dialog.querySelectorAll('button, [role="button"], span, div');
      for (const el of allBtns) {
        if (el.closest('#instaclean-root')) continue;
        const elText = el.textContent.trim().toLowerCase();
        if (elText === lc && el.offsetHeight > 0) {
          log(`DEBUG findDialogButton: found "${text}" via deep text in dialog`);
          return el;
        }
      }
    }

    // Try looking for an overlay/modal by structure
    const overlays = document.querySelectorAll('[style*="position: fixed"], [style*="z-index"]');
    for (const o of overlays) {
      if (o.id === 'instaclean-root') continue;
      const btn = findClickable(text, o);
      if (btn) {
        log(`DEBUG findDialogButton: found "${text}" in overlay`);
        return btn;
      }
    }

    // Last resort: search entire document for a button with exact text match
    // This handles cases where the dialog doesn't have role="dialog"
    const allButtons = document.querySelectorAll('button, [role="button"]');
    for (const btn of allButtons) {
      if (btn.closest('#instaclean-root')) continue;
      const btnText = btn.textContent.trim().toLowerCase();
      if (btnText === lc && btn.offsetHeight > 0) {
        log(`DEBUG findDialogButton: found "${text}" via full document scan`);
        return btn;
      }
    }

    log(`DEBUG findDialogButton: "${text}" NOT found. Visible dialogs: ${dialogs.length}`);
    return null;
  }

  /**
   * Detect and dismiss Instagram error dialogs.
   * Instagram shows an error when you try to delete too many items at once.
   * The dialog contains an "OK" button that we need to click to dismiss it.
   * Returns true if an error dialog was found and dismissed.
   */
  async function handleErrorDialog() {
    // Try multiple times with short delays - dialog may appear with slight delay
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await delay(500);
      
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      log(`DEBUG handleErrorDialog: Found ${dialogs.length} dialog(s), attempt ${attempt + 1}`);
      
      for (const dialog of dialogs) {
        if (dialog.closest('#instaclean-root')) continue;
        if (dialog.offsetHeight === 0) continue; // Skip hidden dialogs
        
        const dialogText = dialog.textContent.toLowerCase();
        log(`DEBUG dialog content: "${dialogText.substring(0, 80).replace(/\s+/g, ' ')}"`);
        
        // Detect error keywords in any language
        const errorKeywords = [
          'bir sorun oluştu',   // Turkish "a problem occurred"
          'sorun oluştu',       // Turkish shortened
          'silerken',           // Turkish "while deleting"
          'tekrar silmeyi',     // Turkish "try deleting again"
          'an error occurred',  // English
          'something went wrong', // English alt
          'error',
          'problem',
          'try again',
          'tekrar',             // Turkish "again"
          'ha ocurrido un error', // Spanish
          'une erreur',         // French
          'ein fehler',         // German
        ];
        const isError = errorKeywords.some(kw => dialogText.includes(kw));
        
        if (isError) {
          log(`⚠ Error dialog detected!`);
          
          // Find all buttons in the dialog
          const allButtons = dialog.querySelectorAll('button');
          log(`DEBUG: Found ${allButtons.length} button(s) in dialog`);
          
          // Click the first visible button (should be OK)
          for (const btn of allButtons) {
            if (btn.offsetHeight > 0 && btn.offsetWidth > 0) {
              const btnText = btn.textContent.trim();
              log(`Clicking button: "${btnText}"`);
              btn.click();
              await delay(1000);
              return true;
            }
          }
          
          // Try role="button" elements
          const roleButtons = dialog.querySelectorAll('[role="button"]');
          for (const btn of roleButtons) {
            if (btn.offsetHeight > 0 && btn.offsetWidth > 0) {
              const btnText = btn.textContent.trim();
              log(`Clicking role=button: "${btnText}"`);
              btn.click();
              await delay(1000);
              return true;
            }
          }
          
          // Try any clickable element with OK text
          const allElements = dialog.querySelectorAll('*');
          for (const el of allElements) {
            const text = el.textContent.trim().toUpperCase();
            if ((text === 'OK' || text === 'TAMAM') && el.offsetHeight > 0) {
              log(`Clicking element with OK text`);
              el.click();
              await delay(1000);
              return true;
            }
          }
          
          log('Could not find OK button in error dialog');
          return true; // error detected but couldn't dismiss
        }
      }
    }
    
    // Fallback: try broader search if role="dialog" didn't find anything
    return await dismissAnyErrorPopup();
  }

  /**
   * Broader search for error popups that might not have role="dialog".
   * Searches for error text anywhere in the DOM and clicks the OK button.
   */
  async function dismissAnyErrorPopup() {
    // Search for elements containing error text
    const errorTexts = [
      'bir sorun oluştu',
      'sorun oluştu', 
      'silerken',
      'tekrar silmeyi',
      'an error occurred',
      'something went wrong',
    ];
    
    // Find all h3, span, div that might contain error text
    const candidates = document.querySelectorAll('h3, span, div, p');
    
    for (const el of candidates) {
      if (el.closest('#instaclean-root')) continue;
      if (el.offsetHeight === 0) continue;
      
      const text = el.textContent.toLowerCase();
      const hasError = errorTexts.some(err => text.includes(err));
      
      if (hasError) {
        log(`Found error text in element: "${text.substring(0, 50)}"`);
        
        // Find the modal container by walking up the DOM
        let container = el;
        for (let i = 0; i < 10; i++) {
          if (!container.parentElement) break;
          container = container.parentElement;
          
          // Look for OK button within this container
          const buttons = container.querySelectorAll('button');
          for (const btn of buttons) {
            const btnText = btn.textContent.trim().toUpperCase();
            if ((btnText === 'OK' || btnText === 'TAMAM') && btn.offsetHeight > 0) {
              log(`Clicking OK button in error popup`);
              btn.click();
              await delay(1000);
              return true;
            }
          }
        }
        
        // If no OK button found, try clicking any button near the error
        const nearbyButtons = document.querySelectorAll('button');
        for (const btn of nearbyButtons) {
          if (btn.closest('#instaclean-root')) continue;
          const btnText = btn.textContent.trim().toUpperCase();
          if ((btnText === 'OK' || btnText === 'TAMAM') && btn.offsetHeight > 0) {
            log(`Clicking OK button found in document`);
            btn.click();
            await delay(1000);
            return true;
          }
        }
        
        return false; // found error but couldn't dismiss
      }
    }
    
    return false;
  }

  // ─── Sync Friends List ─────────────────────────

  /**
   * Collect the logged-in user's following or followers list by opening
   * the respective dialog on the profile page, scrolling through it,
   * and gathering usernames.
   *
   * @param {'following'|'followers'} type
   */
  async function syncFriendsList(type) {
    state.running = true;
    state.action = `sync-${type}`;
    resetStats();
    log(`→ Starting ${type} sync…`);

    // Show progress UI (needed when resuming from pendingAction too)
    showProgress(true);
    setActionButtons(true);

    try {
      // Step 1 – navigate to own profile if needed
      if (!isOnOwnProfile()) {
        const username = detectOwnUsername();
        if (username) {
          log(`Navigating to your profile (/${username}/)…`);
          await safeStorageSet({
            pendingAction: { type: `sync-${type}` },
          });
          window.location.href = `https://www.instagram.com/${username}/`;
          return; // Content script will re-run on the new page
        } else {
          log(`✗ Could not detect your username. Navigate to your profile manually and retry.`);
          state.running = false;
          persistProgress();
          return;
        }
      }

      await delay(2000);

      // Step 2 – click the Following / Followers link on the profile
      const linkEl = await waitFor(() => {
        // Look for an <a> whose href ends with /following/ or /followers/
        const anchors = document.querySelectorAll(`a[href$="/${type}/"]`);
        if (anchors.length) return anchors[0];
        // Fallback: find by text
        return findClickable(type);
      }, 8000);

      if (!linkEl) {
        log(`✗ Could not find "${type}" link on profile page.`);
        state.running = false;
        persistProgress();
        return;
      }

      linkEl.click();
      await delay(3000);

      // Step 3 – dialog should now be open
      const dialog = await waitFor('[role="dialog"]', 8000);
      if (!dialog) {
        log('✗ Following/Followers dialog did not open.');
        state.running = false;
        persistProgress();
        return;
      }

      // Step 4 – scroll & collect
      const usernames = new Set();
      let noNewCount = 0;

      // Find the scrollable element inside the dialog
      const scrollBox = findScrollableChild(dialog);

      while (state.running && noNewCount < 5) {
        const links = dialog.querySelectorAll('a[href]');
        let added = 0;
        for (const link of links) {
          const href = link.getAttribute('href');
          if (!href) continue;
          const m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
          if (m && !NON_PROFILE_PATHS.has(m[1]) && m[1].length > 1) {
            if (!usernames.has(m[1])) {
              usernames.add(m[1]);
              added++;
            }
          }
        }

        log(`Collected ${usernames.size} ${type} so far…`);
        state.stats.processed = usernames.size;
        persistProgress();

        if (added === 0) {
          noNewCount++;
        } else {
          noNewCount = 0;
        }

        // Scroll
        if (scrollBox) {
          scrollBox.scrollTop = scrollBox.scrollHeight;
        }
        await delay(1500 + Math.random() * 1000);
      }

      // Step 5 – merge with existing friends list & store
      const stored = await safeStorageGet('friendsList');
      const existing = new Set(stored.friendsList || []);
      for (const u of usernames) existing.add(u);
      const merged = Array.from(existing);
      await safeStorageSet({ friendsList: merged });

      log(`✓ Synced ${usernames.size} ${type}. Total friends: ${merged.length}`);

      // Close dialog
      const closeBtn = dialog.querySelector('[aria-label="Close"]') ||
                        findLocalizedClickable('close', dialog);
      if (closeBtn) closeBtn.click();

    } catch (err) {
      log(`✗ Error during sync: ${err.message}`);
    }

    state.running = false;
    showProgress(false);
    setActionButtons(false);
    persistProgress();
  }

  function findScrollableChild(parent) {
    // Walk children looking for one with overflow scroll/auto
    const children = parent.querySelectorAll('*');
    for (const c of children) {
      const style = getComputedStyle(c);
      if (
        (style.overflowY === 'scroll' || style.overflowY === 'auto') &&
        c.scrollHeight > c.clientHeight + 10
      ) {
        return c;
      }
    }
    return parent;
  }

  function isOnOwnProfile() {
    // Heuristic: profile pages have /{username}/ URL and contain profile indicators
    const path = window.location.pathname;
    if (!/^\/[a-zA-Z0-9._]+\/?$/.test(path)) return false;
    // Confirm it's a profile page by checking for following/followers links
    const hasProfileLinks = document.querySelector('a[href$="/following/"], a[href$="/followers/"]');
    return !!hasProfileLinks;
  }

  /**
   * Detect the logged-in user's username from the page.
   * Strategy 1: Look for the profile link in the sidebar navigation.
   * Strategy 2: Look for meta tags or other indicators.
   */
  function detectOwnUsername() {
    // Strategy 1: Instagram sidebar nav has a "Profile" link with the user's
    // avatar pointing to /{username}/
    const navSelectors = ['nav', '[role="navigation"]'];
    for (const sel of navSelectors) {
      const navs = document.querySelectorAll(sel);
      for (const nav of navs) {
        const links = nav.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.getAttribute('href');
          if (!href) continue;
          const m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
          if (m && !NON_PROFILE_PATHS.has(m[1]) && m[1].length > 1) {
            // Prefer links with a visual (avatar image) – that's the profile link
            const hasVisual = link.querySelector('img, [role="img"], canvas');
            if (hasVisual) return m[1];
          }
        }
      }
    }

    // Strategy 2: any element with aria-label="Profile"
    const profileLinks = document.querySelectorAll('a[aria-label="Profile"]');
    for (const a of profileLinks) {
      const href = a.getAttribute('href');
      if (href) {
        const m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (m && !NON_PROFILE_PATHS.has(m[1])) return m[1];
      }
    }

    // Strategy 3: look for any span with text matching common nav patterns
    // Instagram puts the username in the "More" menu and other places
    const all = document.querySelectorAll('a[href]');
    for (const a of all) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (m && !NON_PROFILE_PATHS.has(m[1]) && m[1].length > 1) {
        const hasAvatar = a.querySelector('img[alt]');
        if (hasAvatar) return m[1];
      }
    }

    // Strategy 4: if on a profile page, extract from URL
    const pathMatch = window.location.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);
    if (pathMatch && !NON_PROFILE_PATHS.has(pathMatch[1])) {
      return pathMatch[1];
    }

    return null;
  }

  // ─── Remove Likes ─────────────────────────────

  async function removeLikes(excludeFriends) {
    state.running = true;
    state.action = 'removeLikes';
    resetStats();
    log('→ Starting likes removal…');

    // Show progress UI (needed when resuming from pendingAction too)
    showProgress(true);
    setActionButtons(true);

    // Detect own username early
    if (!state.ownUsername) state.ownUsername = detectOwnUsername();
    if (state.ownUsername) log(`Logged in as: @${state.ownUsername}`);

    // Friend exclusion is not supported for likes (no usernames visible on grid)
    if (excludeFriends) {
      log('ℹ Friend exclusion is only available for comments. Removing all likes.');
    }

    // Navigate to likes activity page if needed
    if (!window.location.href.includes('/your_activity/interactions/likes')) {
      log('Navigating to likes activity page…');
      await safeStorageSet({
        pendingAction: { type: 'removeLikes', excludeFriends: false },
      });
      window.location.href = URLS.likes;
      return; // Content script will re-run on the new page
    }

    await delay(2000);
    await processActivityPage('Unlike', false);

    log(`✓ Done! Removed ${state.stats.removed} likes. Skipped ${state.stats.skipped}.`);
    state.running = false;
    showProgress(false);
    setActionButtons(false);
    persistProgress();
  }

  // ─── Remove Comments ──────────────────────────

  async function removeComments(excludeFriends) {
    state.running = true;
    state.action = 'removeComments';
    resetStats();
    log('→ Starting comments removal…');

    // Show progress UI (needed when resuming from pendingAction too)
    showProgress(true);
    setActionButtons(true);

    // Detect own username early
    if (!state.ownUsername) state.ownUsername = detectOwnUsername();
    if (state.ownUsername) log(`Logged in as: @${state.ownUsername}`);

    if (excludeFriends) {
      const stored = await safeStorageGet('friendsList');
      state.friendsList = new Set(stored.friendsList || []);
      log(`Loaded ${state.friendsList.size} friends for exclusion.`);
    }

    if (!window.location.href.includes('/your_activity/interactions/comments')) {
      log('Navigating to comments activity page…');
      await safeStorageSet({
        pendingAction: { type: 'removeComments', excludeFriends },
      });
      window.location.href = URLS.comments;
      return;
    }

    await delay(2000);
    await processActivityPage('Delete', excludeFriends);

    log(`✓ Done! Removed ${state.stats.removed} comments. Skipped ${state.stats.skipped}.`);
    state.running = false;
    showProgress(false);
    setActionButtons(false);
    persistProgress();
  }

  // ─── Core Activity Processing ─────────────────

  /**
   * Generic processor for the likes/comments activity pages.
   *
   * @param {'Unlike'|'Delete'} actionText – the label on the action button
   * @param {boolean} excludeFriends
   */
  async function processActivityPage(actionText, excludeFriends) {
    let rounds = 0;
    const maxRounds = 200; // safety limit
    let consecutiveFailures = 0;

    // Debug: log the current page info
    log(`On page: ${window.location.href}`);

    while (state.running && rounds < maxRounds) {
      rounds++;
      log(`─── Round ${rounds} ───`);

      // 0 ─ Check for any lingering error dialogs from previous operations
      const errorAtStart = await handleErrorDialog();
      if (errorAtStart) {
        log('Dismissed lingering error dialog. Continuing…');
        await delay(2000);
      }

      // Re-check container each round (DOM may have changed after deletion)
      const container = getItemsContainer();
      if (!container) {
        log('✗ Cannot find the activity content container on this page.');
        log('Waiting for page to settle…');
        await delay(3000);
        const retryContainer = getItemsContainer();
        if (!retryContainer) {
          log('Still no container. Page may need a refresh.');
          // Reload the page and resume via pendingAction
          await safeStorageSet({
            pendingAction: { type: actionText === 'Unlike' ? 'removeLikes' : 'removeComments', excludeFriends },
          });
          window.location.reload();
          return;
        }
      }

      // 1 ─ Enter select mode
      const selectBtn = await waitFor(() => findLocalizedClickable('select'), 10000);

      if (!selectBtn) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          log('Could not find "Select" button after multiple attempts – stopping.');
          break;
        }
        log(`Could not find "Select" button (attempt ${consecutiveFailures}/3). Scrolling to top and retrying…`);
        // The Select button is at the top – scroll up first, then down for more items
        await scrollToTop();
        await delay(1000);
        await scrollForMore();
        await scrollToTop();
        await delay(2000);
        continue;
      }

      consecutiveFailures = 0;
      // Scroll the Select button into view before clicking
      selectBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(300);
      log(`Found "Select" button. Clicking…`);
      selectBtn.click();
      await humanDelay(1200, 2000);

      // 2 ─ Get selectable items
      const items = getSelectableItems();
      if (items.length === 0) {
        log('No selectable items found after entering select mode.');
        
        // Check if an error dialog is blocking (use broad search)
        const errorDismissed = await dismissAnyErrorPopup();
        if (errorDismissed) {
          log('Error popup was blocking - dismissed it. Retrying round…');
          await delay(2000);
          continue;
        }
        
        log('Scrolling for more…');
        // Exit select mode first
        const cancelBtn = findLocalizedClickable('deselectAll') ||
                          findLocalizedClickable('cancel');
        if (cancelBtn) cancelBtn.click();
        await humanDelay();

        const more = await scrollForMore();
        if (!more) {
          log('No more items to load. All done!');
          break;
        }
        // Scroll back to top so Select button is visible
        await scrollToTop();
        continue;
      }

      log(`Found ${items.length} items on page.`);

      // 3 ─ Select items (skip friends if needed)
      let selectedCount = 0;

      if (excludeFriends) {
        log(`Friends exclusion is ON (${state.friendsList.size} friends loaded)`);
      } else {
        log('Friends exclusion is OFF – removing all items.');
      }

      for (const item of items) {
        if (!state.running) break;
        if (selectedCount >= BATCH_SIZE) {
          log(`Reached batch limit (${BATCH_SIZE}) – will process remaining in next round.`);
          break;
        }

        state.stats.processed++;
        const username = extractUsername(item.wrapper);

        if (excludeFriends && username && state.friendsList.has(username)) {
          log(`⏭ Skipping @${username} (friend)`);
          state.stats.skipped++;
          continue;
        }

        const checked = isChecked(item);

        if (!checked) {
          clickCheckbox(item);
          selectedCount++;
          log(`✔ Selected item from @${username || 'unknown'}`);
          await delay(300 + Math.random() * 400);
        }
      }

      persistProgress();

      // Check if user stopped during selection
      if (!state.running) {
        log('Stopped by user during selection.');
        break;
      }

      if (selectedCount === 0) {
        log('All visible items belong to friends or are already checked – scrolling for more…');
        const cancelBtn = findLocalizedClickable('deselectAll') ||
                          findLocalizedClickable('cancel') ||
                          findLocalizedClickable('done');
        if (cancelBtn) cancelBtn.click();
        await humanDelay();

        const more = await scrollForMore();
        if (!more) {
          log('No more items to load. All done!');
          break;
        }
        // Scroll back to top so Select button is visible
        await scrollToTop();
        continue;
      }

      log(`Selected ${selectedCount} items. Looking for "${actionText}" button…`);

      // 4 ─ Click the action button (Unlike / Delete)
      await humanDelay(500, 1000);
      const actionKey = actionText === 'Unlike' ? 'unlike' : 'delete';
      const actionBtn = findLocalizedClickable(actionKey);
      if (!actionBtn) {
        log(`✗ Could not find "${actionText}" button (tried all languages).`);
        log('DEBUG: Listing visible buttons…');
        const allBtns = document.querySelectorAll('button, [role="button"]');
        const btnTexts = Array.from(allBtns)
          .filter(b => !b.closest('#instaclean-root'))
          .slice(0, 10)
          .map(b => `"${ownText(b).substring(0, 30)}"`);
        log(`DEBUG: Buttons found: ${btnTexts.join(', ')}`);
        break;
      }

      log(`Clicking "${actionText}" button…`);
      actionBtn.click();
      await humanDelay(1000, 2000);

      // 5 ─ Handle confirmation dialog
      await delay(1500);

      // Debug: log what's on screen
      const visibleDialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      log(`DEBUG: ${visibleDialogs.length} dialog(s) found after clicking action button`);
      if (visibleDialogs.length > 0) {
        for (const d of visibleDialogs) {
          if (d.closest('#instaclean-root')) continue;
          const dText = d.textContent.substring(0, 200).replace(/\s+/g, ' ');
          log(`DEBUG dialog text: "${dText}"`);
        }
      }

      let confirmBtn = findLocalizedDialogButton(actionKey) ||
                       findLocalizedDialogButton('confirm');

      if (!confirmBtn) {
        await delay(1000);
        confirmBtn = findLocalizedDialogButton(actionKey) ||
                     findLocalizedDialogButton('confirm');
      }

      if (confirmBtn) {
        confirmBtn.click();
        log(`Confirmed "${actionText}" for ${selectedCount} items.`);
        await humanDelay(1500, 2500);
      } else {
        log(`Action "${actionText}" executed (no confirmation dialog appeared).`);
        await humanDelay(1000, 1500);
      }

      // 5b ─ Check for error dialog (Instagram batch limit exceeded)
      // Wait a bit longer for error dialog to appear
      await delay(1500);
      const errorHandled = await handleErrorDialog();
      if (errorHandled) {
        log(`⚠ Instagram error detected – clicking OK and retrying.`);
        await delay(3000);
        continue;
      }

      state.stats.removed += selectedCount;
      persistProgress();
      log(`✓ Removed ${state.stats.removed} total so far.`);

      // 6 ─ Wait for page to update, then continue removing
      log('Waiting for page to refresh before next batch…');
      await delay(3000 + Math.random() * 2000);

      // Scroll to load any remaining items
      await scrollForMore();
      await delay(1000);

      // Scroll back to top so Select button is visible for next round
      await scrollToTop();
    }

    if (rounds >= maxRounds) {
      log(`Reached maximum round limit (${maxRounds}). Stopping as safety measure.`);
    }
  }

  // ─── Resume Pending Actions ────────────────────
  async function checkPendingAction() {
    const stored = await safeStorageGet('pendingAction');
    if (!stored.pendingAction) return;

    const { type, excludeFriends } = stored.pendingAction;
    await safeStorageRemove('pendingAction');

    log(`Resuming pending action: ${type}`);
    await delay(2500); // Let page settle

    if (type === 'removeLikes') {
      await removeLikes(excludeFriends);
    } else if (type === 'removeComments') {
      await removeComments(excludeFriends);
    } else if (type === 'sync-following') {
      await syncFriendsList('following');
    } else if (type === 'sync-followers') {
      await syncFriendsList('followers');
    }
  }

  // ─── Message Listener ─────────────────────────
  if (isContextValid()) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!isContextValid()) return;
      switch (msg.action) {
        case 'removeLikes':
          removeLikes(msg.excludeFriends);
          sendResponse({ ok: true });
          break;

        case 'removeComments':
          removeComments(msg.excludeFriends);
          sendResponse({ ok: true });
          break;

        case 'syncFollowing':
          syncFriendsList('following');
          sendResponse({ ok: true });
          break;

        case 'syncFollowers':
          syncFriendsList('followers');
          sendResponse({ ok: true });
          break;

        case 'stop':
          state.running = false;
          log('⏹ Stopped by user.');
          persistProgress();
          sendResponse({ ok: true });
          break;

        case 'togglePanel':
          togglePanel();
          sendResponse({ ok: true });
          break;

        case 'getStatus':
          sendResponse({
            isRunning: state.running,
            action: state.action,
            stats: { ...state.stats },
          });
          break;

        default:
          sendResponse({ ok: false, error: 'Unknown action' });
      }

      return true; // Keep channel open for async
    });
  }

  // ─── Boot ──────────────────────────────────────
  if (isContextValid()) {
    // Inject the floating panel
    injectPanel();
    // Check for pending actions when the page loads
    checkPendingAction();
  } else {
    handleContextInvalidated();
  }
})();
