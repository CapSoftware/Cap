import { createEffect, createSignal, onMount } from "solid-js";
import Tooltip from "~/components/Tooltip";
import { createOptionsQuery } from "~/utils/queries";
import { commands } from "~/utils/tauri";
import { trackEvent } from "~/utils/analytics";
import { createStore } from "solid-js/store";

// Create a global store for mode state that all components can access
const [modeState, setModeState] = createStore({
  current: "studio" as "instant" | "studio",
  initialized: false,
});

// Export this so other components can directly access the current mode
export const getModeState = () => modeState.current;
export const setApplicationMode = (mode: "instant" | "studio") => {
  setModeState({ current: mode, initialized: true });
  // Also dispatch an event for components that might be listening
  window.dispatchEvent(new CustomEvent("cap:mode-change", { detail: mode }));
};

const Mode = () => {
  const { options, setOptions } = createOptionsQuery();
  const [isInfoHovered, setIsInfoHovered] = createSignal(false);

  // Initialize the mode from options when data is available
  createEffect(() => {
    if (options.data?.mode) {
      if (!modeState.initialized || options.data.mode !== modeState.current) {
        console.log("Initializing mode state from options:", options.data.mode);
        setModeState({ current: options.data.mode, initialized: true });
      }
    }
  });

  // Listen for mode change events
  onMount(() => {
    const handleModeChange = (e: CustomEvent) => {
      console.log("Mode change event received:", e.detail);
    };

    window.addEventListener(
      "cap:mode-change",
      handleModeChange as EventListener
    );

    return () => {
      window.removeEventListener(
        "cap:mode-change",
        handleModeChange as EventListener
      );
    };
  });

  const openModeSelectWindow = async () => {
    try {
      await commands.showWindow("ModeSelect");
    } catch (error) {
      console.error("Failed to open mode select window:", error);
    }
  };

  const handleModeChange = (mode: "instant" | "studio") => {
    if (!options.data) return;
    if (mode === modeState.current) return;

    console.log("Mode changing from", modeState.current, "to", mode);

    // Update global state immediately for responsive UI
    setApplicationMode(mode);

    // Track the mode change event
    trackEvent("mode_changed", { from: modeState.current, to: mode });

    // Update the backend options while preserving camera/microphone settings
    setOptions.mutate({
      ...options.data,
      mode,
    });
  };

  return (
    <div class="flex gap-2 relative justify-end items-center p-1.5 rounded-full bg-gray-200 w-fit">
      <div
        class="absolute -left-1.5 -top-2 p-1 rounded-full w-fit bg-gray-300 group"
        onClick={openModeSelectWindow}
        onMouseEnter={() => setIsInfoHovered(true)}
        onMouseLeave={() => setIsInfoHovered(false)}
      >
        <IconCapInfo class="invert transition-opacity duration-200 cursor-pointer size-2.5 dark:invert-0 group-hover:opacity-50" />
      </div>

      {!isInfoHovered() && (
        <Tooltip
          placement="top"
          content="Instant mode"
          openDelay={0}
          closeDelay={0}
        >
          <div
            onClick={() => {
              handleModeChange("instant");
            }}
            class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
              modeState.current === "instant"
                ? "ring-2 ring-offset-1 ring-offset-gray-50 bg-gray-300 hover:bg-[--gray-300] ring-[--blue-300]"
                : "bg-gray-200 hover:bg-[--gray-300]"
            }`}
          >
            <IconCapInstant class="invert size-4 dark:invert-0" />
          </div>
        </Tooltip>
      )}

      {!isInfoHovered() && (
        <Tooltip
          placement="top"
          content="Studio mode"
          openDelay={0}
          closeDelay={0}
        >
          <div
            onClick={() => {
              handleModeChange("studio");
            }}
            class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
              modeState.current === "studio"
                ? "ring-2 ring-offset-1 ring-offset-gray-50 bg-gray-300 hover:bg-[--gray-300] ring-[--blue-300]"
                : "bg-gray-200 hover:bg-[--gray-300]"
            }`}
          >
            <IconCapFilmCut class="size-3.5 invert dark:invert-0" />
          </div>
        </Tooltip>
      )}

      {isInfoHovered() && (
        <>
          <div
            onClick={() => {
              handleModeChange("instant");
            }}
            class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
              modeState.current === "instant"
                ? "ring-2 ring-offset-1 ring-offset-gray-50 bg-gray-300 hover:bg-[--gray-300] ring-[--blue-300]"
                : "bg-gray-200 hover:bg-[--gray-300]"
            }`}
          >
            <IconCapInstant class="invert size-4 dark:invert-0" />
          </div>

          <div
            onClick={() => {
              handleModeChange("studio");
            }}
            class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
              modeState.current === "studio"
                ? "ring-2 ring-offset-1 ring-offset-gray-50 bg-gray-300 hover:bg-[--gray-300] ring-[--blue-300]"
                : "bg-gray-200 hover:bg-[--gray-300]"
            }`}
          >
            <IconCapFilmCut class="size-3.5 invert dark:invert-0" />
          </div>
        </>
      )}
    </div>
  );
};

export default Mode;
