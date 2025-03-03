// Credits: tauri-controls
import { type } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { type ComponentProps, Match, splitProps, Switch } from "solid-js";
import titlebarState from "~/utils/titlebar-state";
import CaptionControlsWindows11 from "./controls/CaptionControlsWindows11";

export default function Titlebar() {
  function left() {
    if (titlebarState.order === "platform") return type() === "macos";
    return titlebarState.order === "left";
  }

  return (
    <header
      class={cx(
        "flex flex-row items-center select-none space-x-1 shrink-0 border-zinc-300",
        titlebarState.transparent ? "bg-transparent" : "bg-zinc-200",
        titlebarState.border ? "border-b" : ""
      )}
      style={{
        height: titlebarState.height,
      }}
      data-tauri-drag-region
    >
      {left() ? (
        <>
          <WindowControls class="!ml-0" />
          <div class="!ml-auto">{titlebarState.items}</div>
        </>
      ) : (
        <>
          {titlebarState.items}
          <WindowControls class="!ml-auto" />
        </>
      )}
    </header>
  );
}

function WindowControls(props: ComponentProps<"div">) {
  const [local, otherProps] = splitProps(props, ["class"]);
  const ostype = type();

  return (
    <Switch>
      <Match when={ostype === "windows"}>
        <CaptionControlsWindows11
          class={`flex ml-auto ${local.class ?? ""}`}
          {...otherProps}
        />
      </Match>
      <Match when={ostype === "macos"}>
        <div data-tauri-drag-region class="flex w-20 h-full" />
      </Match>
    </Switch>
  );
}
