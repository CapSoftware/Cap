import { createQuery } from "@tanstack/solid-query";
import { Channel, convertFileSrc } from "@tauri-apps/api/core";
import {
  createMemo,
  createSignal,
  For,
  JSX,
  ParentProps,
  Show,
} from "solid-js";
// import { createMutation, createQuery } from "@tanstack/solid-query";
import { For, ParentProps, Show, Suspense, createSignal } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";

import Tooltip from "@corvu/tooltip";
import { cx } from "cva";
import { FPS, OUTPUT_SIZE } from "~/routes/editor/context";
import { trackEvent } from "~/utils/analytics";
import {
  commands,
  events,
  RecordingMetaWithType,
  RenderProgress,
} from "~/utils/tauri";

type Recording = {
  meta: RecordingMetaWithType;
  id: string;
  path: string;
  prettyName: string;
  thumbnailPath: string;
};

const Tabs = [
  {
    id: "all",
    label: "Show all",
  },
  {
    id: "instant",
    icon: <IconCapInstant class="invert size-3 dark:invert-0" />,
    label: "Instant",
  },
  {
    id: "studio",
    icon: <IconCapFilmCut class="invert size-3 dark:invert-0" />,
    label: "Studio",
  },
] satisfies { id: string; label: string; icon?: JSX.Element }[];

export default function Recordings() {
  const [activeTab, setActiveTab] = createSignal<(typeof Tabs)[number]["id"]>(
    Tabs[0].id
  );
  const recordings = createQuery(() => ({
    queryKey: ["recordings"],
    queryFn: async () => {
      const result = await commands.listRecordings().catch(() => [] as const);

      const recordings = await Promise.all(
        result.map(async (file) => {
          const [id, path, meta] = file;
          const thumbnailPath = `${path}/screenshots/display.jpg`;

          return {
            meta,
            id,
            path,
            prettyName: meta.pretty_name,
            thumbnailPath,
          };
        })
      );
      return recordings;
    },
  }));

  const progress = new Channel<RenderProgress>();

  const filteredRecordings = createMemo(() => {
    if (!recordings.data) {
      return [];
    }
    if (activeTab() === "all") {
      return recordings.data;
    }
    return recordings.data.filter(
      (recording) => recording.meta.type === activeTab()
    );
  });

  const handleRecordingClick = (recording: Recording) => {
    trackEvent("recording_view_clicked", { recording_id: recording.id });
    events.newStudioRecordingAdded.emit({ path: recording.path });
  };

  const handleOpenFolder = (path: string) => {
    trackEvent("recording_folder_clicked", { path });
    commands.openFilePath(path);
  };

  const handleExport = (path: string) => {
    trackEvent("recording_export_clicked", { path });
    commands.exportVideo(
      recordings.data?.find((r) => r.path === path)?.id || "",
      progress,
      false,
      FPS,
      OUTPUT_SIZE
    );
  };

  const handleCopyVideoToClipboard = (path: string) => {
    trackEvent("recording_copy_clicked", { path });
    commands.copyVideoToClipboard(path);
  };

  const handleOpenEditor = (id: string) => {
    const normalizedPath = id.replace(/\\/g, "/");
    const fileName = normalizedPath.split("/").pop() || "";
    trackEvent("recording_editor_clicked", {
      recording_id: fileName.replace(".cap", ""),
    });
    commands.openEditor(fileName.replace(".cap", ""));
  };

  return (
    <div class="flex flex-col pb-12 w-full">
      <div class="overflow-y-auto flex-1">
        <ul class="p-5 flex flex-col gap-[0.5rem] w-full text-[--text-primary]">
          <Show
            when={recordings.data && recordings.data.length > 0}
            fallback={
              <p class="text-center text-[--text-tertiary]">
                No recordings found
              </p>
            }
          >
            <div class="pb-5 border-b border-gray-300 border-dashed">
              <div class="flex gap-3 items-center w-fit">
                <For each={Tabs}>
                  {(tab) => (
                    <div
                      class={cx(
                        "flex gap-1.5 items-center transition-colors duration-200 p-2 px-3 border rounded-full",
                        activeTab() === tab.id
                          ? "bg-gray-300 cursor-default border-gray-300"
                          : "bg-transparent cursor-pointer hover:bg-gray-200 border-gray-200"
                      )}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.icon && tab.icon}
                      <p class="text-xs text-gray-500">{tab.label}</p>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <For each={filteredRecordings()}>
              {(recording) => (
                <RecordingItem
                  recording={recording}
                  onClick={() => handleRecordingClick(recording)}
                  onOpenFolder={() => handleOpenFolder(recording.path)}
                  onOpenEditor={() => handleOpenEditor(recording.path)}
                  onCopyVideoToClipboard={() =>
                    handleCopyVideoToClipboard(recording.path)
                  }
                  onExport={() => handleExport(recording.path)}
                />
              )}
            </For>
          </Show>
        </ul>
      </div>
    </div>
  );
}

function RecordingItem(props: {
  recording: Recording;
  onClick: () => void;
  onOpenFolder: () => void;
  onOpenEditor: () => void;
  onExport: () => void;
  onCopyVideoToClipboard: () => void;
}) {
  const [imageExists, setImageExists] = createSignal(true);
  const type = props.recording.meta.type;
  const firstLetterUpperCase = type.charAt(0).toUpperCase() + type.slice(1);

  const recordTypeActions = {
    studio: [
      {
        label: "Edit",
        icon: <IconLucideEdit class="size-4" />,
        onClick: props.onOpenEditor,
      },
      {
        label: "Show recordings overlay",
        icon: <IconLucideEye class="size-4" />,
        onClick: props.onClick,
      },
      {
        label: "Open link",
        icon: <IconCapLink class="size-4" />,
        onClick: () => null,
      },
      {
        label: "Delete",
        icon: <IconCapTrash class="size-4" />,
        onClick: () => null,
      },
    ],
    instant: [
      {
        label: "Reupload",
        icon: <IconCapUpload class="size-4" />,
        onClick: () => null,
      },
      {
        label: "Open link",
        icon: <IconCapLink class="size-4" />,
        onClick: () => null,
      },
      {
        label: "Delete",
        icon: <IconCapTrash class="size-4" />,
        onClick: () => null,
      },
    ],
  };

  //TODO
  // const ExportMenu = async () => {
  //   const menu = await Menu.new({
  //     items: [
  //       {
  //         id: "copy",
  //         text: "Copy to clipboard",
  //         action: () => {
  //           props.onCopyVideoToClipboard();
  //         },
  //       },
  //       {
  //         id: "export",
  //         text: "Export",
  //         action: () => {
  //           props.onExport();
  //         },
  //       },
  //     ],
  //   });
  //   return menu;
  // };

  const reupload = createMutation(() => ({
    mutationFn: () => {
      return commands.reuploadInstantVideo(props.recording.id);
    },
  }));

  return (
    <li class="flex flex-row justify-between items-center px-4 py-3 w-full rounded-xl transition-colors duration-200 hover:bg-gray-100">
      <div class="flex gap-5 items-center">
        <Show
          when={imageExists()}
          fallback={<div class="mr-4 bg-gray-400 rounded size-11" />}
        >
          <img
            class="object-cover rounded size-12"
            alt="Recording thumbnail"
            src={`${convertFileSrc(
              props.recording.thumbnailPath
            )}?t=${Date.now()}`}
            onError={() => setImageExists(false)}
          />
        </Show>
        <div class="flex flex-col gap-2">
          <span>{props.recording.prettyName}</span>
          {/** Tag */}
          <div
            class={cx(
              "px-2 py-0.5 flex items-center gap-1.5 font-medium text-[11px] text-gray-500 rounded-full w-fit",
              type === "instant" ? "bg-blue-100" : "bg-gray-200"
            )}
          >
            {type === "instant" ? (
              <IconCapInstant class="invert size-2.5 dark:invert-0" />
            ) : (
              <IconCapFilmCut class="invert size-2.5 dark:invert-0" />
            )}
            <p>{firstLetterUpperCase}</p>
          </div>
        </div>
      </div>
      <div class="flex items-center">
        {/* {type === "studio" && (
          <Button
            onClick={async () => (await ExportMenu()).popup()}
            class="mr-3 text-[11px]"
            size="xs"
            variant="primary"
          >
            Export
          </Button>
        )} */}
        {recordTypeActions[type].map((button) => (
          <TooltipIconButton
            tooltipText={button.label}
            onClick={button.onClick}
          >
            {button.icon}
          </TooltipIconButton>
        ))}
        {/* {import.meta.env.DEV &&
          props.recording.meta.type === "instant" &&
          props.recording.meta.sharing?.id && (
            <button
              onClick={() => {
                reupload.mutate();
              }}
            >
              Reupload
            </button>
          )}
        <TooltipIconButton
          tooltipText="Open project files"
          onClick={() => props.onOpenFolder()}
        >
          <IconLucideFolder class="size-5" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltipText="Open in editor"
          onClick={() => props.onOpenEditor()}
        >
          <IconLucideEdit class="size-5" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltipText="Show in recordings overlay"
          onClick={() => props.onClick()}
        >
          <IconLucideEye class="size-5" />
        </TooltipIconButton> */}
      </div>
    </li>
  );
}

function TooltipIconButton(
  props: ParentProps<{ onClick: () => void; tooltipText: string }>
) {
  return (
    <Tooltip>
      <Tooltip.Trigger
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          props.onClick();
        }}
        class="p-2.5 mr-2 opacity-70 will-change-transform hover:opacity-100 rounded-full transition-all duration-200 hover:bg-gray-200 dark:hover:bg-gray-300"
      >
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="py-2 px-3 font-medium bg-gray-100 text-gray-500 border border-gray-200 text-xs rounded-lg animate-in fade-in slide-in-from-top-0.5">
          {props.tooltipText}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
}
