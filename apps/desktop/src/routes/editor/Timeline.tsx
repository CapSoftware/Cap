import { createElementBounds } from "@solid-primitives/bounds";
import { For, Show, createRoot, createSignal, onMount } from "solid-js";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { produce } from "solid-js/store";

import { commands } from "~/utils/tauri";
import { useEditorContext } from "./context";
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
    split,
  } = useEditorContext();

  const duration = () => editorInstance.recordingDuration;

  const [timelineRef, setTimelineRef] = createSignal<HTMLDivElement>();
  const timelineBounds = createElementBounds(timelineRef);

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

  const segments = () =>
    project.timeline?.segments ?? [{ start: 0, end: duration(), timescale: 1 }];

  return (
    <div
      class="py-[2rem] relative overflow-hidden"
      style={{
        "padding-left": `${xPadding}px`,
        "padding-right": `${xPadding}px`,
      }}
      onMouseDown={(e) => {
        const { left, width } = timelineBounds;
        commands.setPlayheadPosition(
          videoId,
          Math.round(
            30 *
              editorInstance.recordingDuration *
              ((e.clientX - left!) / width!)
          )
        );
      }}
      onMouseMove={(e) => {
        const { left, width } = timelineBounds;
        setPreviewTime(
          editorInstance.recordingDuration * ((e.clientX - left!) / width!)
        );
      }}
      onMouseLeave={() => {
        setPreviewTime(undefined);
      }}
    >
      <div ref={setTimelineRef} class="flex flex-row">
        <Show when={previewTime()}>
          {(time) => (
            <div
              class={cx(
                "w-px absolute left-5 top-4 bottom-0 z-10 pointer-events-none bg-[currentColor] flex justify-center items-center",
                split() ? "text-red-300" : "text-black-transparent-20"
              )}
              style={{
                left: `${xPadding}px`,
                transform: `translateX(${
                  (time() / editorInstance.recordingDuration) *
                  (timelineBounds.width ?? 0)
                }px)`,
              }}
            >
              <div class="size-2 bg-[currentColor] rounded-full absolute -top-2" />
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
        </Show>
        <For each={segments()}>
          {(segment, i) => (
            <div
              class="border border-blue-300 rounded-[calc(0.75rem+1px)] relative h-[3rem]"
              style={{
                width: `${(100 * (segment.end - segment.start)) / duration()}%`,
              }}
              onMouseDown={(e) => {
                if (!split()) return;
                e.stopPropagation();

                const rect = e.currentTarget.getBoundingClientRect();
                const fraction = (e.clientX - rect.left) / rect.width;

                const splitTime =
                  segment.start + fraction * (segment.end - segment.start);

                setProject(
                  "timeline",
                  "segments",
                  produce((segments) => {
                    console.log({ splitTime });
                    segments.splice(i() + 1, 0, {
                      start: splitTime,
                      end: segment.end,
                      timescale: 1,
                    });
                    segments[i()].end = splitTime;
                  })
                );
              }}
            >
              <div class="h-full border border-white ring-1 ring-blue-300 flex flex-row rounded-xl overflow-hidden group">
                <div
                  class="bg-blue-300 w-[0.5rem] cursor-col-resize"
                  onMouseDown={(downEvent) => {
                    const start = segment.start;

                    const maxDuration =
                      editorInstance.recordingDuration -
                      segments().reduce(
                        (acc, segment, segmentI) =>
                          segmentI === i()
                            ? acc
                            : acc +
                              (segment.end - segment.start) / segment.timescale,
                        0
                      );

                    function update(event: MouseEvent) {
                      const { width } = timelineBounds;

                      const newStart =
                        start +
                        ((event.clientX - downEvent.clientX) / width!) *
                          duration();

                      setProject(
                        "timeline",
                        "segments",
                        i(),
                        "start",
                        Math.min(
                          Math.max(
                            newStart,
                            // Math.max(newStart, 0),
                            segment.end - maxDuration
                          ),
                          segment.end - 1
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
                <div class="bg-blue-50 relative w-full h-full flex flex-row items-center justify-between px-[0.5rem] py-[0.25rem]">
                  <span class="text-black-transparent-60 text-[0.625rem] mt-auto">
                    {formatTime(segment.start)}
                  </span>
                  <Show when={segments().length > 1}>
                    <button
                      onClick={() => {
                        setProject(
                          "timeline",
                          "segments",
                          produce((segments) => {
                            segments.splice(i(), 1);
                          })
                        );
                      }}
                      class="size-7 opacity-0 group/button group-hover:opacity-100 transition-opacity bg-gray-50 rounded-full flex flex-col items-center justify-center"
                    >
                      <IconCapTrash class="size-4 text-gray-400 group-hover/button:text-gray-500 transition-colors" />
                    </button>
                  </Show>
                  <span class="text-black-transparent-60 text-[0.625rem] mt-auto">
                    {formatTime(segment.end)}
                  </span>
                </div>
                <div
                  class="bg-blue-300 w-[0.5rem] cursor-col-resize"
                  onMouseDown={(downEvent) => {
                    const end = segment.end;

                    const maxDuration =
                      editorInstance.recordingDuration -
                      segments().reduce(
                        (acc, segment, segmentI) =>
                          segmentI === i()
                            ? acc
                            : acc +
                              (segment.end - segment.start) / segment.timescale,
                        0
                      );

                    function update(event: MouseEvent) {
                      const { width } = timelineBounds;

                      const newEnd =
                        end +
                        ((event.clientX - downEvent.clientX) / width!) *
                          duration();

                      setProject(
                        "timeline",
                        "segments",
                        i(),
                        "end",
                        Math.max(
                          Math.min(newEnd, segment.start + maxDuration),
                          segment.start + 1
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
          )}
        </For>
      </div>
    </div>
  );
}
