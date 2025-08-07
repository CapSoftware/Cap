import { onCleanup, onMount, type ResourceReturn } from "solid-js";
import { events } from "./tauri";
import { CreateQueryResult } from "@tanstack/solid-query";

export function createQueryInvalidate<T extends CreateQueryResult>(
  query: T,
  event: keyof typeof events
) {
  onMount(() => {
    const cleanup = events[event].listen(() => query.refetch());
    onCleanup(() => cleanup.then((c) => c()));
  });
}
