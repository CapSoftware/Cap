import { createEffect, Suspense } from "solid-js";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";

import { Editor } from "./Editor";
import { AbsoluteInsetLoader } from "~/components/Loader";
import { generalSettingsStore } from "~/store";
import { commands } from "~/utils/tauri";
import { Effect, getCurrentWindow } from "@tauri-apps/api/window";

export default function () {
  const generalSettings = generalSettingsStore.createQuery();

  createEffect(() => {
    const transparent = generalSettings.data?.windowTransparency ?? false;
    commands.setWindowTransparent(transparent);
    getCurrentWindow().setEffects({
      effects: transparent ? [Effect.HudWindow] : [],
    });
  });

  return (
    <div
      class={cx(
        "flex flex-col w-screen h-screen bg-gray-1",
        !(
          ostype() === "windows" || !generalSettings.data?.windowTransparency
        ) && "bg-transparent-window"
      )}
    >
      <Suspense fallback={<AbsoluteInsetLoader />}>
        <Editor />
      </Suspense>
    </div>
  );
}
