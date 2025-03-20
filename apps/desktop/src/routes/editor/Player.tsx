import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { createElementBounds } from "@solid-primitives/bounds";
import { cx } from "cva";
import {
  For,
  Show,
  Suspense,
  createEffect,
  createResource,
  createSignal,
  on,
  onMount,
  onCleanup,
} from "solid-js";
import { reconcile, createStore } from "solid-js/store";
import { createEventListener } from "@solid-primitives/event-listener";


import Tooltip from "~/components/Tooltip";
import { commands } from "~/utils/tauri";
import { FPS, OUTPUT_SIZE, useEditorContext } from "./context";
import { ComingSoonTooltip, EditorButton, Slider } from "./ui";
import { formatTime } from "./utils";
import { captionsStore } from "~/store/captions";
import AspectRatioSelect from "./AspectRatioSelect";

export function Player() {
  const {
    project,
    videoId,
    editorInstance,
    history,
    latestFrame,
    setDialog,
    playbackTime,
    setPlaybackTime,
    previewTime,
    setPreviewTime,
    playing,
    setPlaying,
    split,
    setSplit,
    totalDuration,
    state,
    zoomOutLimit,
    setProject,
  } = useEditorContext();

  // Load captions on mount
  onMount(async () => {
    if (editorInstance && editorInstance.path) {
      // Still load captions into the store since they will be used by the GPU renderer
      await captionsStore.loadCaptions(editorInstance.path);
      
      // Synchronize captions settings with project configuration
      // This ensures the GPU renderer will receive the caption settings
      if (editorInstance && project) {
        const updatedProject = {...project};
        
        // Add captions data to project configuration if it doesn't exist
        if (!updatedProject.captions && captionsStore.state.segments.length > 0) {
          updatedProject.captions = {
            segments: captionsStore.state.segments.map(segment => ({
              id: segment.id,
              start: segment.start,
              end: segment.end,
              text: segment.text
            })),
            settings: {
              enabled: captionsStore.state.settings.enabled,
              font: captionsStore.state.settings.font,
              size: captionsStore.state.settings.size,
              color: captionsStore.state.settings.color,
              backgroundColor: captionsStore.state.settings.backgroundColor,
              backgroundOpacity: captionsStore.state.settings.backgroundOpacity,
              position: captionsStore.state.settings.position,
              bold: captionsStore.state.settings.bold,
              italic: captionsStore.state.settings.italic,
              outline: captionsStore.state.settings.outline,
              outlineColor: captionsStore.state.settings.outlineColor,
              exportWithSubtitles: captionsStore.state.settings.exportWithSubtitles
            }
          };
          
          // Update the project with captions data
          setProject(updatedProject);
          
          // Save the updated project configuration
          await commands.setProjectConfig(updatedProject);
        }
      }
    }
  });

  // Continue to update current caption when playback time changes
  // This is still needed for CaptionsTab to highlight the current caption
  createEffect(() => {
    const time = playbackTime();
    // Only update captions if we have a valid time and segments exist
    if (time !== undefined && time >= 0 && captionsStore.state.segments.length > 0) {
      captionsStore.updateCurrentCaption(time);
    }
  });

  let canvasRef!: HTMLCanvasElement;

  createEffect(() => {
    const frame = latestFrame();
    if (!frame) return;
    const ctx = canvasRef.getContext("2d");
    ctx?.putImageData(frame.data, 0, 0);
  });

  const [canvasContainerRef, setCanvasContainerRef] =
    createSignal<HTMLDivElement>();
  const containerBounds = createElementBounds(canvasContainerRef);

  const splitButton = () => (
    <EditorButton<typeof KToggleButton>
      disabled={!window.FLAGS.split}
      pressed={split()}
      onChange={setSplit}
      as={KToggleButton}
      variant="danger"
      leftIcon={<IconCapScissors class="text-gray-500" />}
    />
  );

  const isAtEnd = () => {
    const total = totalDuration();
    return total > 0 && total - playbackTime() <= 0.1;
  };

  createEffect(() => {
    if (isAtEnd() && playing()) {
      commands.stopPlayback();
      setPlaying(false);
    }
  });

  const handlePlayPauseClick = async () => {
    try {
      if (isAtEnd()) {
        await commands.stopPlayback();
        setPlaybackTime(0);
        await commands.seekTo(0);
        await commands.startPlayback(FPS, OUTPUT_SIZE);
        setPlaying(true);
      } else if (playing()) {
        await commands.stopPlayback();
        setPlaying(false);
      } else {
        // Ensure we seek to the current playback time before starting playback
        await commands.seekTo(Math.floor(playbackTime() * FPS));
        await commands.startPlayback(FPS, OUTPUT_SIZE);
        setPlaying(true);
      }
      if (playing()) setPreviewTime();
    } catch (error) {
      console.error("Error handling play/pause:", error);
      setPlaying(false);
    }
  };

  createEventListener(document, "keydown", async (e: KeyboardEvent) => {
    if (e.code === "Space" && e.target === document.body) {
      e.preventDefault();
      const prevTime = previewTime();

      if (!playing()) {
        if (prevTime !== undefined) setPlaybackTime(prevTime);

        await commands.seekTo(Math.floor(playbackTime() * FPS));
      }

      await handlePlayPauseClick();
    }
  });

  return (
    <div class="flex flex-col flex-1">
      <div class="flex w-[calc(100%-40px)] mx-auto gap-3 justify-center p-5 bg-gray-100 rounded-t-xl">
        <AspectRatioSelect />
        <EditorButton
          onClick={() => {
            const display = editorInstance.recordings.segments[0].display;
            setDialog({
                open: true,
                type: "crop",
                position: {
                  ...(project.background.crop?.position ?? { x: 0, y: 0 }),
                },
                size: {
                  ...(project.background.crop?.size ?? {
                    x: display.width,
                    y: display.height,
                  }),
                },
              });
            }}
            leftIcon={<IconCapCrop class="w-5 text-gray-500" />}
          >
            Crop
          </EditorButton>
                </div>
      <div ref={setCanvasContainerRef} class="relative flex-1 justify-center items-center bg-gray-50">
        <Show when={latestFrame()}>
          {(currentFrame) => {
            const padding = 4;

            const containerAspect = () => {
              if (containerBounds.width && containerBounds.height) {
                return (
                  (containerBounds.width - padding * 2) /
                  (containerBounds.height - padding * 2)
                );
              }

              return 1;
            };

            const frameAspect = () =>
              currentFrame().width / currentFrame().data.height;

            const size = () => {
              if (frameAspect() < containerAspect()) {
                const height = (containerBounds.height ?? 0) - padding * 1;

                return {
                  width: height * frameAspect(),
                  height,
                };
              }

              const width = (containerBounds.width ?? 0) - padding * 2;

              return {
                width,
                height: width / frameAspect(),
              };
            };

            return (
 <div class="relative w-[calc(100%-40px)] overflow-hidden flex items-center justify-center mx-auto h-full bg-gray-100">
                <canvas
                  style={{
                    left: `${Math.max(
                      ((containerBounds.width ?? 0) - size().width) / 2,
                      padding
                    )}px`,
                    top: `${Math.max(
                      ((containerBounds.height ?? 0) - size().height) / 2,
                      padding
                    )}px`,
                    width: `${size().width}px`,
                    height: `${size().height}px`,
                  }}
                  class="bg-blue-50 absolute rounded"
                  ref={canvasRef}
                  id="canvas"
                  width={currentFrame().width}
                  height={currentFrame().data.height}
                />
              </div>
            );
          }}
        </Show>
      </div>
      <div class="flex z-10 overflow-hidden flex-row gap-3 justify-between items-center p-5 w-[calc(100%-40px)] mx-auto bg-gray-100 rounded-b-xl">
        <div class="flex-1">
          <Time
            class="text-gray-500"
            seconds={Math.max(previewTime() ?? playbackTime(), 0)}
          />
          <span class="text-gray-400 text-[0.875rem] tabular-nums"> / </span>
          <Time seconds={totalDuration()} />
        </div>
        <div class="flex flex-row items-center justify-center text-gray-400 gap-8 text-[0.875rem]">
          <button
            type="button"
            class="transition-opacity hover:opacity-70 will-change-[opacity]"
            onClick={async () => {
              setPlaying(false);
              await commands.stopPlayback();
              setPlaybackTime(0);
            }}
          >
            <IconCapPrev class="text-gray-500 size-3" />
          </button>
          <button
            type="button"
            onClick={handlePlayPauseClick}
            class="flex justify-center items-center bg-gray-200 rounded-full border border-gray-300 transition-colors hover:bg-gray-300 hover:text-black size-9"
          >
            {!playing() || isAtEnd() ? (
              <IconCapPlay class="text-gray-500 size-3" />
            ) : (
              <IconCapPause class="text-gray-500 size-3" />
            )}
          </button>
          <button
            type="button"
            class="transition-opacity hover:opacity-70 will-change-[opacity]"
            onClick={async () => {
              setPlaying(false);
              await commands.stopPlayback();
              setPlaybackTime(totalDuration());
            }}
          >
            <IconCapNext class="text-gray-500 size-3" />
          </button>
        </div>
        <div class="flex flex-row flex-1 gap-4 justify-end items-center">
          <div class="flex-1" />
          {window.FLAGS.split ? (
            splitButton()
          ) : (
            <ComingSoonTooltip>{splitButton()}</ComingSoonTooltip>
          )}
          <Tooltip content="Zoom out">
            <IconCapZoomOut
              onClick={() => {
                state.timelineTransform.updateZoom(
                  state.timelineTransform.zoom * 1.1,
                  playbackTime()
                );
              }}
              class="text-gray-500 size-5 will-change-[opacity] transition-opacity hover:opacity-70"
            />
          </Tooltip>
          <Tooltip content="Zoom in">
            <IconCapZoomIn
              onClick={() => {
                state.timelineTransform.updateZoom(
                  state.timelineTransform.zoom / 1.1,
                  playbackTime()
                );
              }}
              class="text-gray-500 size-5 will-change-[opacity] transition-opacity hover:opacity-70"
            />
          </Tooltip>
          <p class="text-sm tabular-nums text-gray-500">
            {Math.min(
              Math.max(1 - state.timelineTransform.zoom / zoomOutLimit(), 0),
              1
            ).toFixed(2) + "x"}
          </p>
          <Slider
            class="w-24"
            minValue={0}
            maxValue={1}
            step={0.001}
            value={[
              Math.min(
                Math.max(1 - state.timelineTransform.zoom / zoomOutLimit(), 0),
                1
              ),
            ]}
            onChange={([v]) => {
              state.timelineTransform.updateZoom(
                (1 - v) * zoomOutLimit(),
                playbackTime()
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Time(props: { seconds: number; fps?: number; class?: string }) {
  return (
    <span class={cx("text-gray-400 text-sm tabular-nums", props.class)}>
      {formatTime(props.seconds, props.fps ?? FPS)}
    </span>
  );
}
