"use client";

export const openLinkInBrowser = async (url: string) => {
  let open:
    | ((path: string, openWith?: string) => Promise<void>)
    | ((arg0: string) => any);
  const shellImport = await import("@tauri-apps/api/shell");
  open = shellImport.open;

  if (typeof window === "undefined") {
    return;
  }

  await open(url);

  return;
};

export function concatenateTypedArrays(
  constructor: new (arg0: number) => any,
  ...arrays: any[]
) {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new constructor(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export const requestMediaDevicesPermission = async () => {
  try {
    if (typeof navigator !== "undefined" && typeof window !== "undefined") {
      await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      console.log("Permissions to access media devices have been granted.");
    }
  } catch (error) {
    console.error("Permissions to access media devices were denied.", error);
  }
};
