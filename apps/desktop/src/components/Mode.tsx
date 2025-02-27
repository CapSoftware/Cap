import { createSignal } from "solid-js";
import Tooltip from "~/components/Tooltip";
import { commands } from "~/utils/tauri";

const Mode = () => {
  const [toggleInstantMode, setToggleInstantMode] = createSignal(false);
  const [isInfoHovered, setIsInfoHovered] = createSignal(false);

  const openModeSelectWindow = async () => {
    try {
      await commands.showWindow("ModeSelect");
    } catch (error) {
      console.error("Failed to open mode select window:", error);
    }
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
            onClick={() => setToggleInstantMode((p) => !p)}
            class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
              toggleInstantMode()
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
            onClick={() => setToggleInstantMode(false)}
            class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
              !toggleInstantMode()
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
            onClick={() => setToggleInstantMode((p) => !p)}
            class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
              toggleInstantMode()
                ? "ring-2 ring-offset-1 ring-offset-gray-50 bg-gray-300 hover:bg-[--gray-300] ring-[--blue-300]"
                : "bg-gray-200 hover:bg-[--gray-300]"
            }`}
          >
            <IconCapInstant class="invert size-4 dark:invert-0" />
          </div>

          <div
            onClick={() => setToggleInstantMode(false)}
            class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
              !toggleInstantMode()
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
