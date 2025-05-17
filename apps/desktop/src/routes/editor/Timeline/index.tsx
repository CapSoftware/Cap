import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { platform } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { For, Show, batch, createRoot, createSignal, onMount } from "solid-js";
import { produce } from "solid-js/store";

import { useEditorContext } from "../context";
import { formatTime } from "../utils";
import { ClipTrack } from "./ClipTrack";
import { TimelineContextProvider, useTimelineContext } from "./context";
import { ZoomSegmentDragState, ZoomTrack } from "./ZoomTrack";

const TIMELINE_PADDING = 16;

export function Timeline() {
  const {
    project,
    setProject,
    editorInstance,
    projectHistory,
    setEditorState,
    totalDuration,
    editorState,
  } = useEditorContext();

  const duration = () => editorInstance.recordingDuration;
  const transform = () => editorState.timeline.transform;

  const [timelineRef, setTimelineRef] = createSignal<HTMLDivElement>();
  const timelineBounds = createElementBounds(timelineRef);

  const secsPerPixel = () => transform().zoom / (timelineBounds.width ?? 1);

  onMount(() => {
    if (!project.timeline) {
      const resume = projectHistory.pause();
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
      setEditorState(
        "playbackTime",
        Math.min(
          secsPerPixel() * (e.clientX - left!) + transform().position,
          totalDuration()
        )
      );
    }
  }

  createEventListener(window, "keydown", (e) => {
    if (e.code === "Backspace" || e.code === "Delete") {
      if (editorState.timeline.selection?.type !== "zoom") return;
      const selection = editorState.timeline.selection;

      batch(() => {
        setProject(
          produce((project) => {
            project.timeline?.zoomSegments.splice(selection.index, 1);
          })
        );
      });
    }
  });

  const split = () => editorState.timeline.interactMode === "split";

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
                setEditorState("timeline", "selection", null);
              }
            });
            createEventListener(window, "mouseup", () => {
              dispose();
            });
          });
        }}
        onMouseMove={(e) => {
          const { left } = timelineBounds;
          if (editorState.playing) return;
          setEditorState(
            "previewTime",
            transform().position + secsPerPixel() * (e.clientX - left!)
          );
        }}
        onMouseLeave={() => {
          setEditorState("previewTime", null);
        }}
        onWheel={(e) => {
          // pinch zoom or ctrl + scroll
          if (e.ctrlKey) {
            batch(() => {
              const zoomDelta = (e.deltaY * Math.sqrt(transform().zoom)) / 30;

              const newZoom = transform().zoom + zoomDelta;

              transform().updateZoom(
                newZoom,
                editorState.previewTime ?? editorState.playbackTime
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

            const newPosition = transform().position + secsPerPixel() * delta;

            transform().setPosition(newPosition);
          }
        }}
      >
        <TimelineMarkings />
        <Show when={!editorState.playing && editorState.previewTime}>
          {(time) => (
            <div
              class={cx(
                "flex absolute bottom-0 top-4 left-5 z-10 justify-center items-center w-px pointer-events-none bg-gradient-to-b to-[120%]",
                split() ? "from-red-300" : "from-gray-400"
              )}
              style={{
                left: `${TIMELINE_PADDING}px`,
                transform: `translateX(${
                  (time() - transform().position) / secsPerPixel()
                }px)`,
              }}
            >
              <div
                class={cx(
                  "absolute -top-2 rounded-full size-3",
                  split() ? "bg-red-300" : "bg-gray-10"
                )}
              />
            </div>
          )}
        </Show>
        <Show when={!split()}>
          <div
            class="absolute bottom-0 top-4 h-full rounded-full z-10 w-px pointer-events-none bg-gradient-to-b to-[120%] from-[rgb(226,64,64)]"
            style={{
              left: `${TIMELINE_PADDING}px`,
              transform: `translateX(${Math.min(
                (editorState.playbackTime - transform().position) /
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
  const { editorState } = useEditorContext();
  const { secsPerPixel, markingResolution } = useTimelineContext();
  const transform = () => editorState.timeline.transform;

  const timelineMarkings = () => {
    const diff = transform().position % markingResolution();

    return Array.from(
      { length: 2 + (transform().zoom + 5) / markingResolution() },
      (_, i) => transform().position - diff + (i + 0) * markingResolution()
    );
  };

  return (
    <div class="relative mb-1 h-4 text-xs">
      <For each={timelineMarkings()}>
        {(second) => (
          <Show when={second > 0}>
            <div
              class="absolute bottom-1 left-0 text-center rounded-full w-1 h-1 bg-[--text-tertiary] text-[--text-tertiary]"
              style={{
                transform: `translateX(${
                  (second - transform().position) / secsPerPixel() - 1
                }px)`,
              }}
            >
              <Show when={second % 1 === 0}>
                <div class="absolute -top-5 -translate-x-1/2">
                  {formatTime(second)}
                </div>
              </Show>
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}
