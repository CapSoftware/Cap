interface AuthResponse {
  token: string | null;
  timestamp?: number;
}

interface CookieChangeInfo {
  removed: boolean;
  cookie: chrome.cookies.Cookie;
}

interface ImportMessage {
  type: string;
  [key: string]: any;
}

import { getServerBaseUrl, CapUrls } from "./utils/urls";

const baseUrl = getServerBaseUrl();

async function checkAuthToken(): Promise<string | null> {
  try {
    const cookie = await chrome.cookies.get({
      url: baseUrl,
      name: "next-auth.session-token",
    });

    if (cookie) {
      const authData: AuthResponse = {
        token: cookie.value,
        timestamp: Date.now(),
      };
      await chrome.storage.local.set({ authData: authData });
      return cookie.value;
    }

    return null;
  } catch (error) {
    console.error("Error checking auth token:", error);
    return null;
  }
}

async function verifyTokenFreshness(): Promise<void> {
  try {
    const data = await chrome.storage.local.get("authData");
    const authData = data.authData as AuthResponse | undefined;

    if (!authData?.timestamp || Date.now() - authData.timestamp > 60000) {
      await checkAuthToken();
    }
  } catch (error) {
    console.error("Error verifying token freshness:", error);
  }
}

async function redirectToLogin(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentTab = tabs[0];
  if (currentTab?.id && currentTab.url?.startsWith(baseUrl)) {
    await chrome.tabs.update(currentTab.id, { url: CapUrls.LOGIN });
  }
}

chrome.cookies.onChanged.addListener(async (changeInfo: CookieChangeInfo) => {
  if (
    changeInfo.cookie.domain.includes(baseUrl) &&
    changeInfo.cookie.name === "next-auth.session-token"
  ) {
    if (!changeInfo.removed) {
      const authData: AuthResponse = {
        token: changeInfo.cookie.value,
        timestamp: Date.now(),
      };
      await chrome.storage.local.set({ authData: authData });
    } else {
      await chrome.storage.local.remove("authData");
    }
  }
});

setInterval(verifyTokenFreshness, 30000);
function forwardToPopup(message: ImportMessage): void {
  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(
          "Error forwarding message to popup (it might be closed):",
          chrome.runtime.lastError
        );
      }
    });
  } catch (err) {
    console.warn(
      "Error forwarding message to popup (it might be closed):",
      err
    );
  }
}

const messageListeners = new Map();

chrome.runtime.onMessage.addListener(
  (
    request: { action?: string; type?: string; [key: string]: any },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void
  ) => {
    if (request.action === "getAuthStatus") {
      verifyTokenFreshness()
        .then(() => checkAuthToken())
        .then((token) => {
          if (!token) {
            redirectToLogin();
          }
          sendResponse({ token });
        })
        .catch((error) => {
          console.error("Error getting auth status:", error);
          sendResponse({ token: null, error: String(error) });
        });
      return true;
    }

    if (request.type && request.type.startsWith("CAP_")) {
      console.log(`Received Cap message: ${request.type}`, request);

      if (request.type === "CAP_LOOM_VIDEOS_SELECTED" && request.videos) {
        chrome.storage.local.set({ selectedVideos: request.videos });

        const capMessage: ImportMessage = {
          type: request.type,
          videos: [...request.videos],
        };
        forwardToPopup(capMessage);
      } else if (request.type) {
        const capMessage: ImportMessage = {
          type: request.type,
          ...request,
        };
        forwardToPopup(capMessage);
      }

      sendResponse({ success: true });
      return true;
    }

    return false;
  }
);

chrome.runtime.onMessageExternal.addListener(
  (
    request: { type: string; [key: string]: any },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void
  ) => {
    if (request.type && request.type.startsWith("CAP_")) {
      const capMessage: ImportMessage = {
        ...request,
      };
      forwardToPopup(capMessage);
      sendResponse({ success: true });
      return true;
    }

    return false;
  }
);
