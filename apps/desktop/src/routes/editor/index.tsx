import { Suspense } from "solid-js";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";

import { Editor } from "./Editor";
import { AbsoluteInsetLoader } from "~/components/Loader";

export default function () {
  return (
    <div
      class={cx(
        "flex flex-col w-screen h-screen",
        ostype() === "windows" ? "bg-gray-50" : "bg-transparent-window"
      )}
    >
      <Suspense fallback={<AbsoluteInsetLoader />}>
        <Editor />
      </Suspense>
    </div>
  );
}
