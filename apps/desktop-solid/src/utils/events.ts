import { onCleanup, onMount, type ResourceReturn } from "solid-js";
import { events } from "./tauri";

export function makeInvalidated<R>(
  resource: ResourceReturn<R>,
  event: keyof typeof events
) {
  const [_, { refetch }] = resource;

  onMount(() => {
    const cleanup = events[event].listen(() => refetch());
    onCleanup(() => cleanup.then((c) => c()));
  });

  return resource;
}
