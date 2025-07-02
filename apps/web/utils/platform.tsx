import React from "react";

export const getDownloadUrl = (
  platform: string | null,
  isIntel: boolean
): string => {
  if (platform === "windows") {
    return "/download/windows";
  } else if (platform === "macos") {
    return isIntel ? "/download/apple-intel" : "/download/apple-silicon";
  } else {
    // Default to Apple Silicon
    return "/download/apple-silicon";
  }
};

export const getDownloadButtonText = (
  platform: string | null,
  loading: boolean,
  isIntel: boolean = false
): string => {
  if (loading) {
    return "Download Cap";
  } else if (platform === "windows") {
    return "Download for free";
  } else if (platform === "macos") {
    return isIntel ? "Download for free" : "Download for free";
  } else {
    return "Download Cap";
  }
};

export const getPlatformIcon = (platform: string | null): React.ReactNode => {
  if (platform === "windows") {
    return (
      <svg className="mr-2 w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M0,0H11.377V11.372H0ZM12.623,0H24V11.372H12.623ZM0,12.623H11.377V24H0Zm12.623,0H24V24H12.623" />
      </svg>
    );
  } else if (platform === "macos") {
    return (
      <svg className="mr-2 w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.71,19.5C17.88,20.74 17,21.95 15.66,21.97C14.32,22 13.89,21.18 12.37,21.18C10.84,21.18 10.37,21.95 9.1,22C7.79,22.05 6.8,20.68 5.96,19.47C4.25,17 2.94,12.45 4.7,9.39C5.57,7.87 7.13,6.91 8.82,6.88C10.1,6.86 11.32,7.75 12.11,7.75C12.89,7.75 14.37,6.68 15.92,6.84C16.57,6.87 18.39,7.1 19.56,8.82C19.47,8.88 17.39,10.1 17.41,12.63C17.44,15.65 20.06,16.66 20.09,16.67C20.06,16.74 19.67,18.11 18.71,19.5M13,3.5C13.73,2.67 14.94,2.04 15.94,2C16.07,3.17 15.6,4.35 14.9,5.19C14.21,6.04 13.07,6.7 11.95,6.61C11.8,5.46 12.36,4.26 13,3.5Z" />
      </svg>
    );
  } else {
    return null;
  }
};

export const getVersionText = (platform: string | null): React.ReactNode => {
  if (platform === "macos") {
    return <>macOS 13.1+ recommended</>;
  } else if (platform === "windows") {
    return <>Windows 10+ recommended</>;
  } else {
    return <>macOS 13.1+ recommended</>;
  }
};

export const PlatformIcons: React.FC = () => {
  return (
    <div className="flex relative z-10 gap-3 mt-5">
      <div>
        <button
          onClick={() => {
            window.location.href = "/download/apple-silicon";
          }}
          className="focus:outline-none"
          aria-label="Download for free"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="1em"
            height="1em"
            fill="currentColor"
            className="size-[24px] text-gray-12 opacity-90"
            viewBox="0 0 384 512"
          >
            <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9m-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3" />
          </svg>
        </button>
      </div>
      <div>
        <a
          href="/download"
          className="focus:outline-none"
          aria-label="Download for Windows"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="1em"
            height="1em"
            fill="currentColor"
            style={{ marginTop: "1.5px" }}
            className="size-[24px] text-gray-12 opacity-90"
            viewBox="0 0 256 256"
          >
            <path d="M112 144v51.64a8 8 0 0 1-8 8 8.5 8.5 0 0 1-1.43-.13l-64-11.64A8 8 0 0 1 32 184v-40a8 8 0 0 1 8-8h64a8 8 0 0 1 8 8m-2.87-89.78a8 8 0 0 0-6.56-1.73l-64 11.64A8 8 0 0 0 32 72v40a8 8 0 0 0 8 8h64a8 8 0 0 0 8-8V60.36a8 8 0 0 0-2.87-6.14M216 136h-80a8 8 0 0 0-8 8v57.45a8 8 0 0 0 6.57 7.88l80 14.54a7.6 7.6 0 0 0 1.43.13 8 8 0 0 0 8-8v-72a8 8 0 0 0-8-8m5.13-102.14a8 8 0 0 0-6.56-1.73l-80 14.55a8 8 0 0 0-6.57 7.87V112a8 8 0 0 0 8 8h80a8 8 0 0 0 8-8V40a8 8 0 0 0-2.87-6.14" />
          </svg>
        </a>
      </div>
    </div>
  );
};
