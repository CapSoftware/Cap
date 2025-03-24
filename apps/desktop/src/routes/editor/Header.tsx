import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
  batch,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import Titlebar from "~/components/titlebar/Titlebar";
import { initializeTitlebar, setTitlebar } from "~/utils/titlebar-state";
import { useEditorContext } from "./context";
import ExportButton from "./ExportButton";
import PresetsDropdown from "./PresetsDropdown";
import ShareButton from "./ShareButton";
import { EditorButton } from "./ui";

export type ResolutionOption = {
  label: string;
  value: string;
  width: number;
  height: number;
};

export const RESOLUTION_OPTIONS: ResolutionOption[] = [
  { label: "720p", value: "720p", width: 1280, height: 720 },
  { label: "1080p", value: "1080p", width: 1920, height: 1080 },
  { label: "4K", value: "4k", width: 3840, height: 2160 },
];

export interface ExportEstimates {
  duration_seconds: number;
  estimated_time_seconds: number;
  estimated_size_mb: number;
}

export function Header() {
  const editorContext = useEditorContext();
  const isWindows = ostype() === 'windows'

  const [selectedFps, setSelectedFps] = createSignal(
    Number(localStorage.getItem("cap-export-fps")) || 30
  );
  const [selectedResolution, setSelectedResolution] =
    createSignal<ResolutionOption>(
      RESOLUTION_OPTIONS.find(
        (opt) => opt.value === localStorage.getItem("cap-export-resolution")
      ) || RESOLUTION_OPTIONS[0]
    );

  // Save settings when they change
  createEffect(() => {
    localStorage.setItem("cap-export-fps", selectedFps().toString());
    localStorage.setItem("cap-export-resolution", selectedResolution().value);
  });

  let unlistenTitlebar: UnlistenFn | undefined;
  onMount(async () => {
    unlistenTitlebar = await initializeTitlebar();
  });
  onCleanup(() => unlistenTitlebar?.());

  batch(() => {
    setTitlebar("height", "60px");
    setTitlebar("border", true);
    setTitlebar("backgroundColor", "bg-transparent-window");
    setTitlebar(
      "items",
      <div
        data-tauri-drag-region
        class={cx(
          "flex flex-row justify-end items-center w-full cursor-default pr-5",
          ostype() === "windows" ? "pl-[4.3rem]" : "pl-[1.25rem]"
        )}
      >
        <div class="flex relative z-20 flex-row gap-3 items-center font-medium">
          <ShareButton
            selectedResolution={selectedResolution}
            selectedFps={selectedFps}
          />
          <ExportButton
            selectedResolution={selectedResolution()}
            selectedFps={selectedFps()}
            setSelectedFps={setSelectedFps}
            setSelectedResolution={setSelectedResolution}
          />
        </div>
      </div>
    );
  });

  return (
    <div data-tauri-drag-region class="relative w-full">
      <div
        data-tauri-drag-region
        class={cx(
          "flex absolute z-10 gap-4 items-start w-full h-full",
          isWindows ? "left-2" : "left-[5.5rem]"
        )}
      >
        <div class="flex gap-2 items-center h-full">
          <EditorButton
            onClick={async () => {
              const currentWindow = getCurrentWindow();
              if (!editorContext?.editorInstance.path) return;
              if (
                !(await ask("Are you sure you want to delete this recording?"))
              )
                return;
              await remove(editorContext?.editorInstance.path, {
                recursive: true,
              });
              await currentWindow.close();
            }}
            tooltipText="Delete recording"
            leftIcon={<IconCapTrash class="w-5" />}
          />
          <EditorButton
            onClick={() =>
              revealItemInDir(`${editorContext.editorInstance.path}/`)
            }
            tooltipText="Open recording bundle"
            leftIcon={<IconLucideFolder class="w-5" />}
          />

          <p class="text-sm text-gray-500">
            {editorContext.editorInstance.prettyName}
            <span class="text-sm text-gray-400">.cap</span>
          </p>
          {/* <ErrorBoundary fallback={<></>}>
            <Suspense>
              <span
                onClick={async () => {
                  if (license.data?.type !== "pro") {
                    await commands.showWindow("Upgrade");
                  }
                }}
                class={`text-[0.8rem] ${
                  license.data?.type === "pro"
                    ? "bg-[--blue-400] text-gray-50 dark:text-gray-500"
                    : "bg-gray-200 cursor-pointer hover:bg-gray-300"
                } rounded-[0.55rem] px-2 py-1`}
              >
                {license.data?.type === "commercial"
                  ? "Commercial License"
                  : license.data?.type === "pro"
                  ? "Pro"
                  : "Personal License"}
              </span>
            </Suspense>
          </ErrorBoundary> */}
        </div>
      </div>
      <TopBar />
      <Titlebar />
    </div>
  );
}

function TopBar() {
  const editorContext = useEditorContext();

  return (
    <div
      data-tauri-drag-region
      class="flex absolute inset-x-0 z-10 items-center mx-auto h-full w-fit"
    >
      <div class="flex gap-4 items-center px-4 h-full">
        <EditorButton
          tooltipText="Captions"
          leftIcon={<IconCapCaptions class="w-5" />}
          comingSoon
        />
        <EditorButton
          tooltipText="Performance"
          leftIcon={<IconCapGauge class="w-[18px]" />}
          comingSoon
        />
      </div>

      <div class="flex gap-4 items-center px-4 my-2 border-r border-l border-r-black-transparent-10 border-l-black-transparent-10">
        <PresetsDropdown />
      </div>

      <div class="flex gap-4 items-center px-4 h-full">
        <EditorButton
          onClick={() => editorContext.history.undo()}
          disabled={!editorContext.history.canUndo()}
          tooltipText="Undo"
          leftIcon={<IconCapUndo class="w-5" />}
        />
        <EditorButton
          onClick={() => editorContext.history.redo()}
          disabled={!editorContext.history.canRedo()}
          tooltipText="Redo"
          leftIcon={<IconCapRedo class="w-5" />}
        />
      </div>
    </div>
  );
}
