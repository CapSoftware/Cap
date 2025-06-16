import { makePersisted } from "@solid-primitives/storage";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cx } from "cva";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";

namespace TeleprompterWindow {
  export type State = {
    text: string;
    speed: number;
    opacity: number;
    fontSize: number;
    isPlaying: boolean;
    position: number;
  };
}

export default function TeleprompterWindow() {
  const [state, setState] = makePersisted(
    createStore<TeleprompterWindow.State>({
      text: "Enter your teleprompter text here...\n\nYou can add multiple paragraphs and the text will scroll smoothly as you speak.\n\nAdjust the speed, opacity, and font size to match your preferences.",
      speed: 50,
      opacity: 90,
      fontSize: 24,
      isPlaying: false,
      position: 0,
    }),
    { name: "teleprompterState" }
  );

  const [isEditing, setIsEditing] = createSignal(true);
  let textAreaRef: HTMLTextAreaElement | undefined;
  let textDisplayRef: HTMLDivElement | undefined;
  let scrollInterval: NodeJS.Timeout | undefined;

  const startScrolling = () => {
    if (scrollInterval) clearInterval(scrollInterval);

    scrollInterval = setInterval(() => {
      if (!textDisplayRef || !state.isPlaying) return;

      const maxScroll =
        textDisplayRef.scrollHeight - textDisplayRef.clientHeight;

      // Calculate scroll increment based on speed (1-100 -> 0.5-3 pixels per frame)
      const scrollIncrement = Math.max(0.5, (state.speed / 100) * 3);
      const newPosition = Math.min(state.position + scrollIncrement, maxScroll);

      setState("position", newPosition);
      textDisplayRef.scrollTop = newPosition;

      if (newPosition >= maxScroll) {
        setState("isPlaying", false);
      }
    }, 16); // ~60fps for smooth scrolling
  };

  const stopScrolling = () => {
    if (scrollInterval) {
      clearInterval(scrollInterval);
      scrollInterval = undefined;
    }
  };

  const togglePlayPause = () => {
    setState("isPlaying", !state.isPlaying);
  };

  const resetPosition = () => {
    setState("position", 0);
    setState("isPlaying", false);
    if (textDisplayRef) {
      textDisplayRef.scrollTop = 0;
    }
  };

  createEffect(() => {
    if (state.isPlaying) {
      startScrolling();
    } else {
      stopScrolling();
    }
  });

  createEffect(() => {
    stopScrolling();
    if (state.isPlaying) {
      startScrolling();
    }
  });

  onMount(async () => {
    const window = getCurrentWindow();
    await window.setAlwaysOnTop(true);
  });

  onCleanup(() => {
    stopScrolling();
  });

  const updateWindowOpacity = async () => {
    try {
      const { commands } = await import("~/utils/tauri");
      await commands.setWindowTransparent(true);
    } catch (error) {
      console.warn("Failed to set window transparency:", error);
    }
  };

  createEffect(() => {
    updateWindowOpacity();
  });

  return (
    <div
      class="flex flex-col h-screen bg-gray-1 text-gray-12"
      style={{
        "background-color": `rgba(245, 245, 245, ${state.opacity / 100})`,
      }}
    >
      <div
        data-tauri-drag-region
        class="flex items-center justify-between p-4 border-b border-gray-4"
        style={{
          "background-color": `rgba(249, 249, 249, ${state.opacity / 100})`,
        }}
      >
        <div class="flex items-center gap-3">
          <button
            onClick={togglePlayPause}
            class={cx(
              "flex items-center justify-center w-9 h-9 rounded-xl transition-all outline-offset-2 outline-2 focus-visible:outline",
              state.isPlaying
                ? "bg-red-9 text-gray-1 hover:opacity-80 outline-red-300"
                : "bg-blue-9 text-gray-1 hover:opacity-80 outline-blue-300"
            )}
          >
            <Show
              when={state.isPlaying}
              fallback={
                <svg
                  class="w-4 h-4 ml-0.5"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              }
            >
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
              </svg>
            </Show>
          </button>

          <button
            onClick={resetPosition}
            class="flex items-center justify-center w-9 h-9 rounded-xl bg-gray-4 text-gray-11 hover:opacity-80 transition-all outline-offset-2 outline-2 focus-visible:outline outline-blue-300"
          >
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
            </svg>
          </button>

          <button
            onClick={() => setIsEditing(!isEditing())}
            class="flex items-center justify-center w-9 h-9 rounded-xl bg-gray-4 text-gray-11 hover:opacity-80 transition-all outline-offset-2 outline-2 focus-visible:outline outline-blue-300"
          >
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
            </svg>
          </button>
        </div>

        <div class="flex items-center gap-6">
          <div class="flex items-center gap-3">
            <span class="text-sm font-medium text-gray-11 min-w-[45px]">
              Speed
            </span>
            <input
              type="range"
              min="1"
              max="100"
              value={state.speed}
              onInput={(e) =>
                setState("speed", parseInt(e.currentTarget.value))
              }
              class="w-20 h-2 bg-gray-4 rounded-lg appearance-none cursor-pointer hover:bg-gray-5 transition-colors"
            />
            <span class="text-sm text-gray-11 w-8 text-right">
              {state.speed}
            </span>
          </div>

          <div class="flex items-center gap-3">
            <span class="text-sm font-medium text-gray-11 min-w-[30px]">
              Size
            </span>
            <input
              type="range"
              min="12"
              max="48"
              value={state.fontSize}
              onInput={(e) =>
                setState("fontSize", parseInt(e.currentTarget.value))
              }
              class="w-20 h-2 bg-gray-4 rounded-lg appearance-none cursor-pointer hover:bg-gray-5 transition-colors"
            />
            <span class="text-sm text-gray-11 w-8 text-right">
              {state.fontSize}
            </span>
          </div>

          <div class="flex items-center gap-3">
            <span class="text-sm font-medium text-gray-11 min-w-[55px]">
              Opacity
            </span>
            <input
              type="range"
              min="10"
              max="100"
              value={state.opacity}
              onInput={(e) =>
                setState("opacity", parseInt(e.currentTarget.value))
              }
              class="w-20 h-2 bg-gray-4 rounded-lg appearance-none cursor-pointer hover:bg-gray-5 transition-colors"
            />
            <span class="text-sm text-gray-11 w-8 text-right">
              {state.opacity}%
            </span>
          </div>
        </div>
      </div>

      <div class="flex-1 relative overflow-hidden">
        <Show when={isEditing()}>
          <textarea
            ref={textAreaRef!}
            value={state.text}
            onInput={(e) => setState("text", e.currentTarget.value)}
            placeholder="Enter your teleprompter text here..."
            class="w-full h-full p-6 text-gray-12 resize-none outline-none border-none focus:ring-0"
            style={{
              "font-size": `${state.fontSize}px`,
              "line-height": "1.6",
              "background-color": `rgba(245, 245, 245, ${state.opacity / 100})`,
            }}
          />
        </Show>

        <Show when={!isEditing()}>
          <div
            data-tauri-drag-region
            ref={textDisplayRef!}
            class="w-full h-full p-6 overflow-y-auto text-gray-12"
            style={{
              "font-size": `${state.fontSize}px`,
              "line-height": "1.6",
              "scroll-behavior": "smooth",
              "background-color": `rgba(245, 245, 245, ${state.opacity / 100})`,
            }}
          >
            <div class="whitespace-pre-wrap selection:bg-blue-9/20">
              {state.text}
            </div>
            <div class="h-screen" />
          </div>
        </Show>
      </div>

      <div
        data-tauri-drag-region
        class="px-4 py-3 border-t border-gray-4 text-center"
        style={{
          "background-color": `rgba(249, 249, 249, ${state.opacity / 100})`,
        }}
      >
        <span class="text-xs text-gray-11 font-medium">
          {isEditing()
            ? "Edit Mode - Click the edit button to start presenting"
            : "Presentation Mode - Drag to move window"}
        </span>
      </div>
    </div>
  );
}
