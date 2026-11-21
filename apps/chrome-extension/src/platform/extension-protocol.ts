// "chrome-extension:" on Chromium, "moz-extension:" on Firefox. Sender checks
// must use this instead of a hardcoded literal or Firefox extension pages get
// misclassified as web pages.
export const EXTENSION_PROTOCOL = new URL(chrome.runtime.getURL("")).protocol;
