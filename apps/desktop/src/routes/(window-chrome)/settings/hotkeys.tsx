import { Button } from "@cap/ui-solid";
import { createEventListener } from "@solid-primitives/event-listener";
import {
  Index,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createResource,
  createSignal,
} from "solid-js";
import { createStore } from "solid-js/store";
import { hotkeysStore } from "~/store";

import {
  type Hotkey,
  type HotkeyAction,
  type HotkeysStore,
  commands,
} from "~/utils/tauri";

const ACTION_TEXT: Record<HotkeyAction, string> = {
  startRecording: "Start Recording",
  stopRecording: "Stop Recording",
  restartRecording: "Restart Recording",
  takeScreenshot: "Take Screenshot",
};

export default function () {
  const [store] = createResource(() => hotkeysStore.get());

  return (
    <Show when={store.state === "ready" && ([store()] as const)}>
      {(store) => <Inner initialStore={store()[0] ?? null} />}
    </Show>
  );
}

function Inner(props: { initialStore: HotkeysStore | null }) {
  const [hotkeys, setHotkeys] = createStore<{
    [K in HotkeyAction]?: Hotkey;
  }>(props.initialStore?.hotkeys ?? {});

  createEffect(() => {
    hotkeysStore.set({ hotkeys: { ...hotkeys } as any });
  });

  const [listening, setListening] = createSignal<{
    action: HotkeyAction;
    prev?: Hotkey;
  }>();

  createEventListener(window, "keydown", (e) => {
    const data = {
      code: e.code,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
    };

    if (
      !(
        (data.code >= "KeyA" && data.code <= "KeyZ") ||
        (data.code >= "Key0" && data.code <= "Key9") ||
        data.code.startsWith("F")
      )
    )
      return;

    const l = listening();
    if (l) {
      e.preventDefault();

      setHotkeys(l.action, data);
    }
  });

  return (
    <div class="flex flex-col w-full h-full divide-y divide-gray-200">
      <ul class="flex-1 p-[0.625rem] flex flex-col gap-[0.5rem] w-full">
        <Index
          each={
            [
              "startRecording",
              "stopRecording",
              "restartRecording",
              "takeScreenshot",
            ] as Array<HotkeyAction>
          }
        >
          {(item) => {
            createEventListener(window, "click", () => {
              if (listening()?.action !== item()) return;

              console.log(listening());
              batch(() => {
                setHotkeys(item(), listening()?.prev);
                setListening();
              });
            });

            return (
              <li class="w-full flex flex-row justify-between items-center text-[--text-primary]">
                <span>{ACTION_TEXT[item()]}</span>
                <div class="w-[9rem] h-[2rem] ">
                  <Switch>
                    <Match when={listening()?.action === item()}>
                      <div class="border border-[--gray-300] rounded-lg text-[--text-tertiary] w-full h-full bg-[--gray-100] flex flex-row items-center justify-between px-[0.375rem]">
                        <Show when={hotkeys[item()]} fallback="Listening">
                          {(binding) => <HotkeyText binding={binding()} />}
                        </Show>
                        <div class="flex flex-row items-center gap-[0.125rem] text-[--text-tertiary]">
                          <Show when={hotkeys[item()]}>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();

                                setListening();
                                commands.setHotkey(
                                  item(),
                                  hotkeys[item()] ?? null
                                );
                              }}
                            >
                              <IconCapCircleCheck class="size-[1.25rem] text-[--blue-400]" />
                            </button>
                          </Show>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              batch(() => {
                                setListening();
                                // biome-ignore lint/style/noNonNullAssertion: store
                                setHotkeys(item(), undefined!);
                                commands.setHotkey(item(), null);
                              });
                            }}
                          >
                            <IconCapCircleX class="size-[1.25rem] text-[--gray-400]" />
                          </button>
                        </div>
                      </div>
                    </Match>
                    <Match when={listening()?.action !== item()}>
                      <button
                        type="button"
                        class="border border-[--gray-200] rounded-lg text-[--text-tertiary] w-full h-full"
                        onClick={(e) => {
                          e.stopPropagation();
                          setListening({
                            action: item(),
                            prev: hotkeys[item()],
                          });
                        }}
                      >
                        <Show when={hotkeys[item()]} fallback="None">
                          {(binding) => <HotkeyText binding={binding()} />}
                        </Show>
                      </button>
                    </Match>
                  </Switch>
                </div>
              </li>
            );
          }}
        </Index>
      </ul>
      <div class="flex flex-row-reverse p-[1rem] text-[--text-primary]">
        <Button disabled variant="secondary">
          Restore Defaults
        </Button>
      </div>
    </div>
  );
}

function HotkeyText(props: { binding: Hotkey }) {
  return (
    <span class="space-x-0.5 text-[--text-tertiary]">
      {props.binding.meta && <span>⌘</span>}
      {props.binding.ctrl && <span>⌃</span>}
      {props.binding.alt && <span>⌥</span>}
      {props.binding.shift && <span>⇧</span>}
      <span>
        {props.binding.code.startsWith("Key")
          ? props.binding.code[3]
          : props.binding.code}
      </span>
    </span>
  );
}
