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

// Define message types
export interface CreateTabMessage {
  action: "createTab";
  url: string;
  active?: boolean;
}

export interface CreateTabResponse {
  success: boolean;
  tab?: chrome.tabs.Tab;
  error?: string;
}

// Union type for all possible messages
type AllMessages =
  | CreateTabMessage
  | { action: "getAuthStatus" }
  | { type: string; [key: string]: any };

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

// Type guard functions
function isCreateTabMessage(message: any): message is CreateTabMessage {
  return message.action === "createTab" && typeof message.url === "string";
}

function isGetAuthStatusMessage(
  message: any
): message is { action: "getAuthStatus" } {
  return message.action === "getAuthStatus";
}

function isCAPMessage(
  message: any
): message is { type: string; [key: string]: any } {
  return (
    message.type &&
    typeof message.type === "string" &&
    message.type.startsWith("CAP_")
  );
}

// Single unified message listener
chrome.runtime.onMessage.addListener(
  (
    message: AllMessages,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void
  ): boolean => {
    // Handle createTab action
    if (isCreateTabMessage(message)) {
      chrome.tabs.create(
        {
          url: message.url,
          active: message.active !== false, // Default to true
        },
        (tab: chrome.tabs.Tab) => {
          if (chrome.runtime.lastError) {
            sendResponse({
              success: false,
              error: chrome.runtime.lastError.message,
            });
          } else {
            sendResponse({
              success: true,
              tab: tab,
            });
          }
        }
      );
      return true; // Keep message channel open for async response
    }

    // Handle auth status
    if (isGetAuthStatusMessage(message)) {
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

    // Handle CAP messages
    if (isCAPMessage(message)) {
      console.log(`Received Cap message: ${message.type}`, message);

      if (message.type === "CAP_LOOM_VIDEOS_SELECTED" && message.videos) {
        chrome.storage.local.set({ selectedVideos: message.videos });

        const capMessage: ImportMessage = {
          type: message.type,
          videos: [...message.videos],
        };
        forwardToPopup(capMessage);
      } else {
        const capMessage: ImportMessage = {
          ...message, // Spread first, so type is included
        };
        forwardToPopup(capMessage);
      }

      sendResponse({ success: true });
      return true;
    }

    return false; // Don't keep channel open for unhandled messages
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
