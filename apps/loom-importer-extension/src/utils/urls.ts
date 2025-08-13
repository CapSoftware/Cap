/**
 * URL utilities for Cap server
 */

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
