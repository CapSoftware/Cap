import { createSignal } from "solid-js";
import { Tooltip } from "~/components";

const Mode = () => {
  const [toggleInstantMode, setToggleInstantMode] = createSignal(false);
  return (
    <div class="flex gap-2 relative justify-end items-center p-1.5 rounded-full bg-zinc-200 w-fit">
      <Tooltip
        childClass="z-5 absolute -top-2 left-0 right-0 mx-auto"
        placement="top"
        content="Learn more"
      >
        <div class="absolute right-0 left-0 -top-0.5 p-1 mx-auto rounded-full w-fit bg-zinc-300 group">
          <IconCapInfo class="invert transition-opacity duration-200 cursor-pointer size-2.5 dark:invert-0 group-hover:opacity-50" />
        </div>
      </Tooltip>
      <Tooltip placement="top" content="Instant mode">
        <div
          onClick={() => setToggleInstantMode((p) => !p)}
          class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
            toggleInstantMode()
              ? "ring-2 ring-offset-1 ring-offset-gray-50 bg-zinc-300 ring-[--blue-300]"
              : "bg-zinc-200 hover:bg-blue-300"
          }`}
        >
          <IconCapInstant class="invert size-4 dark:invert-0" />
        </div>
      </Tooltip>
      <Tooltip placement="top" content="Studio mode">
        <div
          onClick={() => setToggleInstantMode(false)}
          class={`flex justify-center items-center transition-all duration-200 rounded-full size-7 hover:cursor-pointer ${
            !toggleInstantMode()
              ? "ring-2 ring-offset-1 ring-offset-gray-50 bg-zinc-300 ring-[--blue-300]"
              : "bg-zinc-200 hover:bg-blue-300"
          }`}
        >
          <IconCapFilmCut class="size-3.5 invert dark:invert-0" />
        </div>
      </Tooltip>
    </div>
  );
};

export default Mode;
