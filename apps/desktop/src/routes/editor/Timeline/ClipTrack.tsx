import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { ComponentProps, For, Show, createRoot } from "solid-js";
import { produce } from "solid-js/store";

import { TimelineSegment } from "~/utils/tauri";
import { useSegmentContext, useTimelineContext } from "./context";
import { formatTime } from "../utils";
import { SegmentContent, SegmentHandle, SegmentRoot, TrackRoot } from "./Track";
import { useEditorContext } from "../context";

export function ClipTrack(props: Pick<ComponentProps<"div">, "ref">) {
  const {
    project,
    setProject,
    editorInstance,
    history,
    split,
    state,
    totalDuration,
    previewTime,
  } = useEditorContext();

  const { secsPerPixel, duration } = useTimelineContext();

  const segments = (): Array<TimelineSegment> =>
    project.timeline?.segments ?? [{ start: 0, end: duration(), timescale: 1 }];

  function onHandleReleased() {
    if (
      state.timelineTransform.position + state.timelineTransform.zoom >
      totalDuration() + 4
    ) {
      state.timelineTransform.updateZoom(totalDuration(), previewTime()!);
    }
  }

  return (
    <TrackRoot ref={props.ref}>
      <For each={segments()}>
        {(segment, i) => {
          const prevDuration = () =>
            segments()
              .slice(0, i())
              .reduce((t, s) => t + (s.end - s.start) / s.timescale, 0);

          return (
            <SegmentRoot
              class={cx(
                "overflow-hidden border border-transparent transition-colors duration-300 group",
                "hover:border-gray-500"
              )}
              innerClass="ring-blue-300"
              segment={{
                ...segment,
                start: prevDuration(),
                end: segment.end - segment.start + prevDuration(),
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
                    segments.splice(i() + 1, 0, {
                      start: splitTime,
                      end: segment.end,
                      timescale: 1,
                      recordingSegment: segment.recordingSegment,
                    });
                    segments[i()].end = splitTime;
                  })
                );
              }}
            >
              <Markings segment={segment} prevDuration={prevDuration()} />

              <SegmentHandle
                position="start"
                class={cx(
                  "absolute inset-y-0 z-10 opacity-0",
                  "group-hover:opacity-100"
                )}
                onMouseDown={(downEvent) => {
                  const start = segment.start;

                  const maxSegmentDuration =
                    editorInstance.recordings.segments[
                      segment.recordingSegment ?? 0
                    ].display.duration;

                  const availableTimelineDuration =
                    editorInstance.recordingDuration -
                    segments().reduce(
                      (acc, segment, segmentI) =>
                        segmentI === i()
                          ? acc
                          : acc +
                            (segment.end - segment.start) / segment.timescale,
                      0
                    );

                  const maxDuration = Math.min(
                    maxSegmentDuration,
                    availableTimelineDuration
                  );

                  function update(event: MouseEvent) {
                    const newStart =
                      start +
                      (event.clientX - downEvent.clientX) * secsPerPixel();

                    setProject(
                      "timeline",
                      "segments",
                      i(),
                      "start",
                      Math.min(
                        Math.max(
                          Math.max(newStart, 0),
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
                        onHandleReleased();
                      },
                    });
                  });
                }}
              />
              <SegmentContent class="justify-center items-center relative dark:text-black-transparent-60 text-white-transparent-60 bg-gradient-to-r timeline-gradient-border from-[#2675DB] via-[#4FA0FF] to-[#2675DB] shadow-[inset_0_5px_10px_5px_rgba(255,255,255,0.2)]">
                <Show when={segment.start > 0}>
                  <span class="text-black-transparent-60 text-[0.625rem] absolute top-[18px] left-5">
                    {formatTime(segment.start)}
                  </span>
                </Show>
                {(() => {
                  const ctx = useSegmentContext();

                  return (
                    <Show when={ctx.width() > 100}>
                      <div class="flex flex-col gap-1 justify-center items-center text-xs text-gray-500 whitespace-nowrap">
                        <span class="opacity-60 text-solid-white">Clip</span>
                        <div class="flex gap-1 items-center text-gray-50 dark:text-gray-500 text-md">
                          <IconLucideClock class="size-3.5" />{" "}
                          {(segment.end - segment.start).toFixed(1)}s
                        </div>
                      </div>
                    </Show>
                  );
                })()}

                <Show when={segment.end < editorInstance.recordingDuration}>
                  <span class="text-[0.625rem] absolute top-[18px] right-5">
                    {formatTime(segment.end)}
                  </span>
                </Show>
              </SegmentContent>
              <SegmentHandle
                position="end"
                class={cx(
                  "absolute inset-y-0 z-10 opacity-0",
                  "group-hover:opacity-100"
                )}
                onMouseDown={(downEvent) => {
                  const end = segment.end;

                  const maxSegmentDuration =
                    editorInstance.recordings.segments[
                      segment.recordingSegment ?? 0
                    ].display.duration;

                  const availableTimelineDuration =
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
                    const newEnd =
                      end +
                      (event.clientX - downEvent.clientX) * secsPerPixel();

                    setProject(
                      "timeline",
                      "segments",
                      i(),
                      "end",
                      Math.max(
                        Math.min(
                          newEnd,
                          maxSegmentDuration,
                          availableTimelineDuration
                        ),
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
                        onHandleReleased();
                      },
                    });
                  });
                }}
              />
            </SegmentRoot>
          );
        }}
      </For>
    </TrackRoot>
  );
}

function Markings(props: { segment: TimelineSegment; prevDuration: number }) {
  const { state } = useEditorContext();
  const { secsPerPixel, markingResolution } = useTimelineContext();

  const markings = () => {
    const resolution = markingResolution();

    const visibleMin =
      state.timelineTransform.position -
      props.prevDuration +
      props.segment.start;
    const visibleMax = visibleMin + state.timelineTransform.zoom;

    const start = Math.floor(visibleMin / resolution);

    return Array.from(
      { length: Math.ceil(visibleMax / resolution) - start },
      (_, i) => (start + i) * resolution
    );
  };

  return (
    <For each={markings()}>
      {(marking) => (
        <div
          style={{
            transform: `translateX(${
              (marking - props.segment.start) / secsPerPixel()
            }px)`,
          }}
          class="absolute z-10 w-px h-12 bg-gradient-to-b from-transparent to-transparent via-white-transparent-40 dark:via-black-transparent-60"
        />
      )}
    </For>
  );
}
