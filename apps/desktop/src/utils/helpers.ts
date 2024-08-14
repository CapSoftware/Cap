"use client";

export const openLinkInBrowser = async (url: string) => {
  let open:
    | ((path: string, openWith?: string) => Promise<void>)
    | ((arg0: string) => any);
  const shellImport = await import("@tauri-apps/plugin-shell");
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

export const getPermissions = () => {
  try {
    if (typeof window !== "undefined") {
      const permissions = localStorage.getItem("permissions");

      if (permissions) {
        return JSON.parse(permissions);
      }
    }
  } catch (error) {
    console.error("Failed to get permissions:", error);
  }

  return { camera: false, microphone: false, screen: false, confirmed: false };
};

export const savePermissions = async (permission: string, value: boolean) => {
  try {
    if (typeof window !== "undefined") {
      let permissions = await getPermissions();

      permissions = permissions
        ? permissions
        : { camera: false, microphone: false, screen: false, confirmed: false };

      permissions[permission] = value;

      localStorage.setItem("permissions", JSON.stringify(permissions));
    }
  } catch (error) {
    console.error("Failed to save permissions:", error);
  }
};
