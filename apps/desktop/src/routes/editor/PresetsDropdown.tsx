import { DropdownMenu as KDropdownMenu } from "@kobalte/core/dropdown-menu";
import { cx } from "cva";
import { For, Show, Suspense, createSignal } from "solid-js";
import { reconcile } from "solid-js/store";
import { useEditorContext } from "./context";
import {
  DropdownItem,
  EditorButton,
  MenuItem,
  MenuItemList,
  PopperContent,
  dropdownContainerClasses,
  topCenterAnimateClasses,
} from "./ui";

export function PresetsDropdown() {
  const { setDialog, presets, setProject, project } = useEditorContext();
  return (
    <KDropdownMenu gutter={8} placement="bottom">
      <EditorButton<typeof KDropdownMenu.Trigger>
        as={KDropdownMenu.Trigger}
        leftIcon={<IconCapPresets />}
        rightIcon={<IconCapChevronDown />}
      >
        Presets
      </EditorButton>
      <KDropdownMenu.Portal>
        <Suspense>
          <PopperContent<typeof KDropdownMenu.Content>
            as={KDropdownMenu.Content}
            class={cx("w-72 max-h-56", topCenterAnimateClasses)}
          >
            <MenuItemList<typeof KDropdownMenu.Group>
              as={KDropdownMenu.Group}
              class="overflow-y-auto flex-1 scrollbar-none"
            >
              <For
                each={presets.query.data?.presets ?? []}
                fallback={
                  <div class="py-1 w-full text-sm text-center text-gray-11">
                    No Presets
                  </div>
                }
              >
                {(preset, i) => {
                  const [showSettings, setShowSettings] = createSignal(false);

                  function applyPreset() {
                    setShowSettings(false);
                    setProject(
                      reconcile({
                        ...preset.config,
                        timeline: project.timeline,
                      })
                    );
                  }

                  return (
                    <KDropdownMenu.Sub gutter={16}>
                      <MenuItem<typeof KDropdownMenu.SubTrigger>
                        as={KDropdownMenu.SubTrigger}
                        class="h-[2.5rem]"
                        onFocusIn={() => setShowSettings(false)}
                        onClick={() => {
                          applyPreset();
                        }}
                      >
                        <span class="mr-auto">{preset.name}</span>
                        <Show when={presets.query.data?.default === i()}>
                          <span class="px-2 py-1 text-[11px] rounded-full bg-gray-2 text-gray-11">
                            Default
                          </span>
                        </Show>
                        <button
                          type="button"
                          class="text-gray-11 hover:text-[currentColor]"
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
                              "w-44 animate-in fade-in slide-in-from-left-1",
                              dropdownContainerClasses
                            )}
                          >
                            <DropdownItem
                              onSelect={() => {
                                applyPreset();
                              }}
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

export default PresetsDropdown;
