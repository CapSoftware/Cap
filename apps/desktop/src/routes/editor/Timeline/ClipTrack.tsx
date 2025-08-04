import {
  createEventListener,
  createEventListenerMap,
} from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
  ComponentProps,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createRoot,
  mergeProps,
} from "solid-js";
import { produce } from "solid-js/store";

import { TimelineSegment } from "~/utils/tauri";
import { useEditorContext } from "../context";
import { useSegmentContext, useTimelineContext } from "./context";
import {
  SegmentContent,
  SegmentHandle,
  SegmentRoot,
  TrackRoot,
  useSegmentTranslateX,
  useSegmentWidth,
} from "./Track";
import { getSectionMarker } from "./sectionMarker";

function WaveformCanvas(props: {
  systemWaveform?: number[];
  micWaveform?: number[];
  segment: { start: number; end: number };
  secsPerPixel: number;
}) {
  const { project } = useEditorContext();

  let canvas: HTMLCanvasElement | undefined;
  const { width } = useSegmentContext();
  const { secsPerPixel } = useTimelineContext();

  const render = (
    ctx: CanvasRenderingContext2D,
    h: number,
    waveform: number[],
    color: string,
    gain = 0
  ) => {
    const maxAmplitude = h;

    // yellow please
    ctx.fillStyle = color;
    ctx.beginPath();

    const step = 0.05 / secsPerPixel();

    ctx.moveTo(0, h);

    const norm = (w: number) => 1.0 - Math.max(w + gain, -60) / -60;

    for (
      let segmentTime = props.segment.start;
      segmentTime <= props.segment.end + 0.1;
      segmentTime += 0.1
    ) {
      const index = Math.floor(segmentTime * 10);
      const xTime = index / 10;

      const amplitude = norm(waveform[index]) * maxAmplitude;

      const x = (xTime - props.segment.start) / secsPerPixel();
      const y = h - amplitude;

      const prevX = (xTime - 0.1 - props.segment.start) / secsPerPixel();
      const prevAmplitude = norm(waveform[index - 1]) * maxAmplitude;
      const prevY = h - prevAmplitude;

      const cpX1 = prevX + step / 2;
      const cpX2 = x - step / 2;

      ctx.bezierCurveTo(cpX1, prevY, cpX2, y, x, y);
    }

    ctx.lineTo(
      (props.segment.end + 0.3 - props.segment.start) / secsPerPixel(),
      h
    );

    ctx.closePath();
    ctx.fill();
  };

  function renderWaveforms() {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = width();
    if (w <= 0) return;

    const h = canvas.height;
    canvas.width = w;
    ctx.clearRect(0, 0, w, h);

    if (props.micWaveform)
      render(
        ctx,
        h,
        props.micWaveform,
        "rgba(255,255,255,0.4)",
        project.audio.micVolumeDb
      );

    if (props.systemWaveform)
      render(
        ctx,
        h,
        props.systemWaveform,
        "rgba(255,150,0,0.5)",
        project.audio.systemVolumeDb
      );
  }

  createEffect(() => {
    renderWaveforms();
  });

  return (
    <canvas
      ref={(el) => {
        canvas = el;
        renderWaveforms();
      }}
      class="absolute inset-0 w-full h-full pointer-events-none"
      height={52}
    />
  );
}

export function ClipTrack(
  props: Pick<ComponentProps<"div">, "ref"> & {
    handleUpdatePlayhead: (e: MouseEvent) => void;
  }
) {
  const {
    project,
    setProject,
    projectActions,
    editorInstance,
    projectHistory,
    editorState,
    setEditorState,
    totalDuration,
    micWaveforms,
    systemAudioWaveforms,
    metaQuery,
  } = useEditorContext();

  const { secsPerPixel, duration } = useTimelineContext();

  const segments = (): Array<TimelineSegment> =>
    project.timeline?.segments ?? [{ start: 0, end: duration(), timescale: 1 }];

  function onHandleReleased() {
    const { transform } = editorState.timeline;

    if (transform.position + transform.zoom > totalDuration() + 4) {
      transform.updateZoom(totalDuration(), editorState.previewTime!);
    }
  }

  const hasMultipleRecordingSegments = () =>
    editorInstance.recordings.segments.length > 1;

  return (
    <TrackRoot ref={props.ref}>
      <For each={segments()}>
        {(segment, i) => {
          const prevDuration = () =>
            segments()
              .slice(0, i())
              .reduce((t, s) => t + (s.end - s.start) / s.timescale, 0);

          const relativeSegment = mergeProps(segment, () => ({
            start: prevDuration(),
            end: segment.end - segment.start + prevDuration(),
          }));

          const segmentX = useSegmentTranslateX(() => relativeSegment);
          const segmentWidth = useSegmentWidth(() => relativeSegment);

          const segmentRecording = (s = i()) =>
            editorInstance.recordings.segments[
              segments()[s].recordingSegment ?? 0
            ];

          const marker = useSectionMarker(() => ({
            segments: segments(),
            i: i(),
            position: "left",
          }));

          const endMarker = useSectionMarker(() => ({
            segments: segments(),
            i: i(),
            position: "right",
          }));

          const isSelected = createMemo(() => {
            const selection = editorState.timeline.selection;
            if (!selection || selection.type !== "clip") return false;

            const segmentIndex = project.timeline?.segments?.findIndex(
              (s) => s.start === segment.start && s.end === segment.end
            );

            return segmentIndex === selection.index;
          });

          const micWaveform = () => {
            if (project.audio.micVolumeDb && project.audio.micVolumeDb < -30)
              return;

            const idx = segment.recordingSegment ?? i();
            return micWaveforms()?.[idx] ?? [];
          };

          const systemAudioWaveform = () => {
            if (
              project.audio.systemVolumeDb &&
              project.audio.systemVolumeDb <= -30
            )
              return;

            const idx = segment.recordingSegment ?? i();
            return systemAudioWaveforms()?.[idx] ?? [];
          };

          return (
            <>
              <Show when={marker()}>
                {(marker) => (
                  <div
                    class="absolute w-0 z-10 h-full *:absolute"
                    style={{
                      transform: `translateX(${
                        i() === 0 ? segmentX() : segmentX()
                      }px)`,
                    }}
                  >
                    <div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-gradient-to-b -translate-x-1/2" />
                    <Switch>
                      <Match
                        when={(() => {
                          const m = marker();
                          if (m.type === "single") return m.value;
                        })()}
                      >
                        {(marker) => (
                          <div class="h-7 -top-8 overflow-hidden rounded-full -translate-x-1/2 z-10">
                            <CutOffsetButton
                              value={(() => {
                                const m = marker();
                                return m.type === "time" ? m.time : 0;
                              })()}
                              onClick={() => {
                                setProject(
                                  "timeline",
                                  "segments",
                                  produce((s) => {
                                    if (marker().type === "reset") {
                                      s[i() - 1].end = s[i()].end;
                                      s.splice(i(), 1);
                                    } else {
                                      s[i() - 1].end = s[i()].start;
                                    }
                                  })
                                );
                              }}
                            />
                          </div>
                        )}
                      </Match>
                      <Match
                        when={(() => {
                          const m = marker();
                          if (
                            m.type === "dual" &&
                            m.right &&
                            m.right.type === "time"
                          )
                            return m.right;
                        })()}
                      >
                        {(marker) => {
                          const markerValue = marker();
                          return (
                            <div class="h-7 w-0 absolute -top-8 flex flex-row rounded-full">
                              <CutOffsetButton
                                value={
                                  markerValue.type === "time"
                                    ? markerValue.time
                                    : 0
                                }
                                class="-left-px absolute rounded-r-full !pl-1.5 rounded-tl-full"
                                onClick={() => {
                                  setProject(
                                    "timeline",
                                    "segments",
                                    i(),
                                    "start",
                                    0
                                  );
                                }}
                              />
                            </div>
                          );
                        }}
                      </Match>
                    </Switch>
                  </div>
                )}
              </Show>
              <SegmentRoot
                class={cx(
                  "border transition-colors duration-200 group hover:border-gray-12",
                  "bg-gradient-to-r from-[#2675DB] via-[#4FA0FF] to-[#2675DB] shadow-[inset_0_5px_10px_5px_rgba(255,255,255,0.2)]",
                  isSelected()
                    ? "wobble-wrapper border-gray-12"
                    : "border-transparent"
                )}
                innerClass="ring-blue-9"
                segment={relativeSegment}
                onMouseDown={(e) => {
                  e.stopPropagation();

                  if (editorState.timeline.interactMode === "split") {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const fraction = (e.clientX - rect.left) / rect.width;

                    const splitTime = fraction * (segment.end - segment.start);

                    projectActions.splitClipSegment(prevDuration() + splitTime);
                  } else {
                    createRoot((dispose) => {
                      createEventListener(e.currentTarget, "mouseup", (e) => {
                        dispose();

                        setEditorState("timeline", "selection", {
                          type: "clip",
                          index: i(),
                        });
                        props.handleUpdatePlayhead(e);
                      });
                    });
                  }
                }}
              >
                <WaveformCanvas
                  micWaveform={micWaveform()}
                  systemWaveform={systemAudioWaveform()}
                  segment={segment}
                  secsPerPixel={secsPerPixel()}
                />

                <Markings segment={segment} prevDuration={prevDuration()} />

                <SegmentHandle
                  position="start"
                  class="opacity-0 group-hover:opacity-100"
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

                    const prevSegment = segments()[i() - 1];
                    const prevSegmentIsSameClip =
                      prevSegment?.recordingSegment !== undefined
                        ? prevSegment.recordingSegment ===
                          segment.recordingSegment
                        : false;

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
                            newStart,
                            prevSegmentIsSameClip ? prevSegment.end : 0,
                            segment.end - maxDuration
                          ),
                          segment.end - 1
                        )
                      );
                    }

                    const resumeHistory = projectHistory.pause();
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
                <SegmentContent class="relative justify-center items-center">
                  {(() => {
                    const ctx = useSegmentContext();

                    return (
                      <Show when={ctx.width() > 100}>
                        <div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-12">
                          <span class="text-white/70">
                            {hasMultipleRecordingSegments()
                              ? `Clip ${segment.recordingSegment}`
                              : "Clip"}
                          </span>
                          <div class="flex gap-1 items-center text-md dark:text-gray-12 text-gray-1">
                            <IconLucideClock class="size-3.5" />{" "}
                            {(segment.end - segment.start).toFixed(1)}s
                          </div>
                        </div>
                      </Show>
                    );
                  })()}
                </SegmentContent>
                <SegmentHandle
                  position="end"
                  class="opacity-0 group-hover:opacity-100"
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

                    const nextSegment = segments()[i() + 1];
                    const nextSegmentIsSameClip =
                      nextSegment?.recordingSegment !== undefined
                        ? nextSegment.recordingSegment ===
                          segment.recordingSegment
                        : false;

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
                            segment.end + availableTimelineDuration,
                            nextSegmentIsSameClip
                              ? nextSegment.start
                              : maxSegmentDuration
                          ),
                          segment.start + 1
                        )
                      );
                    }

                    const resumeHistory = projectHistory.pause();
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
              <Show
                when={(() => {
                  const m = endMarker();
                  if (m?.type === "dual" && m.left && m.left.type === "time")
                    return m.left;
                })()}
              >
                {(marker) => (
                  <div
                    class="absolute w-0 z-10 h-full *:absolute"
                    style={{
                      transform: `translateX(${segmentX() + segmentWidth()}px)`,
                    }}
                  >
                    <div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-gradient-to-b -translate-x-1/2" />
                    <div class="h-7 w-0 absolute -top-8 flex flex-row rounded-full">
                      <CutOffsetButton
                        value={(() => {
                          const m = marker();
                          return m.type === "time" ? m.time : 0;
                        })()}
                        class="-right-px absolute rounded-l-full !pr-1.5 rounded-tr-full"
                        onClick={() => {
                          setProject(
                            "timeline",
                            "segments",
                            i(),
                            "end",
                            segmentRecording().display.duration
                          );
                        }}
                      />
                    </div>
                  </div>
                )}
              </Show>
            </>
          );
        }}
      </For>
    </TrackRoot>
  );
}

function Markings(props: { segment: TimelineSegment; prevDuration: number }) {
  const { editorState } = useEditorContext();
  const { secsPerPixel, markingResolution } = useTimelineContext();

  const markings = () => {
    const resolution = markingResolution();

    const { transform } = editorState.timeline;
    const visibleMin =
      transform.position - props.prevDuration + props.segment.start;
    const visibleMax = visibleMin + transform.zoom;

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

function CutOffsetButton(props: {
  value: number;
  class?: string;
  onClick?(): void;
}) {
  const formatTime = (t: number) =>
    t < 1 ? Math.round(t * 10) / 10 : Math.round(t);

  return (
    <button
      class={cx(
        "h-7 bg-red-300 hover:bg-red-400 text-xs tabular-nums text-white p-2 flex flex-row items-center transition-colors",
        props.class
      )}
      onClick={() => props.onClick?.()}
    >
      {props.value === 0 ? (
        <IconCapScissors class="size-3.5" />
      ) : (
        <>{formatTime(props.value)}s</>
      )}
    </button>
  );
}

function useSectionMarker(
  props: () => {
    segments: TimelineSegment[];
    i: number;
    position: "left" | "right";
  }
) {
  const { editorInstance } = useEditorContext();

  return () => getSectionMarker(props(), editorInstance.recordings.segments);
}
