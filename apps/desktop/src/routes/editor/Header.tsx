import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { ComponentProps, onCleanup, onMount } from "solid-js";

import { Button } from "@cap/ui-solid";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { trackEvent } from "~/utils/analytics";
import { initializeTitlebar } from "~/utils/titlebar-state";
import { useEditorContext } from "./context";
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
  const { editorInstance, history, setDialog, exportProgress } =
    useEditorContext();

  let unlistenTitlebar: UnlistenFn | undefined;
  onMount(async () => {
    unlistenTitlebar = await initializeTitlebar();
  });
  onCleanup(() => unlistenTitlebar?.());

  return (
    <div
      data-tauri-drag-region
      class="flex relative flex-row items-center w-full h-14"
    >
      <div
        data-tauri-drag-region
        class={cx("flex flex-row flex-1 gap-2 items-center px-4 h-full")}
      >
        {ostype() === "macos" && <div class="h-full w-[4rem]" />}
        <EditorButton
          onClick={async () => {
            const currentWindow = getCurrentWindow();
            if (!editorInstance.path) return;
            if (!(await ask("Are you sure you want to delete this recording?")))
              return;
            await remove(editorInstance.path, {
              recursive: true,
            });
            await currentWindow.close();
          }}
          tooltipText="Delete recording"
          leftIcon={<IconCapTrash class="w-5" />}
        />
        <EditorButton
          onClick={() => revealItemInDir(`${editorInstance.path}/`)}
          tooltipText="Open recording bundle"
          leftIcon={<IconLucideFolder class="w-5" />}
        />

        <p class="text-sm text-gray-500">
          {editorInstance.meta.prettyName}
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
        <div data-tauri-drag-region class="flex-1 h-full" />
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

      <div
        data-tauri-drag-region
        class="flex flex-col justify-center px-4 border-x border-black-transparent-10"
      >
        <PresetsDropdown />
      </div>

      <div
        data-tauri-drag-region
        class={cx(
          "flex-1 h-full flex flex-row items-center gap-2 pl-2",
          ostype() !== "windows" && "pr-2"
        )}
      >
        <EditorButton
          onClick={() => history.undo()}
          disabled={!history.canUndo()}
          tooltipText="Undo"
          leftIcon={<IconCapUndo class="w-5" />}
        />
        <EditorButton
          onClick={() => history.redo()}
          disabled={!history.canRedo()}
          tooltipText="Redo"
          leftIcon={<IconCapRedo class="w-5" />}
        />
        <div data-tauri-drag-region class="flex-1 h-full" />
        <ShareButton />
        <Button
          variant="lightdark"
          class={cx("flex gap-2 justify-center")}
          onClick={() => {
            trackEvent("export_button_clicked");
            setDialog({
              type: "export",
              open: true,
            });
          }}
        >
          <UploadIcon class="text-gray-50 size-5" />
          Export
        </Button>
        {ostype() === "windows" && <CaptionControlsWindows11 />}
      </div>
    </div>
  );
}

const UploadIcon = (props: ComponentProps<"svg">) => {
  const { exportProgress } = useEditorContext();
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Bottom part (the base) */}
      <path
        d="M16.6667 10.625V14.1667C16.6667 15.5474 15.5474 16.6667 14.1667 16.6667H5.83333C4.45262 16.6667 3.33333 15.5474 3.33333 14.1667V10.625"
        stroke="currentColor"
        stroke-width={1.66667}
        stroke-linecap="round"
        stroke-linejoin="round"
        class="upload-base"
      />

      {/* Arrow part */}
      <path
        d="M9.99999 3.33333V12.7083M9.99999 3.33333L13.75 7.08333M9.99999 3.33333L6.24999 7.08333"
        stroke="currentColor"
        stroke-width={1.66667}
        stroke-linecap="round"
        stroke-linejoin="round"
        class={cx(exportProgress() !== null ? "bounce" : "")}
      />
    </svg>
  );
};
