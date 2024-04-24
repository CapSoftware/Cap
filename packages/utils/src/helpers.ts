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

export const CAP_LOGO_URL =
  "https://raw.githubusercontent.com/CapSoftware/cap/main/app-icon.png";

export const saveLatestVideoId = async (videoId: string) => {
  try {
    if (typeof navigator !== "undefined" && typeof window !== "undefined") {
      window.localStorage.setItem("latestVideoId", videoId);
    }
  } catch (error) {
    console.error(error);
  }
};

export const getLatestVideoId = async () => {
  if (typeof navigator !== "undefined" && typeof window !== "undefined") {
    return window.localStorage.getItem("latestVideoId") || "";
  }

  return "";
};
