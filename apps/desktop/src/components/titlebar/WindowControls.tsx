import { Match, mergeProps, splitProps, Switch } from "solid-js";
import { WindowControlsProps } from "./Titlebar";
import { type } from "@tauri-apps/plugin-os";
import { Windows11StyleControls } from "./controls/Windows11StyleControls";

export function WindowControls(props: WindowControlsProps) {
  const [rawLocal, otherProps] = splitProps(props, [
    "class",
    "forceHideMaximizeButton",
  ]);
  const ostype = type();

  const local = mergeProps(
    {
      justify: false,
      hide: false,
      hideMethod: "display",
    },
    rawLocal
  );

  return (
    <Switch fallback={<></>}>
      <Match when={ostype === "macos"}>
        <Windows11StyleControls
          class={`flex ml-auto ${local.class}`}
          {...otherProps}
        />
      </Match>
      <Match when={ostype === "macos"}>
        <div class={`flex w-4 ${local.class}`} {...otherProps}></div>
      </Match>
    </Switch>
  );
}
