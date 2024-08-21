import { createQuery } from "@tanstack/solid-query";
import { Show, Suspense } from "solid-js";
import { getCurrentRecording } from "../utils/queries";

export default function () {
  const currentRecording = createQuery(() => getCurrentRecording);

  return (
    <Suspense>
      <Show
        when={
          currentRecording.data?.[0] &&
          currentRecording.data[0].displaySource.variant === "window" &&
          currentRecording.data[0].displaySource.bounds
        }
      >
        {(bounds) => (
          <div class="w-screen h-screen relative animate-in fade-in">
            <div
              class="bg-black/40 absolute inset-x-0 top-0"
              style={{ height: `${bounds().y}px` }}
            />
            <div
              class="bg-black/40 absolute left-0"
              style={{
                top: `${bounds().y}px`,
                height: `${bounds().height}px`,
                width: `${bounds().x}px`,
              }}
            />
            <div
              class="bg-black/40 absolute right-0"
              style={{
                top: `${bounds().y}px`,
                height: `${bounds().height}px`,
                width: `calc(100vw - ${bounds().x + bounds().width}px)`,
              }}
            />
            <div
              class="bg-black/40 absolute inset-x-0 bottom-0"
              style={{
                height: `calc(100vh - ${bounds().y + bounds().height}px)`,
              }}
            />
          </div>
        )}
      </Show>
    </Suspense>
  );
}
