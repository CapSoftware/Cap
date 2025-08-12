import { Button } from "@cap/ui-solid";
import {
  ComponentProps,
  createEffect,
  createRoot,
  createSignal,
  JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { createStore, reconcile } from "solid-js/store";
import {
  createEventListener,
  createEventListenerMap,
} from "@solid-primitives/event-listener";
import { cx } from "cva";

import { createOptionsQuery } from "~/utils/queries";
import {
  commands,
  events,
  ScreenCaptureTarget,
  TargetUnderCursor,
} from "~/utils/tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function () {
  const [params] = useSearchParams<{ displayId: string }>();
  const { rawOptions, setOptions } = createOptionsQuery();

  const [targetUnderCursor, setTargetUnderCursor] =
    createStore<TargetUnderCursor>({
      display_id: null,
      window: null,
      screen: null,
    });

  const unsubTargetUnderCursor = events.targetUnderCursor.listen((event) => {
    setTargetUnderCursor(reconcile(event.payload));
  });
  onCleanup(() => unsubTargetUnderCursor.then((unsub) => unsub()));

  const [bounds, _setBounds] = createStore({
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
  });

  const setBounds = (newBounds: typeof bounds) => {
    newBounds.position.x = Math.max(0, newBounds.position.x);
    newBounds.position.y = Math.max(0, newBounds.position.y);
    newBounds.size.width = Math.min(
      window.innerWidth - newBounds.position.x,
      newBounds.size.width
    );
    newBounds.size.height = Math.min(
      window.innerHeight - newBounds.position.y,
      newBounds.size.height
    );

    _setBounds(newBounds);
  };

  // We do this so any Cap window, (or external in the case of a bug) that are focused can trigger the close shortcut
  const unsubOnEscapePress = events.onEscapePress.listen(() =>
    setOptions("targetMode", null)
  );
  onCleanup(() => unsubOnEscapePress.then((f) => f()));

  createEffect(() => {
    if (rawOptions.captureTarget === undefined) getCurrentWindow().close();
  });

  // This prevents browser keyboard shortcuts from firing.
  // Eg. on Windows Ctrl+P would open the print dialog without this
  createEventListener(document, "keydown", (e) => e.preventDefault());

  return (
    <Switch>
      <Match when={rawOptions.targetMode === "screen"}>
        {(_) => (
          <Show when={targetUnderCursor.screen} keyed>
            {(screenUnderCursor) => (
              <div
                data-over={targetUnderCursor.display_id === params.displayId}
                class="w-screen h-screen flex flex-col items-center justify-center bg-black/50 data-[over='true']:bg-blue-600/40 transition-colors"
              >
                <span class="text-3xl font-semibold mb-2">
                  {screenUnderCursor.name}
                </span>
                <span class="text-xs mb-2">
                  {`${screenUnderCursor.physical_size.width}x${screenUnderCursor.physical_size.height} · ${screenUnderCursor.refresh_rate}FPS`}
                </span>

                <RecordingControls
                  target={{
                    variant: "screen",
                    id: getDisplayId(params.displayId),
                  }}
                />
              </div>
            )}
          </Show>
        )}
      </Match>
      <Match
        when={
          rawOptions.targetMode === "window" &&
          targetUnderCursor.display_id === params.displayId
        }
      >
        <Show when={targetUnderCursor.window} keyed>
          {(windowUnderCursor) => (
            <div
              data-over={targetUnderCursor.display_id === params.displayId}
              class="w-screen h-screen bg-black/50 relative"
            >
              <div
                class="bg-blue-600/40 absolute flex flex-col items-center justify-center"
                style={{
                  width: `${windowUnderCursor.bounds.size.width}px`,
                  height: `${windowUnderCursor.bounds.size.height}px`,
                  left: `${windowUnderCursor.bounds.position.x}px`,
                  top: `${windowUnderCursor.bounds.position.y}px`,
                }}
              >
                <div class="flex flex-col items-center justify-center">
                  <Show when={windowUnderCursor.icon}>
                    {(icon) => (
                      <img
                        src={icon()}
                        alt={`${windowUnderCursor.app_name} icon`}
                        class="w-32 h-32 mb-3 rounded-lg"
                      />
                    )}
                  </Show>
                  <span class="text-3xl font-semibold mb-2">
                    {windowUnderCursor.app_name}
                  </span>
                  <span class="text-xs mb-2">
                    {`${windowUnderCursor.bounds.size.width}x${windowUnderCursor.bounds.size.height}`}
                  </span>
                </div>
                <RecordingControls
                  target={{
                    variant: "window",
                    id: Number(windowUnderCursor.id),
                  }}
                />

                <Button
                  variant="primary"
                  size="sm"
                  class="mt-4"
                  onClick={() => {
                    setBounds(windowUnderCursor.bounds);
                    setOptions({
                      targetMode: "area",
                    });
                  }}
                >
                  Adjust recording area
                </Button>
              </div>
            </div>
          )}
        </Show>
      </Match>
      <Match when={rawOptions.targetMode === "area"}>
        {(_) => {
          const [dragging, setDragging] = createSignal(false);

          function createOnMouseDown(
            onDrag: (
              startBounds: typeof bounds,
              delta: { x: number; y: number }
            ) => void
          ) {
            return (downEvent: MouseEvent) => {
              const startBounds = {
                position: { ...bounds.position },
                size: { ...bounds.size },
              };

              createRoot((dispose) => {
                createEventListenerMap(window, {
                  mouseup: () => dispose(),
                  mousemove: (moveEvent) => {
                    onDrag(startBounds, {
                      x: Math.max(
                        -startBounds.position.x,
                        moveEvent.clientX - downEvent.clientX
                      ),
                      y: Math.max(
                        -startBounds.position.y,
                        moveEvent.clientY - downEvent.clientY
                      ),
                    });
                  },
                });
              });
            };
          }

          function ResizeHandles() {
            return (
              <>
                {/* Top Left Button */}
                <ResizeHandle
                  class="cursor-nw-resize"
                  style={{
                    left: `${bounds.position.x + 1}px`,
                    top: `${bounds.position.y + 1}px`,
                  }}
                  onMouseDown={createOnMouseDown((startBounds, delta) => {
                    const width = startBounds.size.width - delta.x;
                    const limitedWidth = Math.max(width, 150);

                    const height = startBounds.size.height - delta.y;
                    const limitedHeight = Math.max(height, 150);

                    setBounds({
                      position: {
                        x:
                          startBounds.position.x +
                          delta.x -
                          (limitedWidth - width),
                        y:
                          startBounds.position.y +
                          delta.y -
                          (limitedHeight - height),
                      },
                      size: {
                        width: limitedWidth,
                        height: limitedHeight,
                      },
                    });
                  })}
                />

                {/* Top Right Button */}
                <ResizeHandle
                  class="cursor-ne-resize"
                  style={{
                    left: `${bounds.position.x + bounds.size.width - 1}px`,
                    top: `${bounds.position.y + 1}px`,
                  }}
                  onMouseDown={createOnMouseDown((startBounds, delta) => {
                    const width = startBounds.size.width + delta.x;
                    const limitedWidth = Math.max(width, 150);

                    const height = startBounds.size.height - delta.y;
                    const limitedHeight = Math.max(height, 150);

                    setBounds({
                      position: {
                        x: startBounds.position.x,
                        y:
                          startBounds.position.y +
                          delta.y -
                          (limitedHeight - height),
                      },
                      size: {
                        width: limitedWidth,
                        height: limitedHeight,
                      },
                    });
                  })}
                />

                {/* Bottom Left Button */}
                <ResizeHandle
                  class="cursor-sw-resize"
                  style={{
                    left: `${bounds.position.x + 1}px`,
                    top: `${bounds.position.y + bounds.size.height - 1}px`,
                  }}
                  onMouseDown={createOnMouseDown((startBounds, delta) => {
                    const width = startBounds.size.width - delta.x;
                    const limitedWidth = Math.max(width, 150);

                    const height = startBounds.size.height + delta.y;
                    const limitedHeight = Math.max(height, 150);

                    setBounds({
                      position: {
                        x:
                          startBounds.position.x +
                          delta.x -
                          (limitedWidth - width),
                        y: startBounds.position.y,
                      },
                      size: {
                        width: limitedWidth,
                        height: limitedHeight,
                      },
                    });
                  })}
                />

                {/* Bottom Right Button */}
                <ResizeHandle
                  class="cursor-se-resize"
                  style={{
                    left: `${bounds.position.x + bounds.size.width - 1}px`,
                    top: `${bounds.position.y + bounds.size.height - 1}px`,
                  }}
                  onMouseDown={createOnMouseDown((startBounds, delta) => {
                    const width = startBounds.size.width + delta.x;
                    const limitedWidth = Math.max(width, 150);

                    const height = startBounds.size.height + delta.y;
                    const limitedHeight = Math.max(height, 150);

                    setBounds({
                      position: {
                        x: startBounds.position.x,
                        y: startBounds.position.y,
                      },
                      size: {
                        width: limitedWidth,
                        height: limitedHeight,
                      },
                    });
                  })}
                />

                {/* Top Edge Button */}
                <ResizeHandle
                  class="cursor-n-resize"
                  style={{
                    left: `${bounds.position.x + bounds.size.width / 2}px`,
                    top: `${bounds.position.y + 1}px`,
                  }}
                  onMouseDown={createOnMouseDown((startBounds, delta) => {
                    const height = startBounds.size.height - delta.y;
                    const limitedHeight = Math.max(height, 150);

                    setBounds({
                      position: {
                        x: startBounds.position.x,
                        y:
                          startBounds.position.y +
                          delta.y -
                          (limitedHeight - height),
                      },
                      size: {
                        width: startBounds.size.width,
                        height: limitedHeight,
                      },
                    });
                  })}
                />

                {/* Right Edge Button */}
                <ResizeHandle
                  class="cursor-e-resize"
                  style={{
                    left: `${bounds.position.x + bounds.size.width - 1}px`,
                    top: `${bounds.position.y + bounds.size.height / 2}px`,
                  }}
                  onMouseDown={createOnMouseDown((startBounds, delta) => {
                    setBounds({
                      position: {
                        x: startBounds.position.x,
                        y: startBounds.position.y,
                      },
                      size: {
                        width: Math.max(150, startBounds.size.width + delta.x),
                        height: startBounds.size.height,
                      },
                    });
                  })}
                />

                {/* Bottom Edge Button */}
                <ResizeHandle
                  class="cursor-s-resize"
                  style={{
                    left: `${bounds.position.x + bounds.size.width / 2}px`,
                    top: `${bounds.position.y + bounds.size.height - 1}px`,
                  }}
                  onMouseDown={createOnMouseDown((startBounds, delta) => {
                    setBounds({
                      position: {
                        x: startBounds.position.x,
                        y: startBounds.position.y,
                      },
                      size: {
                        width: startBounds.size.width,
                        height: Math.max(
                          150,
                          startBounds.size.height + delta.y
                        ),
                      },
                    });
                  })}
                />

                {/* Left Edge Button */}
                <ResizeHandle
                  class="cursor-w-resize"
                  style={{
                    left: `${bounds.position.x + 1}px`,
                    top: `${bounds.position.y + bounds.size.height / 2}px`,
                  }}
                  onMouseDown={createOnMouseDown((startBounds, delta) => {
                    const width = startBounds.size.width - delta.x;
                    const limitedWidth = Math.max(150, width);

                    setBounds({
                      position: {
                        x:
                          startBounds.position.x +
                          delta.x -
                          (limitedWidth - width),
                        y: startBounds.position.y,
                      },
                      size: {
                        width: limitedWidth,
                        height: startBounds.size.height,
                      },
                    });
                  })}
                />
              </>
            );
          }

          function Occluders() {
            return (
              <>
                {/* Left */}
                <div
                  class="bg-black/50 absolute top-0 left-0 bottom-0"
                  style={{ width: `${bounds.position.x}px` }}
                />
                {/* Right */}
                <div
                  class="bg-black/50 absolute top-0 right-0 bottom-0"
                  style={{
                    width: `${
                      window.innerWidth -
                      (bounds.size.width + bounds.position.x)
                    }px`,
                  }}
                />
                {/* Top center */}
                <div
                  class="bg-black/50 absolute top-0"
                  style={{
                    left: `${bounds.position.x}px`,
                    width: `${bounds.size.width}px`,
                    height: `${bounds.position.y}px`,
                  }}
                />
                {/* Bottom center */}
                <div
                  class="bg-black/50 absolute bottom-0"
                  style={{
                    left: `${bounds.position.x}px`,
                    width: `${bounds.size.width}px`,
                    height: `${
                      window.innerHeight -
                      (bounds.size.height + bounds.position.y)
                    }px`,
                  }}
                />
              </>
            );
          }

          return (
            <div class="w-screen h-screen flex flex-col items-center justify-center data-[over='true']:bg-blue-600/40 transition-colors relative cursor-crosshair">
              <Occluders />

              <div
                class={cx(
                  "absolute flex flex-col items-center",
                  dragging() ? "cursor-grabbing" : "cursor-grab"
                )}
                style={{
                  width: `${bounds.size.width}px`,
                  height: `${bounds.size.height}px`,
                  left: `${bounds.position.x}px`,
                  top: `${bounds.position.y}px`,
                }}
                onMouseDown={(downEvent) => {
                  setDragging(true);
                  const startPosition = { ...bounds.position };

                  createRoot((dispose) => {
                    createEventListenerMap(window, {
                      mousemove: (moveEvent) => {
                        const newPosition = {
                          x:
                            startPosition.x +
                            moveEvent.clientX -
                            downEvent.clientX,
                          y:
                            startPosition.y +
                            moveEvent.clientY -
                            downEvent.clientY,
                        };

                        if (newPosition.x < 0) newPosition.x = 0;
                        if (newPosition.y < 0) newPosition.y = 0;
                        if (
                          newPosition.x + bounds.size.width >
                          window.innerWidth
                        )
                          newPosition.x = window.innerWidth - bounds.size.width;
                        if (
                          newPosition.y + bounds.size.height >
                          window.innerHeight
                        )
                          newPosition.y =
                            window.innerHeight - bounds.size.height;

                        _setBounds("position", newPosition);
                      },
                      mouseup: () => {
                        setDragging(false);
                        dispose();
                      },
                    });
                  });
                }}
              >
                <div
                  class="absolute top-full flex flex-col items-center m-2"
                  style={{ width: `${bounds.size.width}px` }}
                >
                  <RecordingControls
                    target={{
                      variant: "area",
                      screen: Number(params.displayId),
                      bounds: {
                        x: bounds.position.x,
                        y: bounds.position.y,
                        width: bounds.size.width,
                        height: bounds.size.height,
                      },
                    }}
                  />
                </div>
              </div>

              <ResizeHandles />

              <span class="text-xl z-10">Click and drag area to record</span>
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}

function RecordingControls(props: { target: ScreenCaptureTarget }) {
  const { rawOptions } = createOptionsQuery();

  return (
    <Button
      size="lg"
      onClick={() => {
        commands.startRecording({
          capture_target: props.target,
          mode: rawOptions.mode,
          capture_system_audio: rawOptions.captureSystemAudio,
        });
      }}
    >
      Start Recording
    </Button>
  );
}

function ResizeHandle(
  props: Omit<ComponentProps<"button">, "style"> & { style?: JSX.CSSProperties }
) {
  return (
    <button
      {...props}
      class={cx(
        "size-3 bg-black rounded-full absolute border-[1.2px] border-white",
        props.class
      )}
      style={{ ...props.style, transform: "translate(-50%, -50%)" }}
    />
  );
}

function getDisplayId(displayId: string | undefined) {
  const id = Number(displayId);
  if (Number.isNaN(id)) return 0;
  return id;
}
