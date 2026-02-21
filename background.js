/* ============================================
   InstaClean – Background Service Worker
   ============================================ */

// Keep extension alive during long operations
chrome.runtime.onInstalled.addListener(() => {
  console.log('[InstaClean] Extension installed.');
  // Set default options
  chrome.storage.local.set({
    excludeFriends: false,
    friendsList: [],
    cleanerProgress: null,
    pendingAction: null,
  });
});

// Toggle the floating panel when the extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes('instagram.com')) {
    // Not on Instagram – do nothing or show a brief notification
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
  } catch {
    // Content script not loaded yet – inject it first
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    // Small delay, then toggle
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
    }, 500);
  }
});


