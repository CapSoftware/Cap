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
} from "solid-js";
import createPresence from "solid-presence";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import Tooltip from "@corvu/tooltip";
import { Button } from "@cap/ui-solid";

import { commands, events } from "../utils/tauri";

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

  const [showAll, setShowAll] = createSignal(false);
  const visibleRecordings = () =>
    showAll() ? recordings.data : recordings.data?.slice(0, 5);

  return (
    <div class="w-screen h-screen bg-transparent relative">
      <div class="absolute left-0 bottom-0 flex flex-col-reverse pl-[40px] pb-[80px] gap-4">
        <For each={visibleRecordings()}>
          {(recording, i) => {
            const [ref, setRef] = createSignal<HTMLElement | null>(null);

            const [exiting, setExiting] = createSignal(false);
            const [isLoading, setIsLoading] = createSignal(false);
            const [isSuccess, setIsSuccess] = createSignal(false);
            const [metadata, setMetadata] = createSignal({
              duration: 0,
              size: 0,
            });

            const [imageExists, setImageExists] = createSignal(true);

            const { present } = createPresence({
              show: () => !exiting(),
              element: ref,
            });

            createEffect(() => {
              commands.getVideoMetadata(recording).then((result) => {
                if (result.status === "ok") {
                  const [duration, size] = result.data;
                  console.log(
                    `Metadata for ${recording}: duration=${duration}, size=${size}`
                  );
                  setMetadata({
                    duration,
                    size,
                  });
                } else {
                  console.error(`Failed to get metadata: ${result.error}`);
                }
              });
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
                  style={{
                    "border-color": "rgba(255, 255, 255, 0.2)",
                    // "box-shadow": "0px 2px 4px rgba(18, 22, 31, 0.12)",
                  }}
                  class={cx(
                    "w-[260px] h-[150px] p-[0.1875rem] bg-gray-500 rounded-[12px] overflow-hidden shadow border-[1px] group transition-all relative",
                    "transition-[transform,opacity] duration-300",
                    exiting()
                      ? "animate-out slide-out-to-left-32 fade-out"
                      : "animate-in fade-in"
                  )}
                >
                  <div
                    class="w-full h-full flex relative bg-transparent rounded-[8px] border-[1px] overflow-hidden z-10"
                    style={{ "border-color": "rgba(255, 255, 255, 0.2)" }}
                  >
                    <Show
                      when={imageExists()}
                      fallback={
                        <div class="pointer-events-none w-[105%] h-[105%] absolute inset-0 -z-10 bg-gray-400" />
                      }
                    >
                      <img
                        class="pointer-events-none w-[105%] h-[105%] object-cover absolute inset-0 -z-10"
                        alt="screenshot"
                        src={convertFileSrc(
                          `${recording}/screenshots/display.jpg`
                        )}
                        onError={() => setImageExists(false)}
                      />
                    </Show>
                    <div class="w-full h-full absolute inset-0 transition-all opacity-0 group-hover:opacity-100 backdrop-blur group-hover:backdrop-blur bg-gray-500/80 text-white p-2">
                      <TooltipIconButton
                        class="absolute left-3 top-3 z-20"
                        tooltipText="Close"
                        tooltipPlacement="right"
                        onClick={() => {
                          setExiting(true);
                        }}
                      >
                        <IconCapCircleX class="size-[1rem]" />
                      </TooltipIconButton>
                      <TooltipIconButton
                        class="absolute left-3 bottom-3 z-20"
                        tooltipText="Edit"
                        tooltipPlacement="right"
                        onClick={() => {
                          new WebviewWindow("editor", {
                            width: 1440,
                            height: 1024,
                            url: `/editor?path=${recording}`,
                          });
                        }}
                      >
                        <IconCapEditor class="size-[1rem]" />
                      </TooltipIconButton>
                      <TooltipIconButton
                        class="absolute right-3 top-3 z-20"
                        tooltipText="Copy to Clipboard"
                        tooltipPlacement="left"
                        onClick={async () => {
                          setIsLoading(true);
                          try {
                            await commands.copyRenderedVideoToClipboard(
                              recording,
                              {
                                aspectRatio: "classic",
                                background: {
                                  source: {
                                    type: "color",
                                    value: [0, 0, 0],
                                  },
                                  blur: 0,
                                  padding: 0,
                                  rounding: 0,
                                  inset: 0,
                                },
                                camera: {
                                  hide: false,
                                  mirror: false,
                                  position: { x: "left", y: "bottom" },
                                  rounding: 0,
                                  shadow: 0,
                                },
                                audio: { mute: false, improve: false },
                                cursor: {
                                  hideWhenIdle: false,
                                  size: 16,
                                  type: "pointer",
                                },
                                hotkeys: { show: false },
                              }
                            );
                            setIsLoading(false);
                            setIsSuccess(true);
                            setTimeout(() => setIsSuccess(false), 2000);
                          } catch (error) {
                            setIsLoading(false);
                            window.alert("Failed to copy to clipboard");
                          }
                        }}
                      >
                        <Show when={isLoading()}>
                          <IconLucideLoaderCircle class="size-[1rem] animate-spin" />
                        </Show>
                        <Show when={isSuccess()}>
                          <IconLucideCheck class="size-[1rem]" />
                        </Show>
                        <Show when={!isLoading() && !isSuccess()}>
                          <IconCapCopy class="size-[1rem]" />
                        </Show>
                      </TooltipIconButton>
                      <TooltipIconButton
                        class="absolute right-3 bottom-3"
                        tooltipText="Create Shareable Link"
                        tooltipPlacement="left"
                        onClick={async () => {
                          setIsLoading(true);
                          try {
                            setIsLoading(false);
                            setIsSuccess(true);
                            setTimeout(() => setIsSuccess(false), 2000);
                          } catch (error) {
                            setIsLoading(false);
                            window.alert("Failed to create shareable link");
                          }
                        }}
                      >
                        <IconCapUpload class="size-[1rem]" />
                      </TooltipIconButton>
                      <div class="absolute inset-0 flex items-center justify-center">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={async () => {
                            setIsLoading(true);
                            try {
                              setIsLoading(false);
                              setIsSuccess(true);
                              setTimeout(() => setIsSuccess(false), 2000);
                            } catch (error) {
                              setIsLoading(false);
                              window.alert("Failed to save recording");
                            }
                          }}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                    <div
                      style={{ color: "white", "font-size": "14px" }}
                      class="absolute bottom-0 left-0 right-0 font-medium bg-gray-500 bg-opacity-40 backdrop-blur p-2 flex justify-between items-center group-hover:opacity-0 pointer-events-none transition-all"
                    >
                      <p class="flex items-center">
                        <IconCapCamera class="w-[20px] h-[20px] mr-1" />
                        {Math.floor(metadata().duration / 60)}:
                        {Math.floor(metadata().duration % 60)
                          .toString()
                          .padStart(2, "0")}
                      </p>
                      <p>{metadata().size.toFixed(2)} MB</p>
                    </div>
                  </div>
                </div>
              </Show>
            );
          }}
        </For>
        <Show when={recordings.data && recordings.data.length > 5}>
          <div class="w-full absolute bottom-[30px] left-[20px] flex justify-center z-30">
            <Button
              class="w-full max-w-[260px]"
              variant="secondary"
              size="md"
              onClick={() => setShowAll(!showAll())}
            >
              {showAll()
                ? "Show less"
                : `Show ${recordings.data!.length - 5} more`}
            </Button>
          </div>
        </Show>
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
        "p-[0.325rem] bg-gray-100 rounded-full text-neutral-300 text-[12px] shadow-[0px 2px 4px rgba(18, 22, 31, 0.12)]",
        props.class
      )}
    />
  );
};

const TooltipIconButton = (
  props: ComponentProps<"button"> & {
    tooltipText: string;
    tooltipPlacement: string;
  }
) => {
  return (
    <Tooltip
      placement={props.tooltipPlacement as "top" | "bottom" | "left" | "right"}
      openDelay={0}
      closeDelay={0}
      hoverableContent={false}
      floatingOptions={{
        offset: 10,
        flip: true,
        shift: true,
      }}
    >
      <Tooltip.Trigger as={IconButton} {...props}>
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          class="p-2 font-medium"
          style={{
            "background-color": "rgba(255, 255, 255, 0.1)",
            color: "white",
            "border-radius": "8px",
            "font-size": "12px",
          }}
        >
          {props.tooltipText}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
};
