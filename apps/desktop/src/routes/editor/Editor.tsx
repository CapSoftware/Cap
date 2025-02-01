import { Button } from "@cap/ui-solid";
import { trackDeep } from "@solid-primitives/deep";
import { throttle } from "@solid-primitives/scheduled";
import { useSearchParams } from "@solidjs/router";
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
import { createMutation } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";

import { type Crop, events } from "~/utils/tauri";
import {
  EditorContextProvider,
  EditorInstanceContextProvider,
  FPS,
  OUTPUT_SIZE,
  useEditorContext,
  useEditorInstanceContext,
} from "./context";
import {
  Dialog,
  DialogContent,
  EditorButton,
  Input,
  Subfield,
  Toggle,
} from "./ui";
import { Header } from "./Header";
import { Player } from "./Player";
import { ConfigSidebar } from "./ConfigSidebar";
import { Timeline } from "./Timeline";
import Cropper, { cropToFloor } from "~/components/Cropper";
import { makePersisted } from "@solid-primitives/storage";
import { Tooltip } from "@kobalte/core";

export function Editor() {
  const [params] = useSearchParams<{ id: string }>();

  return (
    <Show when={params.id} fallback="No video id available" keyed>
      {(videoId) => (
        <EditorInstanceContextProvider videoId={videoId}>
          <Show
            when={(() => {
              const ctx = useEditorInstanceContext();
              const editorInstance = ctx.editorInstance();
              const presets = ctx.presets.query();

              if (!editorInstance || !presets) return;
              return { editorInstance, presets };
            })()}
          >
            {(values) => (
              <EditorContextProvider {...values()}>
                <Inner />
              </EditorContextProvider>
            )}
          </Show>
        </EditorInstanceContextProvider>
      )}
    </Show>
  );
}

function Inner() {
  const { project, playbackTime, setPlaybackTime, playing, previewTime } =
    useEditorContext();

  onMount(() => {
    events.editorStateChanged.listen((e) => {
      renderFrame.clear();
      setPlaybackTime(e.payload.playhead_position / FPS);
    });
  });

  const renderFrame = throttle((time: number) => {
    events.renderFrameEvent.emit({
      frame_number: Math.max(Math.floor(time * FPS), 0),
      fps: FPS,
      resolution_base: OUTPUT_SIZE,
    });
  }, 1000 / FPS);

  const frameNumberToRender = createMemo(() => {
    const preview = previewTime();
    if (preview !== undefined) return preview;
    return playbackTime();
  });

  createEffect(
    on(frameNumberToRender, (number) => {
      if (playing()) return;
      renderFrame(number);
    })
  );

  createEffect(
    on(
      () => {
        trackDeep(project);
      },
      () => {
        renderFrame(playbackTime());
      }
    )
  );

  return (
    <div class="w-screen h-screen flex flex-col">
      <Header />
      <div
        class="p-5 pt-0 flex-1 w-full overflow-y-hidden flex flex-col gap-4 bg-gray-50 leading-5 animate-in fade-in"
        data-tauri-drag-region
      >
        <div class="rounded-2xl overflow-hidden  shadow border flex-1 flex flex-col divide-y bg-white">
          <div class="flex flex-row flex-1 divide-x overflow-y-hidden">
            <Player />
            <ConfigSidebar />
          </div>
          <Timeline />
        </div>
        <Dialogs />
      </div>
    </div>
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
                      class="mt-[0.25rem]"
                      value={form.name}
                      onInput={(e) => setForm("name", e.currentTarget.value)}
                    />
                    <Subfield name="Set as default" class="mt-[0.75rem]">
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
                  presets.query()?.presets[dialog().presetIndex].name!
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
                  mutationFn: async () =>
                    presets.deletePreset(dialog().presetIndex),
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
                    <p class="text-gray-400">
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
                      <div class="flex flex-row space-x-[0.75rem]">
                        <div class="flex flex-row items-center space-x-[0.5rem] text-gray-400">
                          <span>Size</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="bg-transparent dark:!text-[#ababab]"
                              value={adjustedCrop().size.x}
                              disabled
                            />
                          </div>
                          <span>x</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="bg-transparent dark:!text-[#ababab]"
                              value={adjustedCrop().size.y}
                              disabled
                            />
                          </div>
                        </div>
                        <div class="flex flex-row items-center space-x-[0.5rem] text-gray-400">
                          <span>Position</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="bg-transparent dark:!text-[#ababab]"
                              value={adjustedCrop().position.x}
                              disabled
                            />
                          </div>
                          <span>x</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="w-[3.25rem] bg-transparent dark:!text-[#ababab]"
                              value={adjustedCrop().position.y}
                              disabled
                            />
                          </div>
                        </div>
                        <div class="flex flex-row items-center space-x-[0.5rem] text-gray-400">
                          <Tooltip.Root openDelay={500}>
                            <Tooltip.Trigger
                              class="fixed flex flex-row items-center w-8 h-8"
                              tabIndex={-1}
                            >
                              <button
                                type="button"
                                class={`flex items-center justify-center text-center rounded-[0.5rem] h-[2rem] w-[2rem] border text-[0.875rem] focus:border-blue-300 outline-none transition-colors duration-200 ${
                                  cropOptions.showGrid
                                    ? "bg-gray-200 text-blue-300"
                                    : "text-gray-500"
                                }`}
                                onClick={() =>
                                  setCropOptions("showGrid", (s) => !s)
                                }
                              >
                                <IconCapPadding class="w-4" />
                              </button>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                              <Tooltip.Content class="z-50 px-2 py-1 text-xs text-gray-50 bg-gray-500 rounded shadow-lg animate-in fade-in duration-100">
                                Rule of Thirds
                                <Tooltip.Arrow class="fill-gray-500" />
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          </Tooltip.Root>
                        </div>
                      </div>
                      <EditorButton
                        leftIcon={<IconCapCircleX />}
                        class="ml-auto"
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
                    </Dialog.Header>
                    <Dialog.Content>
                      <div class="flex flex-row justify-center">
                        <div class="divide-black-transparent-10 overflow-hidden rounded">
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
