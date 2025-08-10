import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
  ComponentProps,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { Button } from "@cap/ui-solid";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import Tooltip from "~/components/Tooltip";
import { trackEvent } from "~/utils/analytics";
import { commands, events } from "~/utils/tauri";
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

export const RESOLUTION_OPTIONS = {
  _720p: { label: "720p", value: "720p", width: 1280, height: 720 },
  _1080p: { label: "1080p", value: "1080p", width: 1920, height: 1080 },
  _4k: { label: "4K", value: "4k", width: 3840, height: 2160 },
};

export interface ExportEstimates {
  duration_seconds: number;
  estimated_time_seconds: number;
  estimated_size_mb: number;
}

export function Header() {
  const {
    editorInstance,
    projectHistory,
    setDialog,
    meta,
    exportState,
    setExportState,
    customDomain,
  } = useEditorContext();

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
            events.recordingDeleted.emit({ path: editorInstance.path });
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

        <div class="flex flex-row items-center">
          <NameEditor name={meta().prettyName} />
          <span class="text-sm text-gray-11">.cap</span>
        </div>
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
          onClick={() => projectHistory.undo()}
          disabled={!projectHistory.canUndo()}
          tooltipText="Undo"
          leftIcon={<IconCapUndo class="w-5" />}
        />
        <EditorButton
          onClick={() => projectHistory.redo()}
          disabled={!projectHistory.canRedo()}
          tooltipText="Redo"
          leftIcon={<IconCapRedo class="w-5" />}
        />
        <div data-tauri-drag-region class="flex-1 h-full" />
        <Show when={customDomain.data}>
          <ShareButton />
        </Show>
        <Button
          variant="lightdark"
          class="flex gap-1.5 justify-center h-[40px] w-full max-w-[100px]"
          onClick={() => {
            trackEvent("export_button_clicked");
            if (exportState.type === "done") setExportState({ type: "idle" });

            setDialog({ type: "export", open: true });
          }}
        >
          <UploadIcon class="text-gray-1 size-4" />
          Export
        </Button>
        {ostype() === "windows" && <CaptionControlsWindows11 />}
      </div>
    </div>
  );
}

const UploadIcon = (props: ComponentProps<"svg">) => {
  const { exportState } = useEditorContext();
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
        class={cx(
          exportState.type !== "idle" && exportState.type !== "done" && "bounce"
        )}
      />
    </svg>
  );
};

function NameEditor(props: { name: string }) {
  const { refetchMeta } = useEditorContext();

  let prettyNameRef: HTMLInputElement | undefined;
  let prettyNameMeasureRef: HTMLSpanElement | undefined;
  const [truncated, setTruncated] = createSignal(false);
  const [prettyName, setPrettyName] = createSignal(props.name);

  createEffect(() => {
    if (!prettyNameRef || !prettyNameMeasureRef) return;
    prettyNameMeasureRef.textContent = prettyName();
    const inputWidth = prettyNameRef.offsetWidth;
    const textWidth = prettyNameMeasureRef.offsetWidth;
    setTruncated(inputWidth < textWidth);
  });

  return (
    <Tooltip disabled={!truncated()} content={props.name}>
      <div class="flex flex-row items-center relative text-sm font-inherit font-normal tracking-inherit text-gray-12">
        <input
          ref={prettyNameRef}
          class={cx(
            "absolute inset-0 px-px m-0 opacity-0 overflow-hidden focus:opacity-100 bg-transparent border-b border-transparent focus:border-gray-7 focus:outline-none peer whitespace-pre",
            truncated() && "truncate",
            (prettyName().length < 5 || prettyName().length > 100) &&
              "focus:border-red-500"
          )}
          value={prettyName()}
          onInput={(e) => setPrettyName(e.currentTarget.value)}
          onBlur={async () => {
            const trimmed = prettyName().trim();
            if (trimmed.length < 5 || trimmed.length > 100) {
              setPrettyName(props.name);
              return;
            }
            if (trimmed && trimmed !== props.name) {
              await commands.setPrettyName(trimmed);
              refetchMeta();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              prettyNameRef?.blur();
            }
          }}
        />
        {/* Hidden span for measuring text width */}
        <span
          ref={prettyNameMeasureRef}
          class="pointer-events-none max-w-[200px] px-px m-0 peer-focus:opacity-0 border-b border-transparent truncate whitespace-pre"
        />
      </div>
    </Tooltip>
  );
}
