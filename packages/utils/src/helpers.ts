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

function createVid(url: string) {
  const vid = document.createElement("video");
  vid.src = url;
  vid.controls = false;
  vid.muted = true;
  vid.autoplay = false;
  return vid;
}

export function getVideoDuration(blob: Blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const vid = createVid(url);
    vid.addEventListener("timeupdate", (_evt) => {
      res(vid.duration);
      vid.src = "";
      URL.revokeObjectURL(url);
    });
    vid.onerror = (evt) => {
      rej(evt);
      URL.revokeObjectURL(url);
    };
    vid.currentTime = 1e101;
  });
}
