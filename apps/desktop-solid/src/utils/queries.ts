import { createQuery, queryOptions } from "@tanstack/solid-query";
import { commands } from "./tauri";
import { createQueryInvalidate } from "./events";
import { createTimer } from "@solid-primitives/timer";

export const getWindows = queryOptions({
  queryKey: ["capture", "windows"] as const,
  queryFn: () => commands.getCaptureWindows(),
});

const getOptions = queryOptions({
  queryKey: ["recordingOptions"] as const,
  queryFn: async () => {
    const o = await commands.getRecordingOptions();
    if (o.status === "ok") return o.data;
  },
});

export function createOptionsQuery() {
  const options = createQuery(() => getOptions);
  createQueryInvalidate(options, "recordingOptionsChanged");

  return options;
}

export function createWindowsQuery() {
  const windows = createQuery(() => getWindows);
  createTimer(() => windows.refetch(), 1000, setInterval);

  return windows;
}