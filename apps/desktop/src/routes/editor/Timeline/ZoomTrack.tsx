import {
  createEventListener,
  createEventListenerMap,
} from "@solid-primitives/event-listener";
import { For, Show, batch, createRoot, createSignal } from "solid-js";
import { produce } from "solid-js/store";

import {
  useSegmentContext,
  useTimelineContext,
  useTrackContext,
} from "./context";
import { SegmentContent, SegmentHandle, SegmentRoot, TrackRoot } from "./Track";
import { useEditorContext } from "../context";

export type ZoomSegmentDragState =
  | { type: "idle" }
  | { type: "movePending" }
  | { type: "moving" };

export function ZoomTrack(props: {
  onDragStateChanged: (v: ZoomSegmentDragState) => void;
  handleUpdatePlayhead: (e: MouseEvent) => void;
}) {
  const { project, setProject, projectHistory, setEditorState, editorState } =
    useEditorContext();

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
          editorState.timeline.transform.position;

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
      <For
        each={project.timeline?.zoomSegments}
        fallback={
          <div class="text-center text-sm text-[--text-tertiary] flex flex-col justify-center items-center inset-0 w-full bg-black-transparent-5 hover:opacity-30 transition-opacity rounded-xl">
            Click to add zoom segment
          </div>
        }
      >
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

              const resumeHistory = projectHistory.pause();

              props.onDragStateChanged({ type: "movePending" });

              function finish(e: MouseEvent) {
                resumeHistory();
                if (!moved) {
                  e.stopPropagation();
                  setEditorState("timeline", "selection", {
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
                class="flex justify-center items-center cursor-grab"
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
                      <div class="flex flex-col gap-1 justify-center items-center text-xs text-gray-50 whitespace-nowrap dark:text-gray-500 animate-in fade-in">
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
              <p class="w-full text-center text-gray-50 dark:text-gray-500 text-md text-primary">
                +
              </p>
            </SegmentContent>
          </SegmentRoot>
        )}
      </Show>
    </TrackRoot>
  );
}
