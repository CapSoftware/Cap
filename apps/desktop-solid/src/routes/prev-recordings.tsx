import { createQuery } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cx } from "cva";
import {
  type ComponentProps,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import createPresence from "solid-presence";

import { commands, events } from "../utils/tauri";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export default function () {
  const recordings = createQuery(() => ({
    queryKey: ["recordings"],
    queryFn: async () => {
      const o = await commands.getPrevRecordings();
      if (o.status === "ok") return o.data;
    },
  }));

  // let closingRecording: string | null = null;
  // window.addEventListener("wheel", (e) => {
  //   if (e.deltaX === 0) closingRecording = null;
  // });

  events.showCapturesPanel.listen(() => {
    recordings.refetch();
  });

  return (
    <div class="w-screen h-screen bg-transparent relative">
      <div class="absolute left-0 bottom-0 flex flex-col-reverse w-60 pl-8 pb-8 gap-8">
        <For each={recordings.data}>
          {(recording, i) => {
            const [thumbnailUrl, setThumbnailUrl] = createSignal("");

            onMount(() => {
              const video = document.createElement("video");
              video.src = convertFileSrc(`${recording}/content/display.mp4`);
              video.addEventListener("loadeddata", () => {
                video.currentTime = 1; // Set to 1 second or adjust as needed
              });
              video.addEventListener("seeked", () => {
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas
                  .getContext("2d")
                  ?.drawImage(video, 0, 0, canvas.width, canvas.height);
                setThumbnailUrl(canvas.toDataURL());
              });
            });

            const [ref, setRef] = createSignal<HTMLElement | null>(null);

            const [exiting, setExiting] = createSignal(false);

            const { present } = createPresence({
              show: () => !exiting(),
              element: ref,
            });

            createEffect(
              on(i, () => {
                const bounds = ref()?.getBoundingClientRect();
                if (!bounds) return;

                commands.setFakeWindowBounds(recording, {
                  x: bounds.x,
                  y: bounds.y,
                  width: bounds.width,
                  height: bounds.height,
                });
              })
            );

            onCleanup(() => {
              commands.removeFakeWindow(recording);
            });

            return (
              <Show when={present()}>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: <explanation> */}
                <div
                  ref={setRef}
                  onClick={() => setExiting(true)}
                  // onWheel={(e) => {
                  //   if (closingRecording && closingRecording !== recording) {
                  //     if (e.deltaX === 1) closingRecording = null;

                  //     return;
                  //   }

                  //   if (e.deltaX > 8) {
                  //     setExiting(true);
                  //     closingRecording = recording;
                  //   }
                  // }}
                  class={cx(
                    "w-full h-36 rounded-xl overflow-hidden shadow border border-gray-100/20 relative flex flex-col items-center justify-center",
                    "transition-[transform,opacity] duration-300",
                    exiting()
                      ? "animate-out slide-out-to-left-32 fade-out"
                      : "animate-in fade-in"
                  )}
                >
                  <Show
                    when={thumbnailUrl()}
                    fallback={<div class="w-full h-full bg-gray-800" />}
                  >
                    <img
                      class="pointer-events-none w-full h-full object-cover absolute inset-0 -z-10"
                      alt="video thumbnail"
                      src={thumbnailUrl()}
                    />
                  </Show>
                  <div class="w-full h-full absolute inset-0 transition-all opacity-0 hover:opacity-100 backdrop-blur hover:backdrop-blur bg-black/50 text-white p-4">
                    <IconButton class="absolute left-3 top-3">
                      <IconLucideEye class="size-4" />
                    </IconButton>
                    <IconButton
                      class="absolute right-3 top-3"
                      onClick={() => {
                        new WebviewWindow("editor", {
                          width: 800,
                          height: 600,
                          url: `/editor?path=${recording}`,
                        });
                      }}
                    >
                      <IconLucidePencil class="size-4" />
                    </IconButton>
                    <IconButton class="absolute left-3 bottom-3">
                      <IconLucideCopy class="size-4" />
                    </IconButton>
                    <IconButton class="absolute right-3 bottom-3">
                      <IconLucideShare class="size-4" />
                    </IconButton>
                  </div>
                </div>
              </Show>
            );
          }}
        </For>
      </div>
    </div>
  );
}

const IconButton = (props: ComponentProps<"button">) => {
  return (
    <button
      {...props}
      type="button"
      class={cx(
        "p-2 bg-neutral-800 rounded-full text-neutral-300 text-sm",
        props.class
      )}
    />
  );
};
