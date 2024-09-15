import { createElementBounds } from "@solid-primitives/bounds";
import { Show, createRoot, createSignal, onMount } from "solid-js";

import { commands } from "../../utils/tauri";
import { useEditorContext } from "./context";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { formatTime } from "./utils";

export function Timeline() {
  const {
    project,
    setProject,
    videoId,
    editorInstance,
    playbackTime,
    previewTime,
    setPreviewTime,
    history,
  } = useEditorContext();

  const duration = () => editorInstance.recordingDuration;

  const [timelineRef, setTimelineRef] = createSignal<HTMLDivElement>();
  const timelineBounds = createElementBounds(timelineRef);

  const trim = () =>
    project.timeline?.segments[0] ?? {
      start: 0,
      end: duration(),
    };

  onMount(() => {
    if (!project.timeline) {
      const resume = history.pause();
      setProject("timeline", {
        segments: [{ timescale: 1, start: 0, end: duration() }],
      });
      resume();
    }
  });

  const xPadding = 12;

  return (
    <div
      class="py-[2rem] relative bg-red-transparent-10 overflow-hidden"
      style={{
        "padding-left": `${xPadding}px`,
        "padding-right": `${xPadding}px`,
      }}
      onMouseDown={(e) => {
        const { left, width } = timelineBounds;
        commands.setPlayheadPosition(
          videoId,
          Math.round(
            30 * editorInstance.recordingDuration * ((e.clientX - left) / width)
          )
        );
      }}
      onMouseMove={(e) => {
        const { left, width } = timelineBounds;
        setPreviewTime(
          editorInstance.recordingDuration * ((e.clientX - left) / width)
        );
      }}
      onMouseLeave={() => {
        setPreviewTime(undefined);
      }}
    >
      <div ref={setTimelineRef}>
        <Show when={previewTime()}>
          {(time) => (
            <div
              class="w-px bg-black-transparent-20 absolute left-5 top-4 bottom-0 z-10 pointer-events-none"
              style={{
                left: `${xPadding}px`,
                transform: `translateX(${
                  (time() / editorInstance.recordingDuration) *
                  (timelineBounds.width ?? 0)
                }px)`,
              }}
            >
              <div class="size-2 bg-black-transparent-20 rounded-full -mt-2 -ml-[calc(0.25rem-0.5px)]" />
            </div>
          )}
        </Show>
        <div
          class="w-px bg-red-300 absolute top-4 bottom-0 z-10"
          style={{
            left: `${xPadding}px`,
            transform: `translateX(${Math.min(
              (playbackTime() / editorInstance.recordingDuration) *
                (timelineBounds.width ?? 0),
              timelineBounds.width ?? 0
            )}px)`,
          }}
        >
          <div class="size-2 bg-red-300 rounded-full -mt-2 -ml-[calc(0.25rem-0.5px)]" />
        </div>
        <div
          class="relative h-[3rem] border border-white ring-1 ring-blue-300 flex flex-row rounded-xl overflow-hidden"
          style={{
            width: `${(100 * (trim().end - trim().start)) / duration()}%`,
          }}
        >
          <div
            class="bg-blue-300 w-[0.5rem] cursor-col-resize"
            onMouseDown={(downEvent) => {
              const start = trim().start;

              function update(event: MouseEvent) {
                const { width } = timelineBounds;
                setProject(
                  "timeline",
                  "segments",
                  0,
                  "start",
                  Math.max(
                    Math.min(
                      trim().end,
                      start +
                        ((event.clientX - downEvent.clientX) / width) *
                          duration()
                    ),
                    0
                  )
                );
              }

              const resumeHistory = history.pause();
              createRoot((dispose) => {
                createEventListenerMap(window, {
                  mousemove: update,
                  mouseup: (e) => {
                    dispose();
                    resumeHistory();
                    update(e);
                  },
                });
              });
            }}
          />
          <div class="bg-blue-50 relative w-full h-full flex flex-row items-end justify-end px-[0.5rem] py-[0.25rem]">
            <span class="text-black-transparent-60 text-[0.625rem]">
              {formatTime(trim().start)}
            </span>
            <span class="text-black-transparent-60 text-[0.625rem] ml-auto">
              {formatTime(trim().end)}
            </span>
          </div>
          <div
            class="bg-blue-300 w-[0.5rem] cursor-col-resize"
            onMouseDown={(downEvent) => {
              const end = trim().end;

              function update(event: MouseEvent) {
                const { width } = timelineBounds;
                setProject(
                  "timeline",
                  "segments",
                  0,
                  "end",
                  Math.max(
                    trim().start,
                    Math.min(
                      duration(),
                      end +
                        ((event.clientX - downEvent.clientX) / width) *
                          duration()
                    )
                  )
                );
              }

              const resumeHistory = history.pause();
              createRoot((dispose) => {
                createEventListenerMap(window, {
                  mousemove: update,
                  mouseup: (e) => {
                    dispose();
                    resumeHistory();
                    update(e);
                  },
                });
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}
