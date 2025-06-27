import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { createMutation } from "@tanstack/solid-query";
import { createSignal, Show } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import Tooltip from "~/components/Tooltip";
import { createProgressBar } from "~/routes/editor/utils";
import { authStore } from "~/store";
import { exportVideo } from "~/utils/export";
import { commands, events } from "~/utils/tauri";
import { useEditorContext } from "./context";
import { RESOLUTION_OPTIONS } from "./Header";
import { Dialog, DialogContent, MenuItem, MenuItemList, PopperContent, topLeftAnimateClasses } from "./ui";

function ShareButton() {
  const { editorInstance, meta, customDomain } = useEditorContext();
  const projectPath = editorInstance.path;


  const upload = createMutation(() => ({
    mutationFn: async () => {
      setUploadState({ type: "idle" });

      console.log("Starting upload process...");

      // Check authentication first
      const existingAuth = await authStore.get();
      if (!existingAuth) {
        throw new Error("You need to sign in to share recordings");
      }

      const metadata = await commands.getVideoMetadata(projectPath);
      const plan = await commands.checkUpgradedAndUpdate();
      const canShare = {
        allowed: plan || metadata.duration < 300,
        reason: !plan && metadata.duration >= 300 ? "upgrade_required" : null,
      };

      if (!canShare.allowed) {
        if (canShare.reason === "upgrade_required") {
          await commands.showWindow("Upgrade");
          throw new Error(
            "Upgrade required to share recordings longer than 5 minutes"
          );
        }
      }

      const unlisten = await events.uploadProgress.listen((event) => {
        console.log("Upload progress event:", event.payload);
        setUploadState(
          produce((state) => {
            if (state.type !== "uploading") return;

            state.progress = Math.round(event.payload.progress * 100);
          })
        );
      });

      try {
        setUploadState({ type: "starting" });

        // Setup progress listener before starting upload

        console.log("Starting actual upload...");

        await exportVideo(
          projectPath,
          {
            fps: 30,
            resolution_base: {
              x: RESOLUTION_OPTIONS._1080p.width,
              y: RESOLUTION_OPTIONS._1080p.height,
            },
            compression: "Web",
          },
          (msg) => {
            setUploadState(
              reconcile({
                type: "rendering",
                renderedFrames: msg.renderedCount,
                totalFrames: msg.totalFrames,
              })
            );
          }
        );

        setUploadState({ type: "uploading", progress: 0 });

        // Now proceed with upload
        const result = meta().sharing
          ? await commands.uploadExportedVideo(projectPath, "Reupload")
          : await commands.uploadExportedVideo(projectPath, {
            Initial: { pre_created_video: null },
          });

        if (result === "NotAuthenticated") {
          throw new Error("You need to sign in to share recordings");
        } else if (result === "PlanCheckFailed")
          throw new Error("Failed to verify your subscription status");
        else if (result === "UpgradeRequired")
          throw new Error("This feature requires an upgraded plan");

        setUploadState({ type: "link-copied" });

        return result;
      } finally {
        unlisten();
      }
    },
    onError: (error) => {
      commands.globalMessageDialog(
        error instanceof Error ? error.message : "Failed to upload recording"
      );
    },
    onSettled() {
      setTimeout(() => {
        setUploadState({ type: "idle" });
        upload.reset();
      }, 2000);
    },
  }));

  const [uploadState, setUploadState] = createStore<
    | { type: "idle" }
    | { type: "starting" }
    | { type: "rendering"; renderedFrames: number; totalFrames: number }
    | { type: "uploading"; progress: number }
    | { type: "link-copied" }
  >({ type: "idle" });

  createProgressBar(() => {
    if (uploadState.type === "starting") return 0;
    if (uploadState.type === "rendering")
      return (uploadState.renderedFrames / uploadState.totalFrames) * 100;
    if (uploadState.type === "uploading") return uploadState.progress;
  });

  return (
    <div class="relative">
      <Show when={meta().sharing}>
        {(sharing) => {

          const normalUrl = () => new URL(sharing().link);
          const customUrl = () => customDomain()?.custom_domain ? new URL(customDomain()?.custom_domain + `/s/${meta().sharing?.id}`) : null;

          const normalLink = `${normalUrl().host}${normalUrl().pathname}`;
          const customLink = `${customUrl()?.host}${customUrl()?.pathname}`;


          const copyLinks = {
            normal: sharing().link,
            custom: customUrl()?.href
          }

          const [linkToDisplay, setLinkToDisplay] = createSignal<string | null>(
            customDomain()?.custom_domain && customDomain()?.domain_verified ? customLink : normalLink
          );

          const [copyPressed, setCopyPressed] = createSignal(false);

          const copyLink = () => {
            navigator.clipboard.writeText(linkToDisplay() || sharing().link);
            setCopyPressed(true);
            setTimeout(() => {
              setCopyPressed(false);
            }, 2000);
          };

          return (
            <div class="flex gap-3 items-center">
              <Tooltip
                content={
                  upload.isPending ? "Reuploading video" : "Reupload video"
                }
              >
                <Button
                  disabled={upload.isPending}
                  onClick={() => upload.mutate()}
                  variant="primary"
                  class="flex justify-center items-center size-[41px] !px-0 !py-0 space-x-1 rounded-xl"
                >
                  {upload.isPending ? (
                    <IconLucideLoaderCircle class="animate-spin size-4" />
                  ) : (
                    <IconLucideRotateCcw class="size-4" />
                  )}
                </Button>
              </Tooltip>
              <Tooltip content="Open link">
                <div class="rounded-xl px-3 py-2 flex flex-row items-center gap-[0.375rem] bg-gray-3 hover:bg-gray-4 transition-colors duration-100">
                  <a
                    href={
                      linkToDisplay() === customLink ? copyLinks.custom : copyLinks.normal
                    }
                    target="_blank"
                    rel="noreferrer"
                    class="w-full truncate max-w-[200px]"
                  >
                    <span class="text-xs text-gray-12">
                      {linkToDisplay()}
                    </span>
                  </a>
                  {/** Dropdown */}
                  <Show when={customDomain()?.custom_domain && customDomain()?.domain_verified}>
                    <Tooltip content="Select link">
                      <KSelect
                        value={linkToDisplay()}
                        onChange={(value) => value && setLinkToDisplay(value)}
                        options={[customLink, normalLink].filter(link => link !== linkToDisplay())}
                        multiple={false}
                        itemComponent={(props) => (
                          <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
                            <KSelect.ItemLabel class="flex-1 text-xs truncate">
                              {props.item.rawValue}
                            </KSelect.ItemLabel>
                          </MenuItem>
                        )}
                        placement="bottom-end"
                        gutter={4}
                      >
                        <KSelect.Trigger
                          class="flex justify-center items-center transition-colors duration-200 rounded-lg size-[22px] text-gray-12 bg-gray-6 hover:bg-gray-7 group focus:outline-none focus-visible:outline-none"
                        >
                          <KSelect.Icon>
                            <IconCapChevronDown class="size-4 transition-transform duration-200 group-data-[expanded]:rotate-180" />
                          </KSelect.Icon>
                        </KSelect.Trigger>
                        <KSelect.Portal>
                          <PopperContent<typeof KSelect.Content>
                            as={KSelect.Content}
                            class={topLeftAnimateClasses}
                          >
                            <MenuItemList<typeof KSelect.Listbox>
                              as={KSelect.Listbox}
                              class="w-[236px]"
                            />
                          </PopperContent>
                        </KSelect.Portal>
                      </KSelect>
                    </Tooltip>
                  </Show>
                  {/** Copy button */}
                  <Tooltip content="Copy link">
                    <div
                      class="flex justify-center items-center transition-colors duration-200 rounded-lg size-[22px] text-gray-12 bg-gray-6 hover:bg-gray-7"
                      onClick={copyLink}
                    >
                      {!copyPressed() ? (
                        <IconCapCopy class="size-3" />
                      ) : (
                        <IconLucideCheck class="size-3 svgpathanimation" />
                      )}
                    </div>
                  </Tooltip>
                </div>
              </Tooltip>
            </div>
          );
        }}
      </Show>
      <Dialog.Root open={!upload.isIdle}>
        <DialogContent
          title={"Reupload Recording"}
          confirm={<></>}
          close={<></>}
          class="text-gray-12 dark:text-gray-12"
        >
          <div class="w-[80%] text-center mx-auto relative z-10 space-y-6 py-4">
            <div class="w-full bg-gray-3 rounded-full h-2.5 mb-2">
              <div
                class="bg-blue-9 h-2.5 rounded-full"
                style={{
                  width: `${uploadState.type === "uploading"
                    ? uploadState.progress
                    : uploadState.type === "link-copied"
                      ? 100
                      : uploadState.type === "rendering"
                        ? Math.min(
                          (uploadState.renderedFrames /
                            uploadState.totalFrames) *
                          100,
                          100
                        )
                        : 0
                    }%`,
                }}
              />
            </div>

            <p class="relative z-10 mt-3 text-xs text-white">
              {uploadState.type == "idle" || uploadState.type === "starting"
                ? "Preparing to render..."
                : uploadState.type === "rendering"
                  ? `Rendering video (${uploadState.renderedFrames}/${uploadState.totalFrames} frames)`
                  : uploadState.type === "uploading"
                    ? `Uploading - ${Math.floor(uploadState.progress)}%`
                    : "Link copied to clipboard!"}
            </p>
          </div>
        </DialogContent>
      </Dialog.Root>
    </div>
  );
}

export default ShareButton;
