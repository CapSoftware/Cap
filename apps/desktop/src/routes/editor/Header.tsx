import { Button } from "@cap/ui-solid";
import { cx } from "cva";
import { Match, Show, Switch, createResource } from "solid-js";
import { platform } from "@tauri-apps/plugin-os";
import { createStore, reconcile } from "solid-js/store";

import { type RenderProgress, commands } from "~/utils/tauri";

import { useEditorContext } from "./context";
import { Dialog, DialogContent } from "./ui";

export function Header() {
  const [os] = createResource(() => platform());

  return (
    <header
      class={cx(
        "flex flex-row justify-between items-center",
        os() === "macos" && "pl-[4.3rem]"
      )}
      data-tauri-drag-region
    >
      <div class="flex flex-row items-center gap-[0.5rem] text-[0.875rem]">
        <div class="flex flex-row items-center gap-[0.375rem]">
          <div class="size-[1.5rem] rounded-[0.25rem] bg-gray-500 bg-black" />
          <span>My Workspace</span>
        </div>
        <span class="text-gray-400">/</span>
        <div class="flex flex-row items-center gap-[0.375rem]">
          <span>Cap Title</span>
        </div>
      </div>
      <div
        class="flex flex-row gap-4 font-medium items-center"
        data-tauri-drag-region
      >
        <ShareButton />
        <ExportButton />
      </div>
    </header>
  );
}

import { Channel } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";
import { createMutation } from "@tanstack/solid-query";

function ExportButton() {
  const { videoId, project } = useEditorContext();

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
  const { videoId, presets } = useEditorContext();
  const [meta, metaActions] = createResource(() =>
    commands.getRecordingMeta(videoId)
  );

  const uploadVideo = createMutation(() => ({
    mutationFn: async () => {
      const res = await commands.uploadRenderedVideo(
        videoId,
        presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG
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
