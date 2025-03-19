import type { UnlistenFn } from "@tauri-apps/api/event";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
  batch,
  createEffect,
  createSignal,
  JSX,
  onCleanup,
  onMount,
} from "solid-js";

import Titlebar from "~/components/titlebar/Titlebar";
import { createLicenseQuery } from "~/utils/queries";
import { initializeTitlebar, setTitlebar } from "~/utils/titlebar-state";
import AspectRatioSelect from "./AspectRatioSelect";
import { useEditorContext } from "./context";
import ExportButton from "./ExportButton";
import PresetsDropdown from "./PresetsDropdown";
import ShareButton from "./ShareButton";
import { EditorButton } from "./ui";
import { remove } from "@tauri-apps/plugin-fs";
import { ask } from "@tauri-apps/plugin-dialog";
import { commands } from "~/utils/tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";

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

// Menu configuration for the header
const Menu = {
  left: [
    {
      button: (props: {
        editorContext: ReturnType<typeof useEditorContext>;
      }) => (
        <EditorButton
          tooltipText="Captions"
          leftIcon={<IconCapCaptions class="w-5" />}
          comingSoon
        />
      ),
    },
    {
      button: (props: {
        editorContext: ReturnType<typeof useEditorContext>;
      }) => (
        <EditorButton
          tooltipText="Performance"
          leftIcon={<IconCapGauge class="w-[18px]" />}
          comingSoon
        />
      ),
    },
  ],
  center: [
    {
      button: (props: {
        editorContext: ReturnType<typeof useEditorContext>;
      }) => <PresetsDropdown />,
    },
    {
      button: (props: {
        editorContext: ReturnType<typeof useEditorContext>;
      }) => {
        const { editorInstance, setDialog, project } = props.editorContext;
        return (
          <EditorButton
            onClick={() => {
              const display = editorInstance.recordings.segments[0].display;
              setDialog({
                open: true,
                type: "crop",
                position: {
                  ...(project.background.crop?.position ?? { x: 0, y: 0 }),
                },
                size: {
                  ...(project.background.crop?.size ?? {
                    x: display.width,
                    y: display.height,
                  }),
                },
              });
            }}
            leftIcon={<IconCapCrop class="w-5 text-gray-500" />}
          >
            Crop
          </EditorButton>
        );
      },
    },
    {
      button: (props: {
        editorContext: ReturnType<typeof useEditorContext>;
      }) => <AspectRatioSelect />,
    },
  ],
  right: [
    {
      button: (props: {
        editorContext: ReturnType<typeof useEditorContext>;
      }) => {
        const { history } = props.editorContext;
        return (
          <EditorButton
            onClick={() => history.undo()}
            disabled={!history.canUndo()}
            tooltipText="Undo"
            leftIcon={<IconCapUndo class="w-5" />}
          />
        );
      },
    },
    {
      button: (props: {
        editorContext: ReturnType<typeof useEditorContext>;
      }) => {
        const { history } = props.editorContext;
        return (
          <EditorButton
            onClick={() => history.redo()}
            disabled={!history.canRedo()}
            tooltipText="Redo"
            leftIcon={<IconCapRedo class="w-5" />}
          />
        );
      },
    },
    {
      button: (props: {
        editorContext?: ReturnType<typeof useEditorContext>;
      }) => (
        <EditorButton
          onClick={async () => {
            const currentWindow = getCurrentWindow();
            if (!props.editorContext?.editorInstance.path) return ;
            if (!(await ask("Are you sure you want to delete this recording?")))
              return;
            await remove(props.editorContext?.editorInstance.path, { recursive: true });
            await currentWindow.close();
          }}
          tooltipText="Delete recording"
          leftIcon={<IconCapTrash class="w-5" />}
        />
      ),
    },
  ],
} satisfies Record<
  "left" | "center" | "right",
  {
    button: (props: {
      editorContext: ReturnType<typeof useEditorContext>;
    }) => JSX.Element;
  }[]
>;

export function Header() {
  const license = createLicenseQuery();
  const editorContext = useEditorContext();

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
    setTitlebar("transparent", false);
    setTitlebar(
      "items",
      <div
        data-tauri-drag-region
        class={cx(
          "flex flex-row justify-end items-center w-full cursor-default pr-5",
          ostype() === "windows" ? "pl-[4.3rem]" : "pl-[1.25rem]"
        )}
      >
        <div class="flex relative z-20 flex-row gap-2 items-center font-medium">
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
        class="absolute flex gap-4 h-full w-full items-start left-[5.5rem] z-10"
      >
        <div class="flex gap-4 items-center h-full">
          <p class="text-sm text-gray-500">
            {editorContext.editorInstance.prettyName}
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
      <div
        data-tauri-drag-region
        class="flex absolute inset-x-0 z-10 items-center mx-auto h-full w-fit"
      >
        {Object.values(Menu).map((section) => (
          <div
            class={cx(
              "flex gap-4 items-center px-4 h-full",
              section === Menu.center &&
                "border-r border-l border-r-gray-200 border-l-gray-200"
            )}
          >
            {section.map((item) => (
              <>{item.button({ editorContext })}</>
            ))}
          </div>
        ))}
      </div>
      <Titlebar />
    </div>
  );
}
