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

export async function getBlobDuration(blob: Blob) {
  const tempVideoEl = document.createElement("video") as HTMLVideoElement;

  const durationP = new Promise((resolve, reject) => {
    tempVideoEl.addEventListener("loadedmetadata", () => {
      if (tempVideoEl.duration === Infinity) {
        tempVideoEl.currentTime = Number.MAX_SAFE_INTEGER;
        tempVideoEl.ontimeupdate = () => {
          tempVideoEl.ontimeupdate = null;
          resolve(tempVideoEl.duration);
          tempVideoEl.currentTime = 0;
        };
      } else resolve(tempVideoEl.duration);
    });
    tempVideoEl.onerror = () => resolve(0);
  });

  tempVideoEl.src = URL.createObjectURL(blob);

  return durationP;
}
