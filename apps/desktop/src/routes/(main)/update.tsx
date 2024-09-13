import { useNavigate } from "@solidjs/router";
import { check } from "@tauri-apps/plugin-updater";
import {
  createResource,
  createSignal,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js";
import * as dialog from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "@cap/ui-solid";

export default function () {
  const navigate = useNavigate();

  const [update] = createResource(async () => {
    const update = await check();
    if (!update) return;

    return update;
  });

  return (
    <div class="flex flex-col justify-center flex-1 items-center gap-[3rem] p-[1rem] text-[0.875rem] font-[400] h-full">
      <Show when={update()} fallback="No update available" keyed>
        {(update) => {
          type UpdateStatus =
            | { type: "downloading"; progress: number; contentLength?: number }
            | { type: "done" };

          const [updateStatus, updateStatusActions] =
            createResource<UpdateStatus>(
              () =>
                new Promise<UpdateStatus>((resolve) => {
                  update
                    .downloadAndInstall((e) => {
                      if (e.event === "Started") {
                        resolve({
                          type: "downloading",
                          progress: 0,
                          contentLength: e.data.contentLength,
                        });
                      } else if (e.event === "Progress") {
                        const status = updateStatus();
                        if (
                          !status ||
                          status.type !== "downloading" ||
                          status.contentLength === undefined
                        )
                          return;
                        updateStatusActions.mutate({
                          ...status,
                          progress: e.data.chunkLength + status.progress,
                        });
                      }
                    })
                    .then(async () => {
                      updateStatusActions.mutate({ type: "done" });
                    })
                    .catch(() => navigate("/"));
                })
            );

          return (
            <div>
              <Switch fallback={<IconCapLogo class="animate-spin size-4" />}>
                <Match when={updateStatus()?.type === "done"}>
                  Update has been installed. Restart Cap to finish updating.
                  <div class="flex flex-row gap-4">
                    <Button variant="secondary" onClick={() => navigate("/")}>
                      Restart Later
                    </Button>
                    <Button onClick={() => relaunch()}>Restart Now</Button>
                  </div>
                </Match>
                <Match
                  when={(() => {
                    const s = updateStatus();
                    if (
                      s &&
                      s.type === "downloading" &&
                      s.contentLength !== undefined
                    )
                      return s;
                  })()}
                >
                  {(status) => (
                    <>
                      <h1>Installing Update</h1>

                      <div class="w-full bg-gray-200 rounded-full h-2.5">
                        <div
                          class="bg-blue-300 h-2.5 rounded-full"
                          style={{
                            width: `${Math.min(
                              ((status()?.progress ?? 0) /
                                (status()?.contentLength ?? 0)) *
                                100,
                              100
                            )}%`,
                          }}
                        />
                      </div>
                    </>
                  )}
                </Match>
              </Switch>
            </div>
          );
        }}
      </Show>
    </div>
  );
}
