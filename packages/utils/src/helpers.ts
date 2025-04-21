import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function classNames(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const uuidParse = (uuid: string) => {
  return uuid.replace(/-/g, "");
};

export const uuidFormat = (uuid: string) => {
  return uuid.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
};

export const OPAVC_LOGO_URL =
  "https://raw.githubusercontent.com/OPAVC/OPAVC/main/apps/desktop/src-tauri/icons/Square310x310Logo.png";

export const saveLatestVideoId = (videoId: string) => {
  try {
    if (typeof navigator !== "undefined" && typeof window !== "undefined") {
      window.localStorage.setItem("latestVideoId", videoId);
    }
  } catch (error) {
    console.error(error);
  }
};

export const getLatestVideoId = () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    return window.localStorage.getItem("latestVideoId") || "";
  }

  return "";
};

export const saveUserId = async (userId: string) => {
  try {
    if (typeof navigator !== "undefined" && typeof window !== "undefined") {
      window.localStorage.setItem("userId", userId);
    }
  } catch (error) {
    console.error(error);
  }
};

export const getUserId = async () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    return window.localStorage.getItem("userId") || "";
  }

  return "";
};

export const isUserPro = async () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    return window.localStorage.getItem("pro") || false;
  }

  return false;
};
