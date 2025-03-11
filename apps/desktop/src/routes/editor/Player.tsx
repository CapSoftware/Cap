import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListener } from "@solid-primitives/event-listener";
import { Show, createEffect, createSignal } from "solid-js";

import { commands } from "~/utils/tauri";
import { FPS, OUTPUT_SIZE, useEditorContext } from "./context";
import { ComingSoonTooltip, EditorButton, Slider } from "./ui";
import { formatTime } from "./utils";

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
  } = useEditorContext();

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
      leftIcon={<IconCapScissors />}
    >
      Split
    </EditorButton>
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
      <div ref={setCanvasContainerRef} class="relative flex-1 bg-gray-50">
        <Show when={latestFrame()}>
          {(currentFrame) => {
            const padding = 16;

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
                const height = (containerBounds.height ?? 0) - padding * 2;

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
                class="absolute bg-blue-50 rounded"
                ref={canvasRef}
                id="canvas"
                width={currentFrame().width}
                height={currentFrame().data.height}
              />
            );
          }}
        </Show>
      </div>
      <div class="flex flex-row items-center p-[0.75rem] gap-[0.5rem] z-10 bg-gray-50 justify-between">
        <div class="flex flex-1 items-center">
          <div class="flex-1" />
          <Time seconds={Math.max(previewTime() ?? playbackTime(), 0)} />
        </div>
        <div class="flex flex-row items-center justify-center text-gray-400 text-[0.875rem]">
          <button
            type="button"
            onClick={async () => {
              setPlaying(false);
              await commands.stopPlayback();
              setPlaybackTime(0);
            }}
          >
            <IconCapFrameFirst class="size-[1.2rem]" />
          </button>
          <button
            type="button"
            onClick={handlePlayPauseClick}
            class="transition-colors hover:text-black"
          >
            {!playing() || isAtEnd() ? (
              <IconCapPlayCircle class="size-[1.5rem]" />
            ) : (
              <IconCapStopCircle class="size-[1.5rem]" />
            )}
          </button>
          <button
            type="button"
            onClick={async () => {
              setPlaying(false);
              await commands.stopPlayback();
              setPlaybackTime(totalDuration());
            }}
          >
            <IconCapFrameLast class="size-[1.2rem]" />
          </button>
        </div>
        <div class="flex flex-row flex-1 gap-2 justify-end items-center">
          <Time seconds={totalDuration()} />
          <div class="flex-1" />
          {window.FLAGS.split ? (
            splitButton()
          ) : (
            <ComingSoonTooltip>{splitButton()}</ComingSoonTooltip>
          )}
          <div class="w-[0.5px] h-7 bg-gray-300 mx-1" />
          <IconIcRoundSearch class="mt-0.5" />
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

function Time(props: { seconds: number; fps?: number }) {
  return (
    <span class="text-gray-400 text-[0.875rem] tabular-nums">
      {formatTime(props.seconds, props.fps ?? FPS)}
    </span>
  );
}
