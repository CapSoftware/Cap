import {
  createEventListener,
  createEventListenerMap,
} from "@solid-primitives/event-listener";
import { Menu } from "@tauri-apps/api/menu";
import { cx } from "cva";
import {
  batch,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  Show,
} from "solid-js";
import { produce } from "solid-js/store";
import { commands } from "~/utils/tauri";
import { useEditorContext } from "../context";
import {
  useSegmentContext,
  useTimelineContext,
  useTrackContext,
} from "./context";
import { SegmentContent, SegmentHandle, SegmentRoot, TrackRoot } from "./Track";

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

  // When we delete a segment that's being hovered, the onMouseLeave never fires
  // because the element gets removed from the DOM. This leaves hoveringSegment stuck
  // as true, which blocks the onMouseMove from setting hoveredTime, preventing
  // users from creating new segments. This effect ensures we reset the hover state
  // when all segments are deleted.
  createEffect(() => {
    const segments = project.timeline?.zoomSegments;
    if (!segments || segments.length === 0) {
      setHoveringSegment(false);
      setHoveredTime(undefined);
    }
  });

  const handleGenerateZoomSegments = async () => {
    try {
      const zoomSegments = await commands.generateZoomSegmentsFromClicks();
      setProject("timeline", "zoomSegments", zoomSegments);
    } catch (error) {
      console.error("Failed to generate zoom segments:", error);
    }
  };

  return (
    <TrackRoot
      onContextMenu={async (e) => {
        if (!import.meta.env.DEV) return;

        e.preventDefault();
        const menu = await Menu.new({
          id: "zoom-track-options",
          items: [
            {
              id: "generateZoomSegments",
              text: "Generate zoom segments from clicks",
              action: handleGenerateZoomSegments,
            },
          ],
        });
        menu.popup();
      }}
      onMouseMove={(e) => {
        if (hoveringSegment()) {
          setHoveredTime(undefined);
          return;
        }

        const bounds = e.currentTarget.getBoundingClientRect()!;

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
          <div class="text-center text-sm text-[--text-tertiary] flex flex-col justify-center items-center inset-0 w-full bg-gray-3/20 dark:bg-gray-3/10 hover:bg-gray-3/30 dark:hover:bg-gray-3/20 transition-colors rounded-xl pointer-events-none">
            <div>Click to add zoom segment</div>
            <div class="text-[10px] text-[--text-tertiary]/40 mt-0.5">
              (Smoothly zoom in on important areas)
            </div>
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
            return (downEvent: MouseEvent) => {
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

                  const currentSelection = editorState.timeline.selection;
                  const segmentIndex = i();

                  // Handle multi-selection with Ctrl/Cmd+click
                  if (e.ctrlKey || e.metaKey) {
                    if (currentSelection?.type === "zoom") {
                      // Normalize to indices[] from either indices[] or legacy index
                      const baseIndices =
                        "indices" in currentSelection &&
                        Array.isArray(currentSelection.indices)
                          ? currentSelection.indices
                          : "index" in currentSelection &&
                            typeof currentSelection.index === "number"
                          ? [currentSelection.index]
                          : [];

                      const exists = baseIndices.includes(segmentIndex);
                      const newIndices = exists
                        ? baseIndices.filter((idx) => idx !== segmentIndex)
                        : [...baseIndices, segmentIndex];

                      setEditorState("timeline", "selection", {
                        type: "zoom",
                        indices: newIndices,
                      });
                    } else {
                      // Start new multi-selection
                      setEditorState("timeline", "selection", {
                        type: "zoom",
                        indices: [segmentIndex],
                      });
                    }
                  } else {
                    setEditorState("timeline", "selection", {
                      type: "zoom",
                      indices: [segmentIndex],
                    });
                  }
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

          const isSelected = createMemo(() => {
            const selection = editorState.timeline.selection;
            if (!selection || selection.type !== "zoom") return false;

            const segmentIndex = project.timeline?.zoomSegments?.findIndex(
              (s) => s.start === segment.start && s.end === segment.end
            );

            // Support both single selection (index) and multi-selection (indices)
            if (
              "indices" in selection &&
              Array.isArray(selection.indices) &&
              segmentIndex !== undefined
            ) {
              return selection.indices.includes(segmentIndex);
            } else if (
              "index" in selection &&
              typeof selection.index === "number"
            ) {
              return segmentIndex === selection.index;
            }

            return false;
          });

          return (
            <SegmentRoot
              class={cx(
                "border duration-200 hover:border-gray-12 transition-colors group",
                "bg-gradient-to-r from-[#292929] via-[#434343] to-[#292929] shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]",
                isSelected()
                  ? "wobble-wrapper border-gray-12"
                  : "border-transparent"
              )}
              innerClass="ring-red-5"
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

                    const maxValue = segment.end - 1;

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

                    setProject(
                      "timeline",
                      "zoomSegments",
                      produce((s) => {
                        s.sort((a, b) => a.start - b.start);
                      })
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
                  const width = ctx.width();

                  if (width < 40) {
                    // Very small - just show icon
                    return (
                      <div class="flex justify-center items-center">
                        <IconLucideSearch class="size-3.5 text-gray-1 dark:text-gray-12" />
                      </div>
                    );
                  } else if (width < 100) {
                    // Small - show icon and zoom amount
                    return (
                      <div class="flex gap-1 items-center text-xs whitespace-nowrap text-gray-1 dark:text-gray-12">
                        <IconLucideSearch class="size-3" />
                        <span>{zoomPercentage()}</span>
                      </div>
                    );
                  } else {
                    // Large - show full content
                    return (
                      <div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-1 dark:text-gray-12 animate-in fade-in">
                        <span class="opacity-70">Zoom</span>
                        <div class="flex gap-1 items-center text-md">
                          <IconLucideSearch class="size-3.5" />
                          {zoomPercentage()}
                        </div>
                      </div>
                    );
                  }
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

                    setProject(
                      "timeline",
                      "zoomSegments",
                      produce((s) => {
                        s.sort((a, b) => a.start - b.start);
                      })
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
            <SegmentContent class="bg-gradient-to-r hover:border duration-200 hover:border-gray-500 from-[#292929] via-[#434343] to-[#292929] transition-colors group shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]">
              <p class="w-full text-center text-gray-1 dark:text-gray-12 text-md text-primary">
                +
              </p>
            </SegmentContent>
          </SegmentRoot>
        )}
      </Show>
    </TrackRoot>
  );
}
