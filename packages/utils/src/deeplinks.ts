export const parseCapDeeplink = (url: string): CapDeeplink | null => {
  const trimmedUrl = url.trim();
  if (!trimmedUrl.startsWith('cap://')) {
    return null;
  }
  const urlPart = trimmedUrl.slice('cap://'.length).trim();
  // ... rest of function unchanged
};
