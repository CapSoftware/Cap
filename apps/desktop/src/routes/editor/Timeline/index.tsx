import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { For, Show, batch, createRoot, createSignal, onMount } from "solid-js";
import { produce } from "solid-js/store";
import { platform } from "@tauri-apps/plugin-os";

import { TimelineContextProvider, useTimelineContext } from "./context";
import { formatTime } from "../utils";
import { ZoomSegmentDragState, ZoomTrack } from "./ZoomTrack";
import { ClipTrack } from "./ClipTrack";
import { useEditorContext } from "../context";

const TIMELINE_PADDING = 8;

export function Timeline() {
  const {
    project,
    setProject,
    editorInstance,
    playbackTime,
    setPlaybackTime,
    previewTime,
    setPreviewTime,
    history,
    split,
    setState,
    playing,
    totalDuration,
    state,
  } = useEditorContext();

  const duration = () => editorInstance.recordingDuration;

  const [timelineRef, setTimelineRef] = createSignal<HTMLDivElement>();
  const timelineBounds = createElementBounds(timelineRef);

  const secsPerPixel = () =>
    state.timelineTransform.zoom / (timelineBounds.width ?? 1);

  onMount(() => {
    if (!project.timeline) {
      const resume = history.pause();
      setProject("timeline", {
        segments: [
          {
            timescale: 1,
            start: 0,
            end: duration(),
          },
        ],
      });
      resume();
    }
  });

  if (
    !project.timeline?.zoomSegments ||
    project.timeline.zoomSegments.length < 1
  ) {
    setProject(
      produce((project) => {
        project.timeline ??= {
          segments: [
            {
              start: 0,
              end: duration(),
              timescale: 1,
            },
          ],
          zoomSegments: [],
        };
      })
    );
  }

  let zoomSegmentDragState = { type: "idle" } as ZoomSegmentDragState;

  async function handleUpdatePlayhead(e: MouseEvent) {
    const { left } = timelineBounds;
    if (zoomSegmentDragState.type !== "moving") {
      setPlaybackTime(
        Math.min(
          secsPerPixel() * (e.clientX - left!) +
            state.timelineTransform.position,
          totalDuration()
        )
      );
    }
  }

  createEventListener(window, "keydown", (e) => {
    if (e.code === "Backspace" || e.code === "Delete") {
      if (state.timelineSelection?.type !== "zoom") return;
      const selection = state.timelineSelection;

      batch(() => {
        setProject(
          produce((project) => {
            project.timeline?.zoomSegments.splice(selection.index, 1);
          })
        );
      });
    }
  });

  return (
    <TimelineContextProvider
      duration={duration()}
      secsPerPixel={secsPerPixel()}
      timelineBounds={timelineBounds}
    >
      <div
        class="pt-[2rem] relative overflow-hidden flex flex-col gap-2"
        style={{
          "padding-left": `${TIMELINE_PADDING}px`,
          "padding-right": `${TIMELINE_PADDING}px`,
        }}
        onMouseDown={(e) => {
          createRoot((dispose) => {
            createEventListener(e.currentTarget, "mouseup", () => {
              handleUpdatePlayhead(e);
              if (zoomSegmentDragState.type === "idle") {
                setState("timelineSelection", null);
              }
            });
            createEventListener(window, "mouseup", () => {
              dispose();
            });
          });
        }}
        onMouseMove={(e) => {
          const { left } = timelineBounds;
          if (playing()) return;
          setPreviewTime(
            state.timelineTransform.position +
              secsPerPixel() * (e.clientX - left!)
          );
        }}
        onMouseLeave={() => {
          setPreviewTime(undefined);
        }}
        onWheel={(e) => {
          // pinch zoom or ctrl + scroll
          if (e.ctrlKey) {
            batch(() => {
              const zoomDelta =
                (e.deltaY * Math.sqrt(state.timelineTransform.zoom)) / 30;

              const newZoom = state.timelineTransform.zoom + zoomDelta;

              state.timelineTransform.updateZoom(
                newZoom,
                previewTime() ?? playbackTime()
              );
            });
          }
          // scroll
          else {
            let delta: number = 0;

            // Prioritize horizontal scrolling for touchpads
            // For touchpads, both deltaX and deltaY can be used
            // If deltaX is significant, use it (horizontal scrolling)
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5) {
              delta = e.deltaX;
            }
            // Otherwise use platform-specific defaults
            else if (platform() === "macos") {
              delta = e.shiftKey ? e.deltaX : e.deltaY;
            } else {
              delta = e.deltaY;
            }

            const newPosition =
              state.timelineTransform.position + secsPerPixel() * delta;

            state.timelineTransform.setPosition(newPosition);
          }
        }}
      >
        <TimelineMarkings />
        <Show when={!playing() && previewTime()}>
          {(time) => (
            <div
              class={cx(
                "flex absolute bottom-0 top-4 left-5 z-10 justify-center items-center w-px pointer-events-none bg-gradient-to-b to-[120%] from-gray-400",
                split() ? "text-red-300" : "text-black-transparent-20"
              )}
              style={{
                left: `${TIMELINE_PADDING}px`,
                transform: `translateX(${
                  (time() - state.timelineTransform.position) / secsPerPixel()
                }px)`,
              }}
            >
              <div class="absolute -top-2 bg-gray-400 rounded-full size-3" />
              <Show when={split()}>
                <div class="absolute size-[2rem] bg-[currentColor] z-20 top-6 rounded-lg flex items-center justify-center">
                  <IconCapScissors class="size-[1.25rem] text-gray-50 z-20" />
                </div>
              </Show>
            </div>
          )}
        </Show>
        <Show when={!split()}>
          <div
            class="absolute bottom-0 top-4 h-full rounded-full z-10 w-px pointer-events-none bg-gradient-to-b to-[120%] from-[rgb(226,64,64)]"
            style={{
              left: `${TIMELINE_PADDING}px`,
              transform: `translateX(${Math.min(
                (playbackTime() - state.timelineTransform.position) /
                  secsPerPixel(),
                timelineBounds.width ?? 0
              )}px)`,
            }}
          >
            <div class="size-3 bg-[rgb(226,64,64)] rounded-full -mt-2 -ml-[calc(0.37rem-0.5px)]" />
          </div>
        </Show>
        <ClipTrack ref={setTimelineRef} />
        <ZoomTrack
          onDragStateChanged={(v) => {
            zoomSegmentDragState = v;
          }}
          handleUpdatePlayhead={handleUpdatePlayhead}
        />
      </div>
    </TimelineContextProvider>
  );
}

function TimelineMarkings() {
  const { state } = useEditorContext();
  const { secsPerPixel, markingResolution } = useTimelineContext();

  const timelineMarkings = () => {
    const diff = state.timelineTransform.position % markingResolution();

    return Array.from(
      { length: 2 + (state.timelineTransform.zoom + 5) / markingResolution() },
      (_, i) =>
        state.timelineTransform.position - diff + i * markingResolution()
    );
  };

  return (
    <div class="relative mb-1 h-4 text-xs">
      <For each={timelineMarkings()}>
        {(second) => (
          <>
            <div
              class="absolute bottom-1 left-0 text-center rounded-full w-1 h-1 bg-[--text-tertiary] text-[--text-tertiary]"
              style={{
                transform: `translateX(${
                  (second - state.timelineTransform.position) / secsPerPixel() -
                  1
                }px)`,
              }}
            >
              <Show when={second % 1 === 0}>
                <div class="absolute -top-5 -translate-x-1/2">
                  {formatTime(second)}
                </div>
              </Show>
            </div>
          </>
        )}
      </For>
    </div>
  );
}
