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

export function debounce(
  func: (...args: any[]) => void,
  wait: number | undefined
) {
  let timeout: number | undefined;
  return function executedFunction(...args: any[]) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
