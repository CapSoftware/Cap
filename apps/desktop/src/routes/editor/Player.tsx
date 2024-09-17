import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { Select as KSelect } from "@kobalte/core/select";
import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { cx } from "cva";
import { For, Show, Suspense, createEffect, createSignal } from "solid-js";
import { reconcile } from "solid-js/store";

import { type AspectRatio, commands } from "~/utils/tauri";
import { useEditorContext } from "./context";
import {
  ComingSoonTooltip,
  DropdownItem,
  EditorButton,
  MenuItem,
  MenuItemList,
  PopperContent,
  dropdownContainerClasses,
  topLeftAnimateClasses,
} from "./ui";
import { ASPECT_RATIOS } from "./projectConfig";
import { OUTPUT_SIZE } from "./editorInstanceContext";
import { formatTime } from "./utils";

export function Player() {
  const {
    project,
    videoId,
    editorInstance,
    history,
    currentFrame,
    setDialog,
    playbackTime,
    setPlaybackTime,
    playing,
    setPlaying,
  } = useEditorContext();

  let canvasRef: HTMLCanvasElement;

  createEffect(() => {
    const frame = currentFrame();
    if (!frame) return;
    const ctx = canvasRef.getContext("2d");
    ctx?.putImageData(frame, 0, 0);
  });

  return (
    <div class="flex flex-col divide-y flex-1">
      <div class="flex flex-row justify-between font-medium p-[0.75rem] text-[0.875rem]">
        <div class="flex flex-row items-center gap-[0.5rem]">
          <AspectRatioSelect />
          <EditorButton
            leftIcon={<IconCapCrop />}
            onClick={() => {
              setDialog({
                open: true,
                type: "crop",
                position: {
                  ...(project.background.crop?.position ?? {
                    x: 0,
                    y: 0,
                  }),
                },
                size: {
                  ...(project.background.crop?.size ?? {
                    x: editorInstance.recordings.display.width,
                    y: editorInstance.recordings.display.height,
                  }),
                },
              });
            }}
          >
            Crop
          </EditorButton>
          <PresetsDropdown />
        </div>
        <div class="flex flex-row place-items-center gap-2">
          <EditorButton
            disabled={!history.canUndo()}
            leftIcon={<IconCapUndo />}
            onClick={() => history.undo()}
          >
            Undo
          </EditorButton>
          <EditorButton
            disabled={!history.canRedo()}
            leftIcon={<IconCapRedo />}
            onClick={() => history.redo()}
          >
            Redo
          </EditorButton>
        </div>
      </div>
      <div class="bg-gray-100 flex items-center justify-center flex-1 flex-row object-contain p-4">
        <canvas
          class="bg-blue-50 w-full"
          // biome-ignore lint/style/noNonNullAssertion: ref
          ref={canvasRef!}
          id="canvas"
          width={OUTPUT_SIZE.width}
          height={OUTPUT_SIZE.height}
        />
      </div>
      <div class="flex flex-row items-center p-[0.75rem]">
        <div class="flex-1" />
        <div class="flex flex-row items-center justify-center gap-[0.5rem] text-gray-400 text-[0.875rem]">
          <span>{formatTime(playbackTime())}</span>
          <button type="button" disabled>
            <IconCapFrameFirst class="size-[1.2rem]" />
          </button>
          {!playing() ? (
            <button
              type="button"
              onClick={() =>
                commands
                  .startPlayback(videoId, project)
                  .then(() => setPlaying(true))
              }
            >
              <IconCapPlayCircle class="size-[1.5rem]" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                commands.stopPlayback(videoId).then(() => setPlaying(false))
              }
            >
              <IconCapStopCircle class="size-[1.5rem]" />
            </button>
          )}
          <button type="button" disabled>
            <IconCapFrameLast class="size-[1rem]" />
          </button>
          <span>
            {formatTime(
              project.timeline?.segments.reduce(
                (acc, s) => acc + (s.end - s.start) / s.timescale,
                0
              ) ?? editorInstance.recordingDuration
            )}
          </span>
        </div>
        <div class="flex-1 flex flex-row justify-end">
          <ComingSoonTooltip>
            <EditorButton<typeof KToggleButton>
              disabled
              as={KToggleButton}
              variant="danger"
              leftIcon={<IconCapScissors />}
            >
              Split
            </EditorButton>
          </ComingSoonTooltip>
        </div>
      </div>
    </div>
  );
}

function AspectRatioSelect() {
  const { project, setProject } = useEditorContext();

  return (
    <ComingSoonTooltip>
      <KSelect<AspectRatio | "auto">
        disabled
        value={project.aspectRatio ?? "auto"}
        onChange={(v) => {
          if (v === null) return;
          setProject("aspectRatio", v === "auto" ? null : v);
        }}
        defaultValue="auto"
        options={
          ["auto", "wide", "vertical", "square", "classic", "tall"] as const
        }
        multiple={false}
        itemComponent={(props) => {
          const item = () =>
            ASPECT_RATIOS[
              props.item.rawValue === "auto" ? "wide" : props.item.rawValue
            ];

          return (
            <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
              <KSelect.ItemLabel class="flex-1">
                {props.item.rawValue === "auto"
                  ? "Auto"
                  : ASPECT_RATIOS[props.item.rawValue].name}
                <Show when={item()}>
                  {(item) => (
                    <span class="text-gray-400">
                      {"⋅"}
                      {item().ratio[0]}:{item().ratio[1]}
                    </span>
                  )}
                </Show>
              </KSelect.ItemLabel>
              <KSelect.ItemIndicator class="ml-auto">
                <IconCapCircleCheck />
              </KSelect.ItemIndicator>
            </MenuItem>
          );
        }}
        placement="top-start"
      >
        <EditorButton<typeof KSelect.Trigger>
          as={KSelect.Trigger}
          leftIcon={<IconCapLayout />}
          rightIcon={
            <KSelect.Icon>
              <IconCapChevronDown />
            </KSelect.Icon>
          }
        >
          <KSelect.Value<AspectRatio | "auto">>
            {(state) => {
              const text = () => {
                const option = state.selectedOption();
                return option === "auto" ? "Auto" : ASPECT_RATIOS[option].name;
              };
              return <>{text()}</>;
            }}
          </KSelect.Value>
        </EditorButton>
        <KSelect.Portal>
          <PopperContent<typeof KSelect.Content>
            as={KSelect.Content}
            class={topLeftAnimateClasses}
          >
            <MenuItemList<typeof KSelect.Listbox>
              as={KSelect.Listbox}
              class="w-[12.5rem]"
            />
          </PopperContent>
        </KSelect.Portal>
      </KSelect>
    </ComingSoonTooltip>
  );
}

function PresetsDropdown() {
  const { setDialog, presets, setProject } = useEditorContext();

  return (
    <KDropdownMenu gutter={8}>
      <EditorButton<typeof KDropdownMenu.Trigger>
        as={KDropdownMenu.Trigger}
        leftIcon={<IconCapPresets />}
      >
        Presets
      </EditorButton>
      <KDropdownMenu.Portal>
        <Suspense>
          <PopperContent<typeof KDropdownMenu.Content>
            as={KDropdownMenu.Content}
            class={cx("w-72 max-h-56", topLeftAnimateClasses)}
          >
            <MenuItemList<typeof KDropdownMenu.Group>
              as={KDropdownMenu.Group}
              class="flex-1 overflow-y-auto scrollbar-none"
            >
              <For
                each={presets.query()?.presets ?? []}
                fallback={
                  <div class="w-full text-sm text-gray-400 text-center py-1">
                    No Presets
                  </div>
                }
              >
                {(preset, i) => {
                  const [showSettings, setShowSettings] = createSignal(false);

                  console.log(presets.query());

                  return (
                    <KDropdownMenu.Sub gutter={16}>
                      <MenuItem<typeof KDropdownMenu.SubTrigger>
                        as={KDropdownMenu.SubTrigger}
                        onFocusIn={() => setShowSettings(false)}
                        onClick={() => setShowSettings(false)}
                      >
                        <span class="mr-auto">{preset.name}</span>
                        <Show when={presets.query()?.default === i()}>
                          <span class="px-[0.375rem] h-[1.25rem] rounded-full bg-gray-100 text-gray-400 text-[0.75rem]">
                            Default
                          </span>
                        </Show>
                        <button
                          type="button"
                          class="text-gray-400 hover:text-black"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowSettings((s) => !s);
                          }}
                          onPointerUp={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                        >
                          <IconCapSettings />
                        </button>
                      </MenuItem>
                      <KDropdownMenu.Portal>
                        {showSettings() && (
                          <MenuItemList<typeof KDropdownMenu.SubContent>
                            as={KDropdownMenu.SubContent}
                            class={cx(
                              "animate-in fade-in slide-in-from-left-1 w-44",
                              dropdownContainerClasses
                            )}
                          >
                            <DropdownItem
                              onSelect={() =>
                                setProject(reconcile(preset.config))
                              }
                            >
                              Apply
                            </DropdownItem>
                            <DropdownItem
                              onSelect={() => presets.setDefault(i())}
                            >
                              Set as default
                            </DropdownItem>
                            <DropdownItem
                              onSelect={() =>
                                setDialog({
                                  type: "renamePreset",
                                  presetIndex: i(),
                                  open: true,
                                })
                              }
                            >
                              Rename
                            </DropdownItem>
                            <DropdownItem
                              onClick={() =>
                                setDialog({
                                  type: "deletePreset",
                                  presetIndex: i(),
                                  open: true,
                                })
                              }
                            >
                              Delete
                            </DropdownItem>
                          </MenuItemList>
                        )}
                      </KDropdownMenu.Portal>
                    </KDropdownMenu.Sub>
                  );
                }}
              </For>
            </MenuItemList>
            <MenuItemList<typeof KDropdownMenu.Group>
              as={KDropdownMenu.Group}
              class="border-t shrink-0"
            >
              <DropdownItem
                onSelect={() => setDialog({ type: "createPreset", open: true })}
              >
                <span>Create new preset</span>
                <IconCapCirclePlus class="ml-auto" />
              </DropdownItem>
            </MenuItemList>
          </PopperContent>
        </Suspense>
      </KDropdownMenu.Portal>
    </KDropdownMenu>
  );
}
