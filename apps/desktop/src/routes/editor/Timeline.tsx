import { createElementBounds } from "@solid-primitives/bounds";
import {
  createEventListener,
  createEventListenerMap,
} from "@solid-primitives/event-listener";
import { mergeRefs } from "@solid-primitives/refs";
import { cx } from "cva";
import {
  ComponentProps,
  For,
  Show,
  batch,
  createMemo,
  createRoot,
  createSignal,
  onMount,
} from "solid-js";
import { produce } from "solid-js/store";
import "~/styles/timeline.css";

import { platform } from "@tauri-apps/plugin-os";
import { TimelineSegment } from "~/utils/tauri";
import {
  SegmentContextProvider,
  TimelineContextProvider,
  TrackContextProvider,
  useEditorContext,
  useSegmentContext,
  useTimelineContext,
  useTrackContext,
} from "./context";
import { formatTime } from "./utils";

type ZoomSegmentDragState =
  | { type: "idle" }
  | { type: "movePending" }
  | { type: "moving" };

const MAX_TIMELINE_MARKINGS = 20;
const TIMELINE_MARKING_RESOLUTIONS = [0.5, 1, 2.5, 5, 10, 30];

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

  const xPadding = 20;

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
          "padding-left": `${xPadding}px`,
          "padding-right": `${xPadding}px`,
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

            state.timelineTransform.setPosition(
              state.timelineTransform.position + secsPerPixel() * delta
            );
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
                left: `${xPadding}px`,
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
              left: `${xPadding}px`,
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
  const { secsPerPixel } = useTimelineContext();

  const timelineMarkings = () => {
    const resolution =
      TIMELINE_MARKING_RESOLUTIONS.find(
        (r) => state.timelineTransform.zoom / r <= MAX_TIMELINE_MARKINGS
      ) ?? 30;

    const diff = state.timelineTransform.position % resolution;

    return Array.from(
      { length: (state.timelineTransform.zoom + 5) / resolution },
      (_, i) => state.timelineTransform.position - diff + (i + 1) * resolution
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

function ClipTrack(props: Pick<ComponentProps<"div">, "ref">) {
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
              {(() => {
                // Calculate markings based on the original segment timing, not the timeline position
                const resolution =
                  TIMELINE_MARKING_RESOLUTIONS.find(
                    (r) =>
                      state.timelineTransform.zoom / r <= MAX_TIMELINE_MARKINGS
                  ) ?? 30;

                // Align markings with the original segment start time
                const segmentStartTime = segment.start;
                const diff = segmentStartTime % resolution;

                // Calculate how many markings should be visible in this segment
                const segmentDuration = segment.end - segment.start;
                const markingCount = Math.ceil(segmentDuration / resolution);

                // Generate the markings
                const markings = Array.from(
                  { length: markingCount + 1 },
                  (_, i) => {
                    const markingTime =
                      segmentStartTime - diff + i * resolution;
                    // Only show markings that are within the segment
                    if (
                      markingTime >= segmentStartTime &&
                      markingTime <= segment.end
                    ) {
                      return (
                        <div
                          style={{
                            translate: `transformX(${
                              (markingTime - segmentStartTime) / secsPerPixel()
                            }px)`,
                          }}
                          class="absolute z-10 w-px h-12 bg-gradient-to-b from-transparent to-transparent via-white-transparent-40 dark:via-black-transparent-60"
                        />
                      );
                    }
                    return null;
                  }
                );

                return markings;
              })()}

              <SegmentHandle
                position="start"
                class={cx(
                  "absolute opacity-0 inset-y-0 z-10",
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
                        <span class="text-solid-white opacity-60">Clip</span>
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
                  "absolute opacity-0 inset-y-0 z-10",
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

function ZoomTrack(props: {
  onDragStateChanged: (v: ZoomSegmentDragState) => void;
  handleUpdatePlayhead: (e: MouseEvent) => void;
}) {
  const { project, setProject, history, setState, state } = useEditorContext();

  const { duration, secsPerPixel } = useTimelineContext();

  const [hoveringSegment, setHoveringSegment] = createSignal(false);
  const [hoveredTime, setHoveredTime] = createSignal<number>();

  return (
    <TrackRoot
      onMouseMove={(e) => {
        if (hoveringSegment()) {
          setHoveredTime(undefined);
          return;
        }

        const bounds = e.target.getBoundingClientRect()!;

        let time =
          (e.clientX - bounds.left) * secsPerPixel() +
          state.timelineTransform.position;

        const nextSegmentIndex = project.timeline?.zoomSegments?.findIndex(
          (s) => time < s.start
        );

        if (nextSegmentIndex !== undefined) {
          const prevSegmentIndex = nextSegmentIndex - 1;

          if (prevSegmentIndex === undefined) return;

          const nextSegment =
            project.timeline?.zoomSegments?.[nextSegmentIndex];

          if (prevSegmentIndex !== undefined && nextSegment) {
            const prevSegment =
              project.timeline?.zoomSegments?.[prevSegmentIndex];

            if (prevSegment) {
              const availableTime = nextSegment?.start - prevSegment?.end;

              if (availableTime < 1) return;
            }
          }

          if (nextSegment && nextSegment.start - time < 1) {
            time = nextSegment.start - 1;
          }
        }

        setHoveredTime(Math.min(time, duration() - 1));
      }}
      onMouseLeave={() => setHoveredTime()}
      onMouseDown={(e) => {
        createRoot((dispose) => {
          createEventListener(e.currentTarget, "mouseup", (e) => {
            dispose();

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

                  let index = zoomSegments.length;

                  for (let i = zoomSegments.length - 1; i >= 0; i--) {
                    if (zoomSegments[i].start > time) {
                      index = i;
                      break;
                    }
                  }

                  zoomSegments.splice(index, 0, {
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
          });
        });
      }}
    >
      <Show
        when={!useTrackContext().trackState.draggingSegment && hoveredTime()}
      >
        {(time) => (
          <SegmentRoot
            class="pointer-events-none"
            innerClass="ring-red-300"
            segment={{
              start: time(),
              end: time() + 1,
            }}
          >
            <SegmentContent class="bg-gradient-to-r zoom-gradient-border hover:border duration-300 hover:border-gray-500 from-[#292929] via-[#434343] to-[#292929] transition-colors group shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]">
              <p class="w-full text-center dark:text-gray-500 text-md text-primary text-gray-50">
                +
              </p>
            </SegmentContent>
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

          const zoomSegments = () => project.timeline!.zoomSegments!;

          function createMouseDownDrag<T>(
            setup: () => T,
            _update: (e: MouseEvent, v: T, initialMouseX: number) => void
          ) {
            return function (downEvent: MouseEvent) {
              downEvent.stopPropagation();

              const initial = setup();

              let moved = false;
              let initialMouseX: null | number = null;

              setTrackState("draggingSegment", true);

              const resumeHistory = history.pause();

              props.onDragStateChanged({ type: "movePending" });

              function finish(e: MouseEvent) {
                resumeHistory();
                if (!moved) {
                  e.stopPropagation();
                  setState("timelineSelection", {
                    type: "zoom",
                    index: i(),
                  });
                  props.handleUpdatePlayhead(e);
                }
                props.onDragStateChanged({ type: "idle" });
                setTrackState("draggingSegment", false);
              }

              function update(event: MouseEvent) {
                if (Math.abs(event.clientX - downEvent.clientX) > 2) {
                  if (!moved) {
                    moved = true;
                    initialMouseX = event.clientX;
                    props.onDragStateChanged({
                      type: "moving",
                    });
                  }
                }

                if (initialMouseX === null) return;

                _update(event, initial, initialMouseX);
              }

              createRoot((dispose) => {
                createEventListenerMap(window, {
                  mousemove: (e) => {
                    update(e);
                  },
                  mouseup: (e) => {
                    update(e);
                    finish(e);
                    dispose();
                  },
                });
              });
            };
          }

          return (
            <SegmentRoot
              class="bg-gradient-to-r zoom-gradient-border hover:border duration-300 hover:border-gray-500 from-[#292929] via-[#434343] to-[#292929] transition-colors group shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]"
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
                position="start"
                class="absolute group-hover:opacity-100 opacity-0"
                onMouseDown={createMouseDownDrag(
                  () => {
                    const start = segment.start;

                    let minValue = 0;

                    let maxValue = segment.end - 1;

                    for (let i = zoomSegments().length - 1; i >= 0; i--) {
                      const segment = zoomSegments()[i]!;
                      if (segment.end <= start) {
                        minValue = segment.end;
                        break;
                      }
                    }

                    return { start, minValue, maxValue };
                  },
                  (e, value, initialMouseX) => {
                    const newStart =
                      value.start +
                      (e.clientX - initialMouseX) * secsPerPixel();

                    setProject(
                      "timeline",
                      "zoomSegments",
                      i(),
                      "start",
                      Math.min(
                        value.maxValue,
                        Math.max(value.minValue, newStart)
                      )
                    );
                  }
                )}
              />
              <SegmentContent
                class="flex justify-center items-center cursor-pointer"
                onMouseDown={createMouseDownDrag(
                  () => {
                    const original = { ...segment };

                    const prevSegment = zoomSegments()[i() - 1];
                    const nextSegment = zoomSegments()[i() + 1];

                    const minStart = prevSegment?.end ?? 0;
                    const maxEnd = nextSegment?.start ?? duration();

                    return {
                      original,
                      minStart,
                      maxEnd,
                    };
                  },
                  (e, value, initialMouseX) => {
                    const rawDelta =
                      (e.clientX - initialMouseX) * secsPerPixel();

                    const newStart = value.original.start + rawDelta;
                    const newEnd = value.original.end + rawDelta;

                    let delta = rawDelta;

                    if (newStart < value.minStart)
                      delta = value.minStart - value.original.start;
                    else if (newEnd > value.maxEnd)
                      delta = value.maxEnd - value.original.end;

                    setProject("timeline", "zoomSegments", i(), {
                      start: value.original.start + delta,
                      end: value.original.end + delta,
                    });
                  }
                )}
              >
                {(() => {
                  const ctx = useSegmentContext();

                  return (
                    <Show when={ctx.width() > 100}>
                      <div class="flex flex-col gap-1 justify-center items-center text-xs text-gray-50 dark:text-gray-500 whitespace-nowrap">
                        <span class="opacity-70">Zoom</span>
                        <div class="flex gap-1 items-center text-md">
                          <IconLucideSearch class="size-3.5" />{" "}
                          {zoomPercentage()}{" "}
                        </div>
                      </div>
                    </Show>
                  );
                })()}
              </SegmentContent>
              <SegmentHandle
                position="end"
                class="absolute group-hover:opacity-100 opacity-0"
                onMouseDown={createMouseDownDrag(
                  () => {
                    const end = segment.end;

                    const minValue = segment.start + 1;

                    let maxValue = duration();

                    for (let i = 0; i < zoomSegments().length; i++) {
                      const segment = zoomSegments()[i]!;
                      if (segment.start > end) {
                        maxValue = segment.start;
                        break;
                      }
                    }

                    return { end, minValue, maxValue };
                  },
                  (e, value, initialMouseX) => {
                    const newEnd =
                      value.end + (e.clientX - initialMouseX) * secsPerPixel();

                    setProject(
                      "timeline",
                      "zoomSegments",
                      i(),
                      "end",
                      Math.min(value.maxValue, Math.max(value.minValue, newEnd))
                    );
                  }
                )}
              />
            </SegmentRoot>
          );
        }}
      </For>
    </TrackRoot>
  );
}

function TrackRoot(props: ComponentProps<"div">) {
  const [ref, setRef] = createSignal<HTMLDivElement>();

  return (
    <TrackContextProvider ref={ref}>
      <div
        {...props}
        ref={mergeRefs(setRef, props.ref)}
        class={cx("flex flex-row relative h-14", props.class)}
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
    onMouseDown?: (
      e: MouseEvent & { currentTarget: HTMLDivElement; target: Element }
    ) => void;
  }
) {
  const { secsPerPixel } = useTrackContext();
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
    const base = state.timelineTransform.position;

    const delta = props.segment.start;

    return (delta - base) / secsPerPixel();
  });

  const width = () => {
    return (props.segment.end - props.segment.start) / secsPerPixel();
  };

  return (
    <SegmentContextProvider width={width}>
      <div
        {...props}
        class={cx(
          "absolute border rounded-[calc(0.75rem+1px)] inset-y-0 w-full",
          props.class,
          isSelected() && "wobble-wrapper border border-gray-500"
        )}
        style={{
          "--segment-x": `${translateX()}px`,
          transform: "translateX(var(--segment-x))",
          width: `${width()}px`,
        }}
        ref={props.ref}
      >
        <div
          class={cx(
            "h-full flex flex-row rounded-xl overflow-hidden group",
            props.innerClass
          )}
        >
          {props.children}
        </div>
      </div>
    </SegmentContextProvider>
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

function SegmentHandle(
  props: ComponentProps<"div"> & { position: "start" | "end" }
) {
  const ctx = useSegmentContext();
  return (
    <div
      {...props}
      class={cx(
        "w-3 cursor-col-resize shrink-0 data-[hidden='true']:opacity-0 transition-opacity h-full flex flex-row items-center",
        props.position === "start"
          ? "left-0 justify-end"
          : "right-0 justify-start",
        props.class
      )}
      data-hidden={ctx.width() < 50}
    >
      <div class="w-[3px] h-8 bg-solid-white rounded-full" />
    </div>
  );
}
