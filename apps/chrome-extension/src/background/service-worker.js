const isDev = !('update_url' in chrome.runtime.getManifest());
const WEB_RECORDER_URL = isDev ? 'http://localhost:3000/record' : 'https://cap.so/record';

chrome.runtime.onInstalled.addListener(() => {
  console.log('Cap extension installed');
});

chrome.action.onClicked.addListener(async () => {
  chrome.tabs.create({ url: WEB_RECORDER_URL });
});
