/**
 * Heureum Browser Control - Background Service Worker
 *
 * Connects to the Electron client via WebSocket and executes browser commands.
 * User-initiated: click the toolbar icon to connect/disconnect.
 */

const WS_URL = 'ws://localhost:9222';

const BADGE = {
  on:         { text: 'ON',  color: '#22c55e' },
  off:        { text: '',    color: '#000000' },
  connecting: { text: '...', color: '#F59E0B' },
  error:      { text: '!',   color: '#B91C1C' },
};

/** @type {WebSocket|null} */
let ws = null;
/** @type {Promise<void>|null} */
let connectPromise = null;

// --- Badge ---

function setBadge(kind) {
  const cfg = BADGE[kind];
  void chrome.action.setBadgeText({ text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ color: cfg.color });
  void chrome.action.setBadgeTextColor({ color: '#FFFFFF' }).catch(() => {});
}

// --- WebSocket Connection ---

/**
 * Connect to the Electron WebSocket server.
 * Deduplicates concurrent calls via connectPromise.
 */
async function connectToRelay() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (connectPromise) return await connectPromise;

  connectPromise = doConnect();
  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

async function doConnect() {
  // Clean up stale socket
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }

  setBadge('connecting');
  void chrome.action.setTitle({
    title: 'Heureum: connecting to Electron client...',
  });

  const socket = new WebSocket(WS_URL);

  // Wait for connection with 5s timeout
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error('WebSocket connect timeout'));
    }, 5000);

    socket.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(t);
      reject(new Error('WebSocket connect failed'));
    };
    socket.onclose = (ev) => {
      clearTimeout(t);
      reject(new Error(`WebSocket closed (${ev.code})`));
    };
  });

  // Connection succeeded — set up handlers
  ws = socket;

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Handle ping/pong keepalive
    if (msg && msg.method === 'ping') {
      send({ method: 'pong' });
      return;
    }

    const { id, action, params } = msg;
    if (!id || !action) return;

    try {
      const result = await handleCommand(action, params || {});
      send({ id, success: true, result });
    } catch (err) {
      send({ id, success: false, error: err.message || String(err) });
    }
  };

  ws.onclose = () => {
    console.log('[Heureum] Disconnected from Electron client');
    ws = null;
    setBadge('error');
    void chrome.action.setTitle({
      title: 'Heureum: disconnected (click to reconnect)',
    });
  };

  ws.onerror = () => {
    // onclose will fire after this
  };

  console.log('[Heureum] Connected to Electron client');
  setBadge('on');
  void chrome.action.setTitle({
    title: 'Heureum: connected (click to disconnect)',
  });
}

function disconnect() {
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  setBadge('off');
  void chrome.action.setTitle({
    title: 'Heureum Browser Control (click to connect)',
  });
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// --- Toolbar Icon Click ---

chrome.action.onClicked.addListener(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    disconnect();
  } else {
    connectToRelay().catch((err) => {
      console.warn('[Heureum] Connection failed:', err.message);
      setBadge('error');
      void chrome.action.setTitle({
        title: 'Heureum: connection failed (click to retry)',
      });
    });
  }
});

// --- Command Handlers ---

async function handleCommand(action, params) {
  switch (action) {
    case 'navigate':
      return await handleNavigate(params);
    case 'new_tab':
      return await handleNewTab(params);
    case 'click':
      return await handleClick(params);
    case 'type':
      return await handleType(params);
    case 'get_content':
      return await handleGetContent(params);
    case 'get_tabs':
      return await handleGetTabs();
    case 'switch_tab':
      return await handleSwitchTab(params);
    case 'screenshot':
      return await handleScreenshot(params);
    case 'hover':
      return await handleHover(params);
    case 'select':
      return await handleSelect(params);
    case 'evaluate':
      return await handleEvaluate(params);
    case 'scroll':
      return await handleScroll(params);
    case 'key_press':
      return await handleKeyPress(params);
    case 'back':
      return await handleBack();
    case 'forward':
      return await handleForward();
    case 'reload':
      return await handleReload();
    case 'close_tab':
      return await handleCloseTab(params);
    case 'wait_for':
      return await handleWaitFor(params);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * Get the currently active tab.
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

/**
 * Wait for a tab to finish loading.
 */
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab loading timed out'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Extract page content from a tab by injecting the content script.
 */
async function extractContent(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });

  if (results && results[0] && results[0].result) {
    return results[0].result;
  }
  return 'Failed to extract page content';
}

// --- Action Handlers ---

async function handleNavigate({ url }) {
  if (!url) throw new Error('url parameter is required');

  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { url });
  await waitForTabComplete(tab.id);

  // Small delay for dynamic content
  await new Promise((r) => setTimeout(r, 500));

  const content = await extractContent(tab.id);
  return content;
}

async function handleNewTab({ url }) {
  if (!url) throw new Error('url parameter is required');

  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 500));

  const content = await extractContent(tab.id);
  return `Opened new tab (id: ${tab.id})\n\n${content}`;
}

async function handleClick({ selector }) {
  if (!selector) throw new Error('selector parameter is required');

  const tab = await getActiveTab();

  // Click the element with full mouse event simulation
  const clickResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: `Element not found: ${sel}` };

      // Scroll element into view
      el.scrollIntoView({ block: 'center', behavior: 'instant' });

      // Simulate full mouse interaction sequence
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

      el.dispatchEvent(new PointerEvent('pointerover', opts));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new PointerEvent('pointerenter', opts));
      el.dispatchEvent(new MouseEvent('mouseenter', opts));
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 0 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 0 }));
      el.focus?.();
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...opts, button: 0 }));
      el.dispatchEvent(new MouseEvent('click', { ...opts, button: 0 }));

      return { success: true };
    },
    args: [selector],
  });

  const clickResult = clickResults?.[0]?.result;
  if (!clickResult?.success) {
    throw new Error(clickResult?.error || 'Click failed');
  }

  // Wait for potential navigation or content change
  await new Promise((r) => setTimeout(r, 1000));

  // Check if navigation occurred
  try {
    await waitForTabComplete(tab.id, 3000);
  } catch {
    // No navigation, that's fine
  }

  const content = await extractContent(tab.id);
  return `Clicked: ${selector}\n\n${content}`;
}

async function handleType({ selector, text, clear }) {
  if (!selector) throw new Error('selector parameter is required');
  if (text === undefined || text === null) throw new Error('text parameter is required');

  const tab = await getActiveTab();
  const shouldClear = clear !== false; // default true

  const typeResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, value, doClear) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: `Element not found: ${sel}` };

      el.focus();

      // React controlled input support: use native setter + InputEvent
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
      )?.set;

      if (doClear) {
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, '');
        } else {
          el.value = '';
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return { success: true };
    },
    args: [selector, text, shouldClear],
  });

  const result = typeResults?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || 'Type failed');
  }

  return `Typed "${text}" into ${selector}`;
}

async function handleGetContent({ tabId }) {
  const tab = tabId ? { id: tabId } : await getActiveTab();
  const content = await extractContent(tab.id);
  return content;
}

async function handleGetTabs() {
  const tabs = await chrome.tabs.query({});
  const tabList = tabs.map((t) => `${t.id}: "${t.title}" - ${t.url}`);
  return `Open tabs:\n${tabList.join('\n')}`;
}

async function handleSwitchTab({ tabId, tab_id }) {
  const id = tabId || tab_id;
  if (!id) throw new Error('tab_id parameter is required');

  await chrome.tabs.update(id, { active: true });
  const tab = await chrome.tabs.get(id);

  // Focus the window containing the tab
  await chrome.windows.update(tab.windowId, { focused: true });

  const content = await extractContent(id);
  return `Switched to tab ${id}: "${tab.title}"\n\n${content}`;
}

// --- New action handlers ---

async function handleScreenshot({ selector, full_page }) {
  const tab = await getActiveTab();

  // Capture visible tab as PNG
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  if (selector) {
    // If a selector is specified, we still return the full screenshot
    // but note the selector in the response (element cropping would require canvas)
    return JSON.stringify({
      image: dataUrl.replace(/^data:image\/png;base64,/, ''),
      mimeType: 'image/png',
      note: `Full viewport captured. Selector "${selector}" was requested but element-level cropping is not supported in extension context.`,
    });
  }

  return JSON.stringify({
    image: dataUrl.replace(/^data:image\/png;base64,/, ''),
    mimeType: 'image/png',
  });
}

async function handleHover({ selector }) {
  if (!selector) throw new Error('selector parameter is required');

  const tab = await getActiveTab();

  const hoverResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: `Element not found: ${sel}` };

      el.scrollIntoView({ block: 'center', behavior: 'instant' });

      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

      el.dispatchEvent(new PointerEvent('pointerover', opts));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new PointerEvent('pointerenter', opts));
      el.dispatchEvent(new MouseEvent('mouseenter', opts));

      return { success: true };
    },
    args: [selector],
  });

  const result = hoverResults?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || 'Hover failed');
  }

  // Short delay for hover effects to render
  await new Promise((r) => setTimeout(r, 300));

  const content = await extractContent(tab.id);
  return `Hovered: ${selector}\n\n${content}`;
}

async function handleSelect({ selector, value }) {
  if (!selector) throw new Error('selector parameter is required');
  if (value === undefined || value === null) throw new Error('value parameter is required');

  const tab = await getActiveTab();

  const selectResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: `Element not found: ${sel}` };
      if (el.tagName.toLowerCase() !== 'select') {
        return { success: false, error: `Element is not a <select>: ${sel}` };
      }

      // Use native setter for React support
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype, 'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(el, val);
      } else {
        el.value = val;
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));

      return { success: true, selectedText: el.options[el.selectedIndex]?.text || val };
    },
    args: [selector, value],
  });

  const result = selectResults?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || 'Select failed');
  }

  return `Selected "${result.selectedText}" in ${selector}`;
}

async function handleEvaluate({ script }) {
  if (!script) throw new Error('script parameter is required');

  const tab = await getActiveTab();

  const evalResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (code) => {
      try {
        const result = eval(code);
        if (result === undefined) return { success: true, result: 'undefined' };
        if (typeof result === 'object') {
          try {
            return { success: true, result: JSON.stringify(result, null, 2) };
          } catch {
            return { success: true, result: String(result) };
          }
        }
        return { success: true, result: String(result) };
      } catch (err) {
        return { success: false, error: err.message || String(err) };
      }
    },
    args: [script],
    world: 'MAIN',
  });

  const result = evalResults?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || 'Evaluate failed');
  }

  return result.result;
}

async function handleScroll({ direction, amount, selector }) {
  const tab = await getActiveTab();
  const dir = direction || 'down';
  const px = amount || 400;

  const scrollResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, scrollDir, scrollPx) => {
      const target = sel ? document.querySelector(sel) : window;
      if (sel && !target) return { success: false, error: `Element not found: ${sel}` };

      const scrollTarget = sel ? target : window;
      const opts = { behavior: 'smooth' };

      switch (scrollDir) {
        case 'up':
          scrollTarget.scrollBy({ top: -scrollPx, ...opts });
          break;
        case 'down':
          scrollTarget.scrollBy({ top: scrollPx, ...opts });
          break;
        case 'left':
          scrollTarget.scrollBy({ left: -scrollPx, ...opts });
          break;
        case 'right':
          scrollTarget.scrollBy({ left: scrollPx, ...opts });
          break;
      }

      return { success: true };
    },
    args: [selector || null, dir, px],
  });

  const result = scrollResults?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || 'Scroll failed');
  }

  return `Scrolled ${dir} by ${px}px${selector ? ` on ${selector}` : ''}`;
}

async function handleKeyPress({ key, modifiers, selector }) {
  if (!key) throw new Error('key parameter is required');

  const tab = await getActiveTab();
  const mods = modifiers || [];

  const keyResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, keyName, keyMods) => {
      const target = sel ? document.querySelector(sel) : document.activeElement || document.body;
      if (sel && !target) return { success: false, error: `Element not found: ${sel}` };

      const opts = {
        key: keyName,
        code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
        bubbles: true,
        cancelable: true,
        ctrlKey: keyMods.includes('ctrl'),
        shiftKey: keyMods.includes('shift'),
        altKey: keyMods.includes('alt'),
        metaKey: keyMods.includes('meta'),
      };

      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keypress', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));

      return { success: true };
    },
    args: [selector || null, key, mods],
  });

  const result = keyResults?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || 'Key press failed');
  }

  const modStr = mods.length > 0 ? `${mods.join('+')}+` : '';
  return `Pressed ${modStr}${key}${selector ? ` on ${selector}` : ''}`;
}

async function handleBack() {
  const tab = await getActiveTab();
  await chrome.tabs.goBack(tab.id);

  // Wait for navigation
  await new Promise((r) => setTimeout(r, 500));
  try {
    await waitForTabComplete(tab.id, 5000);
  } catch {
    // May already be complete
  }
  await new Promise((r) => setTimeout(r, 300));

  const content = await extractContent(tab.id);
  return `Navigated back\n\n${content}`;
}

async function handleForward() {
  const tab = await getActiveTab();
  await chrome.tabs.goForward(tab.id);

  await new Promise((r) => setTimeout(r, 500));
  try {
    await waitForTabComplete(tab.id, 5000);
  } catch {
    // May already be complete
  }
  await new Promise((r) => setTimeout(r, 300));

  const content = await extractContent(tab.id);
  return `Navigated forward\n\n${content}`;
}

async function handleReload() {
  const tab = await getActiveTab();
  await chrome.tabs.reload(tab.id);

  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 500));

  const content = await extractContent(tab.id);
  return `Page reloaded\n\n${content}`;
}

async function handleCloseTab({ tabId, tab_id }) {
  const id = tabId || tab_id;
  if (!id) throw new Error('tab_id parameter is required');

  const tab = await chrome.tabs.get(id);
  const title = tab.title;
  await chrome.tabs.remove(id);

  return `Closed tab ${id}: "${title}"`;
}

async function handleWaitFor({ selector, timeout, state }) {
  if (!selector) throw new Error('selector parameter is required');

  const tab = await getActiveTab();
  const timeoutMs = timeout || 10000;
  const targetState = state || 'visible';

  const waitResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, tMs, tState) => {
      return new Promise((resolve) => {
        const startTime = Date.now();
        const pollInterval = 200;

        function checkCondition() {
          const el = document.querySelector(sel);
          let conditionMet = false;

          switch (tState) {
            case 'attached':
              conditionMet = el !== null;
              break;
            case 'detached':
              conditionMet = el === null;
              break;
            case 'visible':
              if (el) {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                conditionMet =
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0' &&
                  rect.width > 0 &&
                  rect.height > 0;
              }
              break;
            case 'hidden':
              if (!el) {
                conditionMet = true;
              } else {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                conditionMet =
                  style.display === 'none' ||
                  style.visibility === 'hidden' ||
                  style.opacity === '0' ||
                  rect.width === 0 ||
                  rect.height === 0;
              }
              break;
          }

          if (conditionMet) {
            resolve({ success: true, elapsed: Date.now() - startTime });
            return;
          }

          if (Date.now() - startTime >= tMs) {
            resolve({
              success: false,
              error: `Timeout waiting for "${sel}" to be ${tState} after ${tMs}ms`,
            });
            return;
          }

          setTimeout(checkCondition, pollInterval);
        }

        checkCondition();
      });
    },
    args: [selector, timeoutMs, targetState],
  });

  const result = waitResults?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || 'Wait failed');
  }

  return `Element "${selector}" is ${targetState} (waited ${result.elapsed}ms)`;
}
