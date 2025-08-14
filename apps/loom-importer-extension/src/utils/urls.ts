/**
 * URL utilities for Cap server
 */

import type { CreateTabMessage, CreateTabResponse } from "../background";

/**
 * Gets the base server URL with proper protocol
 * @returns The formatted base URL for the Cap server
 */
export const getServerBaseUrl = (): string => {
  // @ts-expect-error
  const serverUrl = import.meta.env.VITE_SERVER_URL || "https://cap.so";
  return serverUrl.startsWith("http") ? serverUrl : `https://${serverUrl}`;
};

/**
 * Gets the base API URL
 * @returns The formatted API URL
 */
export const getApiBaseUrl = (): string => {
  return `${getServerBaseUrl()}/api`;
};

/**
 * Constructs a URL for a specific Cap route
 * @param path The path to append to the base URL (should start with /)
 * @returns The complete URL
 */
export const getCapUrl = (path: string): string => {
  return `${getServerBaseUrl()}${path}`;
};

/**
 * Common URL paths used in the application
 */
export const CapUrls = {
  LOGIN: getCapUrl("/login"),
  DASHBOARD: getCapUrl("/dashboard"),
  CREATE_ORGANIZATION: getCapUrl("/dashboard/caps?createSpace=true"),
};

/**
 * Helper function create tabs from content script
 */
// Helper function for creating tabs from content script
export const createTab = (
  url: string,
  active: boolean = true
): Promise<chrome.tabs.Tab> => {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: "createTab" as const,
        url: url,
        active: active,
      } as CreateTabMessage,
      (response: CreateTabResponse) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.success && response.tab) {
          resolve(response.tab);
        } else {
          reject(new Error(response?.error || "Failed to create tab"));
        }
      }
    );
  });
};
