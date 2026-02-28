const isDev = !('update_url' in chrome.runtime.getManifest());
const WEB_RECORDER_URL = isDev ? 'http://localhost:3000/record' : 'https://cap.so/record';

chrome.runtime.onInstalled.addListener(() => {
  console.log('Cap extension installed');
});

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: WEB_RECORDER_URL });

  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: WEB_RECORDER_URL });
  }
});
