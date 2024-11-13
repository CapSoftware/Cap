import { Button } from "@cap/ui-solid";
import { cx } from "cva";
import {
  Match,
  Show,
  Switch,
  createResource,
  onCleanup,
  onMount,
} from "solid-js";
import { type as ostype } from "@tauri-apps/plugin-os";
import { createStore, reconcile } from "solid-js/store";

import { type RenderProgress, commands } from "~/utils/tauri";

import { useEditorContext } from "./context";
import { Dialog, DialogContent } from "./ui";

export function Header() {
  let unlistenTitlebar: () => void | undefined;

  onMount(async () => {
    unlistenTitlebar = await initializeTitlebar();
    commands.positionTrafficLights([20.0, 48.0]);
  });

  onCleanup(() => {
    unlistenTitlebar?.();
  });

  setTitlebar("border", false);
  setTitlebar("height", "4rem");
  setTitlebar(
    "items",
    <div
      data-tauri-drag-region
      class={cx(
        "flex flex-row justify-between items-center w-full cursor-default pr-5",
        ostype() === "windows" ? "pl-[4.3rem]" : "pl-[1.25rem]"
      )}
    >
      <div class="flex flex-row items-center gap-[0.5rem] text-[0.875rem]"></div>
      <div
        class="flex flex-row gap-2 font-medium items-center"
      >
        <ShareButton />
        <ExportButton />
      </div>
    </div>
  );

  return <Titlebar />;
}

import { Channel } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";
import { createMutation } from "@tanstack/solid-query";
import Titlebar from "~/components/titlebar/Titlebar";
import { initializeTitlebar, setTitlebar } from "~/utils/titlebar-state";

function ExportButton() {
  const { videoId, project, prettyName } = useEditorContext();

  const [state, setState] = createStore<
    | { open: false; type: "idle" }
    | ({ open: boolean } & (
        | { type: "inProgress"; progress: number; totalFrames: number }
        | { type: "finished"; path: string }
      ))
  >({ open: false, type: "idle" });

  return (
    <>
      <Button
        variant="primary"
        size="md"
        onClick={() => {
          save({
            filters: [{ name: "mp4 filter", extensions: ["mp4"] }],
            defaultPath: `~/Desktop/${prettyName()}.mp4`,
          }).then((p) => {
            if (!p) return;

            setState(
              reconcile({
                open: true,
                type: "inProgress",
                progress: 0,
                totalFrames: 0,
              })
            );

            const progress = new Channel<RenderProgress>();
            progress.onmessage = (p) => {
              if (p.type === "FrameRendered" && state.type === "inProgress")
                setState({ progress: p.current_frame });
              if (
                p.type === "EstimatedTotalFrames" &&
                state.type === "inProgress"
              ) {
                console.log("Total frames: ", p.total_frames);
                setState({ totalFrames: p.total_frames });
              }
            };

            return commands
              .renderToFile(p, videoId, project, progress)
              .then(() => {
                setState({ ...state, type: "finished", path: p });
              });
          });
        }}
      >
        Export
      </Button>
      <Dialog.Root
        open={state.open}
        onOpenChange={(o) => {
          if (!o) setState(reconcile({ ...state, open: false }));
        }}
      >
        <DialogContent
          title="Export Recording"
          confirm={
            <Show when={state.type === "finished" && state}>
              {(state) => (
                <Button
                  onClick={() => {
                    commands.openInFinder(state().path);
                  }}
                >
                  Open in Finder
                </Button>
              )}
            </Show>
          }
        >
          <Switch>
            <Match when={state.type === "finished"}>Finished exporting</Match>
            <Match when={state.type === "inProgress" && state}>
              {(state) => (
                <>
                  <div class="w-full bg-gray-200 rounded-full h-2.5">
                    <div
                      class="bg-blue-300 h-2.5 rounded-full"
                      style={{
                        width: `${Math.min(
                          (state().progress / (state().totalFrames || 1)) * 100,
                          100
                        )}%`,
                      }}
                    />
                  </div>
                </>
              )}
            </Match>
          </Switch>
        </DialogContent>
      </Dialog.Root>
    </>
  );
}

function ShareButton() {
  const { videoId, project, presets } = useEditorContext();
  const [meta, metaActions] = createResource(() =>
    commands.getRecordingMeta(videoId, "recording")
  );

  const uploadVideo = createMutation(() => ({
    mutationFn: async () => {
      const res = await commands.uploadRenderedVideo(
        videoId,
        project
          ? project
          : presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG,
        null
      );
      if (res.status !== "ok") throw new Error(res.error);
    },
    onSuccess: () => metaActions.refetch(),
  }));

  return (
    <Show
      when={meta()?.sharing}
      fallback={
        <Button
          disabled={uploadVideo.isPending}
          onClick={() => uploadVideo.mutate()}
          variant="primary"
          class="flex items-center space-x-1"
        >
          {uploadVideo.isPending ? (
            <>
              <span>Uploading Cap</span>
              <IconLucideLoaderCircle class="size-[1rem] animate-spin" />
            </>
          ) : (
            "Create Shareable Link"
          )}
        </Button>
      }
    >
      {(sharing) => {
        const url = () => new URL(sharing().link);

        return (
          <a
            class="rounded-full h-[2rem] px-[1rem] flex flex-row items-center gap-[0.375rem] bg-gray-200 hover:bg-gray-300 transition-colors duration-100"
            href={sharing().link}
            target="_blank"
            rel="noreferrer"
          >
            <span class="text-[0.875rem] text-gray-500">
              {url().host}
              {url().pathname}
            </span>
          </a>
        );
      }}
    </Show>
  );
}
