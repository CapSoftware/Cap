import "~/styles/timeline.css";
import { createElementBounds } from "@solid-primitives/bounds";
import {
  ComponentProps,
  For,
  Show,
  batch,
  createRoot,
  createSignal,
  onMount,
} from "solid-js";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { produce } from "solid-js/store";
import { mergeRefs } from "@solid-primitives/refs";
import { createMemo } from "solid-js";

import { commands, TimelineSegment } from "~/utils/tauri";
import {
  TimelineContextProvider,
  TrackContextProvider,
  useEditorContext,
  useTimelineContext,
  useTrackContext,
} from "./context";
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
    setState,
  } = useEditorContext();

  const duration = () => editorInstance.recordingDuration;

  const [timelineRef, setTimelineRef] = createSignal<HTMLDivElement>();
  const timelineBounds = createElementBounds(timelineRef);

  onMount(() => {
    if (!project.timeline) {
      const resume = history.pause();
      setProject("timeline", {
        segments: [
          { timescale: 1, start: 0, end: duration(), recordingSegment: null },
        ],
      });
      resume();
    }
  });

  const xPadding = 12;

  const segments = (): Array<TimelineSegment> =>
    project.timeline?.segments ?? [
      { start: 0, end: duration(), timescale: 1, recordingSegment: null },
    ];

  if (window.FLAGS.zoom)
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
                recordingSegment: null,
              },
            ],
          };
        })
      );
    }

  return (
    <TimelineContextProvider duration={duration()}>
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
        onClick={() => {
          setState("timelineSelection", null);
        }}
      >
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
            class="w-px bg-red-300 absolute top-4 bottom-0 z-10 pointer-events-none"
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
        <TrackRoot ref={setTimelineRef} isFreeForm={false}>
          <For each={segments()}>
            {(segment, i) => (
              <SegmentRoot
                class="border-blue-300"
                innerClass="ring-blue-300"
                segment={segment}
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
                <SegmentHandle
                  class="bg-blue-300"
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
                        },
                      });
                    });
                  }}
                />
                <SegmentContent class="bg-blue-50 justify-between">
                  <span class="text-black-transparent-60 text-[0.625rem] mt-auto">
                    {formatTime(segment.start)}
                  </span>
                  {/* <Show when={segments().length > 1}>
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
                  </Show> */}
                  <span class="text-black-transparent-60 text-[0.625rem] mt-auto">
                    {formatTime(segment.end)}
                  </span>
                </SegmentContent>
                <SegmentHandle
                  class="bg-blue-300"
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

                    const maxDuration = Math.min(
                      maxSegmentDuration,
                      availableTimelineDuration
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
                        },
                      });
                    });
                  }}
                />
              </SegmentRoot>
            )}
          </For>
        </TrackRoot>
        <Show when={window.FLAGS.zoom}>
          {(_) => {
            const [hoveringSegment, setHoveringSegment] = createSignal(false);
            const [hoveredTime, setHoveredTime] = createSignal<number>();

            return (
              <>
                <div class="h-2 w-full" />

                <TrackRoot
                  isFreeForm
                  onMouseMove={(e) => {
                    if (hoveringSegment()) {
                      setHoveredTime(undefined);
                      return;
                    }

                    const bounds = e.target.getBoundingClientRect()!;

                    let time =
                      ((e.clientX - bounds.left) / bounds.width) * duration();

                    const prevSegmentIndex =
                      project.timeline?.zoomSegments?.findIndex(
                        (s) => s.end < time
                      );

                    const nextSegmentIndex =
                      project.timeline?.zoomSegments?.findIndex(
                        (s) => time < s.start
                      );

                    if (nextSegmentIndex !== undefined) {
                      const nextSegment =
                        project.timeline?.zoomSegments?.[nextSegmentIndex];

                      if (prevSegmentIndex !== undefined && nextSegment) {
                        const prevSegment =
                          project.timeline?.zoomSegments?.[prevSegmentIndex];

                        if (prevSegment) {
                          const availableTime =
                            nextSegment?.start - prevSegment?.end;

                          if (availableTime < 1) return;
                        }
                      }

                      if (nextSegment && nextSegment.start - time < 1) {
                        time = nextSegment.start - 1;
                      }
                    }

                    setHoveredTime(Math.min(time, duration() - 1));
                  }}
                  onMouseLeave={(e) => setHoveredTime()}
                  onClick={(e) => {
                    const time = hoveredTime();
                    if (time === undefined) return;

                    e.stopPropagation();
                    batch(() => {
                      setProject("timeline", "zoomSegments", (v) => v ?? []);
                      setProject(
                        "timeline",
                        "zoomSegments",
                        produce((zoomSegments) => {
                          zoomSegments ??= [];
                          zoomSegments.push({
                            start: time,
                            end: time + 1,
                            amount: 1.5,
                            mode: {
                              manual: {
                                x: 0.5,
                                y: 0.5,
                              },
                            },
                          });
                        })
                      );
                    });
                  }}
                >
                  <Show
                    when={
                      !useTrackContext().trackState.draggingHandle &&
                      hoveredTime()
                    }
                  >
                    {(time) => (
                      <SegmentRoot
                        class="border-red-300 group pointer-events-none opacity-70"
                        innerClass="ring-red-300"
                        segment={{
                          start: time(),
                          end: time() + 1,
                        }}
                      >
                        <SegmentHandle class="bg-red-300" />
                        <SegmentContent class="bg-red-50" />
                        <SegmentHandle class="bg-red-300" />
                      </SegmentRoot>
                    )}
                  </Show>
                  <For each={project.timeline?.zoomSegments}>
                    {(segment, i) => {
                      const { setTrackState } = useTrackContext();

                      const zoomPercentage = () => {
                        const amount = segment.amount;
                        return `${amount.toFixed(1)}x`;
                      };

                      const zoomSegments = () =>
                        project.timeline!.zoomSegments!;

                      return (
                        <SegmentRoot
                          class="border-red-300 group"
                          innerClass="ring-red-300"
                          segment={segment}
                          onMouseEnter={() => {
                            setHoveringSegment(true);
                          }}
                          onMouseLeave={() => {
                            setHoveringSegment(false);
                          }}
                        >
                          <SegmentHandle
                            class="bg-red-300 group-hover:bg-opacity-80 transition-colors"
                            onMouseDown={(downEvent) => {
                              const start = segment.start;

                              let minValue = 0;

                              for (
                                let i = zoomSegments().length - 1;
                                i >= 0;
                                i--
                              ) {
                                const segment = zoomSegments()[i]!;
                                if (segment.end <= start) {
                                  minValue = segment.end;
                                  break;
                                }
                              }

                              let maxValue = segment.end - 1;

                              function update(event: MouseEvent) {
                                const { width } = timelineBounds;

                                const newStart =
                                  start +
                                  ((event.clientX - downEvent.clientX) /
                                    width!) *
                                    duration();

                                setProject(
                                  "timeline",
                                  "zoomSegments",
                                  i(),
                                  "start",
                                  Math.min(
                                    maxValue,
                                    Math.max(minValue, newStart)
                                  )
                                );
                              }

                              setTrackState("draggingHandle", true);

                              const resumeHistory = history.pause();
                              createRoot((dispose) => {
                                createEventListenerMap(window, {
                                  mousemove: update,
                                  mouseup: (e) => {
                                    dispose();
                                    resumeHistory();
                                    update(e);
                                    setTrackState("draggingHandle", false);
                                  },
                                });
                              });
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                          />
                          <SegmentContent
                            class="bg-red-50 cursor-pointer group-hover:bg-opacity-80 transition-colors flex items-center justify-center"
                            onClick={(e) => {
                              setState("timelineSelection", {
                                type: "zoom",
                                index: i(),
                              });
                              e.stopPropagation();
                            }}
                          >
                            <div class="text-xs text-gray-500 whitespace-nowrap flex flex-col justify-center items-center gap-1">
                              <div class="flex items-center gap-1 text-red-300">
                                <IconLucideSearch class="size-3" />{" "}
                                {zoomPercentage()}
                              </div>
                            </div>
                          </SegmentContent>
                          <SegmentHandle
                            class="bg-red-300 group-hover:bg-opacity-80 transition-colors"
                            onMouseDown={(downEvent) => {
                              const end = segment.end;

                              const minValue = segment.start + 1;

                              let maxValue = duration();

                              for (let i = 0; i > zoomSegments().length; i++) {
                                const segment = zoomSegments()[i]!;
                                if (segment.start > end) {
                                  maxValue = segment.end;
                                  break;
                                }
                              }

                              const maxDuration =
                                editorInstance.recordingDuration -
                                segments().reduce(
                                  (acc, segment, segmentI) =>
                                    segmentI === i()
                                      ? acc
                                      : acc +
                                        (segment.end - segment.start) /
                                          segment.timescale,
                                  0
                                );

                              function update(event: MouseEvent) {
                                const { width } = timelineBounds;

                                const newEnd =
                                  end +
                                  ((event.clientX - downEvent.clientX) /
                                    width!) *
                                    duration();

                                setProject(
                                  "timeline",
                                  "zoomSegments",
                                  i(),
                                  "end",
                                  Math.min(maxValue, Math.max(minValue, newEnd))
                                );
                              }

                              setTrackState("draggingHandle", true);

                              const resumeHistory = history.pause();
                              createRoot((dispose) => {
                                createEventListenerMap(window, {
                                  mousemove: update,
                                  mouseup: (e) => {
                                    dispose();
                                    resumeHistory();
                                    update(e);
                                    setTrackState("draggingHandle", false);
                                  },
                                });
                              });
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                          />
                        </SegmentRoot>
                      );
                    }}
                  </For>
                </TrackRoot>
              </>
            );
          }}
        </Show>
      </div>
    </TimelineContextProvider>
  );
}

function TrackRoot(props: ComponentProps<"div"> & { isFreeForm: boolean }) {
  const [ref, setRef] = createSignal<HTMLDivElement>();

  return (
    <TrackContextProvider ref={ref} isFreeForm={() => props.isFreeForm}>
      <div
        {...props}
        ref={mergeRefs(setRef, props.ref)}
        class={cx("flex flex-row relative h-[3rem]", props.class)}
      >
        {props.children}
      </div>
    </TrackContextProvider>
  );
}

function SegmentRoot(
  props: ComponentProps<"div"> & {
    innerClass: string;
    segment: { start: number; end: number };
  }
) {
  const { duration } = useTimelineContext();
  const { trackBounds, isFreeForm } = useTrackContext();
  const { state, project } = useEditorContext();

  const isSelected = createMemo(() => {
    const selection = state.timelineSelection;
    if (!selection || selection.type !== "zoom") return false;

    const segmentIndex = project.timeline?.zoomSegments?.findIndex(
      (s) => s.start === props.segment.start && s.end === props.segment.end
    );

    return segmentIndex === selection.index;
  });

  const translateX = createMemo(() => {
    if (!isFreeForm()) return 0;
    return (props.segment.start / duration()) * (trackBounds.width ?? 0);
  });

  return (
    <div
      {...props}
      class={cx(
        "border rounded-[calc(0.75rem+1px)] h-[3rem] w-full",
        props.class,
        isSelected() && "wobble-wrapper",
        isFreeForm() && "absolute"
      )}
      style={{
        "--segment-x": `${translateX()}px`,
        transform: isFreeForm() ? "translateX(var(--segment-x))" : undefined,
        width: `${
          (100 * (props.segment.end - props.segment.start)) / duration()
        }%`,
      }}
      onMouseDown={props.onMouseDown}
      ref={props.ref}
    >
      <div
        class={cx(
          "h-full border border-white ring-1 flex flex-row rounded-xl overflow-hidden group",
          props.innerClass
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

function SegmentContent(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      class={cx(
        "relative w-full h-full flex flex-row items-center px-[0.5rem] py-[0.25rem]",
        props.class
      )}
    />
  );
}

function SegmentHandle(props: ComponentProps<"div">) {
  return (
    <div {...props} class={cx("w-[0.5rem] cursor-col-resize", props.class)} />
  );
}
