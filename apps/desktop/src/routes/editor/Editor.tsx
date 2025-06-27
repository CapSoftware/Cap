import { Button } from "@cap/ui-solid";
import { trackDeep } from "@solid-primitives/deep";
import { throttle } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import { createMutation } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cx } from "cva";
import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onMount,
} from "solid-js";
import { createStore } from "solid-js/store";

import Cropper, { cropToFloor } from "~/components/Cropper";
import { Toggle } from "~/components/Toggle";
import Tooltip from "~/components/Tooltip";
import { events, type Crop } from "~/utils/tauri";
import { ConfigSidebar } from "./ConfigSidebar";
import {
  EditorContextProvider,
  EditorInstanceContextProvider,
  FPS,
  OUTPUT_SIZE,
  useEditorContext,
  useEditorInstanceContext,
} from "./context";
import { ExportDialog } from "./ExportDialog";
import { Header } from "./Header";
import { Player } from "./Player";
import { Timeline } from "./Timeline";
import { Dialog, DialogContent, EditorButton, Input, Subfield } from "./ui";

export function Editor() {
  return (
    <EditorInstanceContextProvider>
      <Show
        when={(() => {
          const ctx = useEditorInstanceContext();
          const editorInstance = ctx.editorInstance();

          if (!editorInstance || !ctx.metaQuery.data) return;

          return {
            editorInstance,
            meta() {
              const d = ctx.metaQuery.data;
              if (!d)
                throw new Error(
                  "metaQuery.data is undefined - how did this happen?"
                );
              return d;
            },
            refetchMeta: async () => {
              await ctx.metaQuery.refetch();
            },
          };
        })()}
      >
        {(values) => (
          <EditorContextProvider {...values()}>
            <Inner />
          </EditorContextProvider>
        )}
      </Show>
    </EditorInstanceContextProvider>
  );
}

function Inner() {
  const { project, editorState, setEditorState } = useEditorContext();

  onMount(() =>
    events.editorStateChanged.listen((e) => {
      renderFrame.clear();
      setEditorState("playbackTime", e.payload.playhead_position / FPS);
    })
  );

  const renderFrame = throttle((time: number) => {
    if (!editorState.playing) {
      events.renderFrameEvent.emit({
        frame_number: Math.max(Math.floor(time * FPS), 0),
        fps: FPS,
        resolution_base: OUTPUT_SIZE,
      });
    }
  }, 1000 / FPS);

  const frameNumberToRender = createMemo(() => {
    const preview = editorState.previewTime;
    if (preview !== null) return preview;
    return editorState.playbackTime;
  });

  createEffect(
    on(frameNumberToRender, (number) => {
      if (editorState.playing) return;
      renderFrame(number);
    })
  );

  createEffect(
    on(
      () => trackDeep(project),
      () => renderFrame(editorState.playbackTime)
    )
  );

  return (
    <>
      <Header />
      <div
        class="flex overflow-y-hidden flex-col flex-1 gap-2 pb-4 w-full leading-5 animate-in fade-in"
        data-tauri-drag-region
      >
        <div class="flex overflow-hidden flex-col flex-1">
          <div class="flex overflow-y-hidden flex-row flex-1 gap-2 px-2 pb-0.5">
            <Player />
            <ConfigSidebar />
          </div>
          <Timeline />
        </div>
        <Dialogs />
      </div>
    </>
  );
}

function Dialogs() {
  const { dialog, setDialog, presets, project } = useEditorContext();

  return (
    <Dialog.Root
      size={(() => {
        const d = dialog();
        if ("type" in d && d.type === "crop") return "lg";
        return "sm";
      })()}
      contentClass={(() => {
        const d = dialog();
        if ("type" in d && d.type === "export") return "max-w-[740px]";
        return "";
      })()}
      open={dialog().open}
      onOpenChange={(o) => {
        if (!o) setDialog((d) => ({ ...d, open: false }));
      }}
    >
      <Show
        when={(() => {
          const d = dialog();
          if ("type" in d) return d;
        })()}
      >
        {(dialog) => (
          <Switch>
            <Match when={dialog().type === "export"}>
              <ExportDialog />
            </Match>
            <Match when={dialog().type === "createPreset"}>
              {(_) => {
                const [form, setForm] = createStore({
                  name: "",
                  default: false,
                });

                const createPreset = createMutation(() => ({
                  mutationFn: async () => {
                    await presets.createPreset({ ...form, config: project });
                  },
                  onSuccess: () => {
                    setDialog((d) => ({ ...d, open: false }));
                  },
                }));

                return (
                  <DialogContent
                    title="Create Preset"
                    confirm={
                      <Dialog.ConfirmButton
                        disabled={createPreset.isPending}
                        onClick={() => createPreset.mutate()}
                      >
                        Create
                      </Dialog.ConfirmButton>
                    }
                  >
                    <Subfield name="Name" required />
                    <Input
                      class="mt-2"
                      value={form.name}
                      placeholder="Enter preset name..."
                      onInput={(e) => setForm("name", e.currentTarget.value)}
                    />
                    <Subfield name="Set as default" class="mt-4">
                      <Toggle
                        checked={form.default}
                        onChange={(checked) => setForm("default", checked)}
                      />
                    </Subfield>
                  </DialogContent>
                );
              }}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "renamePreset") return d;
              })()}
            >
              {(dialog) => {
                const [name, setName] = createSignal(
                  presets.query.data?.presets[dialog().presetIndex].name!
                );

                const renamePreset = createMutation(() => ({
                  mutationFn: async () =>
                    presets.renamePreset(dialog().presetIndex, name()),
                  onSuccess: () => {
                    setDialog((d) => ({ ...d, open: false }));
                  },
                }));

                return (
                  <DialogContent
                    title="Rename Preset"
                    confirm={
                      <Dialog.ConfirmButton
                        disabled={renamePreset.isPending}
                        onClick={() => renamePreset.mutate()}
                      >
                        Rename
                      </Dialog.ConfirmButton>
                    }
                  >
                    <Subfield name="Name" required />
                    <Input
                      class="mt-2"
                      value={name()}
                      onInput={(e) => setName(e.currentTarget.value)}
                    />
                  </DialogContent>
                );
              }}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "deletePreset") return d;
              })()}
            >
              {(dialog) => {
                const deletePreset = createMutation(() => ({
                  mutationFn: async () => {
                    await presets.deletePreset(dialog().presetIndex);
                    await presets.query.refetch();
                  },
                  onSuccess: () => {
                    setDialog((d) => ({ ...d, open: false }));
                  },
                }));

                return (
                  <DialogContent
                    title="Delete Preset"
                    confirm={
                      <Dialog.ConfirmButton
                        variant="destructive"
                        onClick={() => deletePreset.mutate()}
                        disabled={deletePreset.isPending}
                      >
                        Delete
                      </Dialog.ConfirmButton>
                    }
                  >
                    <p class="text-gray-11">
                      Are you sure you want to delete this preset?
                    </p>
                  </DialogContent>
                );
              }}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "crop") return d;
              })()}
            >
              {(dialog) => {
                const { setProject: setState, editorInstance } =
                  useEditorContext();
                const [crop, setCrop] = createStore<Crop>({
                  position: dialog().position,
                  size: dialog().size,
                });
                const [cropOptions, setCropOptions] = makePersisted(
                  createStore({
                    showGrid: false,
                  }),
                  { name: "cropOptionsState" }
                );

                const display = editorInstance.recordings.segments[0].display;

                const adjustedCrop = createMemo(() => cropToFloor(crop));

                return (
                  <>
                    <Dialog.Header>
                      <div class="flex flex-row space-x-[2rem]">
                        <div class="flex flex-row items-center space-x-[0.75rem] text-gray-11">
                          <span>Size</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="bg-transparent dark:!text-[#ababab]"
                              value={adjustedCrop().size.x}
                              onChange={(e) =>
                                setCrop((c) => ({
                                  ...c,
                                  size: {
                                    ...c.size,
                                    x: Number(e.currentTarget.value),
                                  },
                                }))
                              }
                            />
                          </div>
                          <span>x</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="bg-transparent dark:!text-[#ababab]"
                              value={adjustedCrop().size.y}
                              onChange={(e) =>
                                setCrop((c) => ({
                                  ...c,
                                  size: {
                                    ...c.size,
                                    y: Number(e.currentTarget.value),
                                  },
                                }))
                              }
                            />
                          </div>
                        </div>
                        <div class="flex flex-row items-center space-x-[0.75rem] text-gray-11">
                          <span>Position</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="bg-transparent dark:!text-[#ababab]"
                              value={adjustedCrop().position.x}
                              onChange={(e) =>
                                setCrop((c) => ({
                                  ...c,
                                  position: {
                                    ...c.position,
                                    x: Number(e.currentTarget.value),
                                  },
                                }))
                              }
                            />
                          </div>
                          <span>x</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="w-[3.25rem] bg-transparent dark:!text-[#ababab]"
                              value={adjustedCrop().position.y}
                              onChange={(e) =>
                                setCrop((c) => ({
                                  ...c,
                                  position: {
                                    ...c.position,
                                    y: Number(e.currentTarget.value),
                                  },
                                }))
                              }
                            />
                          </div>
                        </div>
                      </div>
                      <div class="flex flex-row gap-3 justify-end items-center w-full">
                        <div class="flex flex-row items-center space-x-[0.5rem] text-gray-11">
                          <Tooltip content="Rule of Thirds">
                            <button
                              type="button"
                              class={cx(
                                "flex items-center bg-gray-3 justify-center text-center rounded-[0.5rem] h-[2rem] w-[2rem] border text-[0.875rem] focus:border-blue-9 outline-none transition-colors duration-200",
                                cropOptions.showGrid
                                  ? "bg-gray-3 text-blue-9 border-blue-9"
                                  : "text-gray-12"
                              )}
                              onClick={() =>
                                setCropOptions("showGrid", (s) => !s)
                              }
                            >
                              <IconCapPadding class="w-4" />
                            </button>
                          </Tooltip>
                        </div>
                        <EditorButton
                          leftIcon={<IconCapCircleX />}
                          onClick={() =>
                            setCrop({
                              position: { x: 0, y: 0 },
                              size: {
                                x: display.width,
                                y: display.height,
                              },
                            })
                          }
                        >
                          Reset
                        </EditorButton>
                      </div>
                    </Dialog.Header>
                    <Dialog.Content>
                      <div class="flex flex-row justify-center">
                        <div class="overflow-hidden rounded divide-black-transparent-10">
                          <Cropper
                            value={crop}
                            onCropChange={setCrop}
                            mappedSize={{
                              x: display.width,
                              y: display.height,
                            }}
                            showGuideLines={cropOptions.showGrid}
                          >
                            <img
                              class="shadow pointer-events-none max-h-[70vh]"
                              alt="screenshot"
                              src={convertFileSrc(
                                `${editorInstance.path}/screenshots/display.jpg`
                              )}
                            />
                          </Cropper>
                        </div>
                      </div>
                    </Dialog.Content>
                    <Dialog.Footer>
                      <Button
                        onClick={() => {
                          setState("background", "crop", adjustedCrop());
                          setDialog((d) => ({ ...d, open: false }));
                        }}
                      >
                        Save
                      </Button>
                    </Dialog.Footer>
                  </>
                );
              }}
            </Match>
          </Switch>
        )}
      </Show>
    </Dialog.Root>
  );
}
