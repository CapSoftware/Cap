import { createContextProvider } from "@solid-primitives/context";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

export const ASPECT_RATIOS = [
  { name: "Wide", ratio: [16, 9] },
  { name: "Vertical", ratio: [9, 16] },
  { name: "Square", ratio: [1, 1] },
  { name: "Classic", ratio: [4, 3] },
  { name: "Tall", ratio: [3, 4] },
] as const;

export type AspectRatioName = (typeof ASPECT_RATIOS)[number]["name"];

export type CurrentDialog =
  | { type: "createPreset" }
  | { type: "renamePreset"; presetId: string }
  | { type: "deletePreset"; presetId: string }
  | { type: "crop" };

export type CameraPosition = { x: "l" | "c" | "r"; y: "t" | "b" };
export type CursorType = "pointer" | "circle";

export type BackgroundSource =
  | { type: "Wallpaper"; id: number }
  | { type: "Image"; path: string | null }
  | { type: "Color"; value: string }
  | { type: "Gradient"; from: string; to: string };
export type BackgroundSourceType = BackgroundSource["type"];

export type State = {
  aspectRatio: AspectRatioName | "Auto";
  background: {
    source: BackgroundSource;
    blur: number;
    padding: number;
    rounding: number;
    inset: number;
  };
  camera: {
    hide: boolean;
    mirror: boolean;
    position: CameraPosition;
    rounding: number;
    shadow: number;
  };
  audio: {
    mute: boolean;
    improve: boolean;
  };
  cursor: {
    hideWhenIdle: boolean;
    size: number;
    type: CursorType;
  };
  hotkeys: {
    show: boolean;
  };
};

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

export const [EditorContextProvider, useEditorContext] = createContextProvider(
  () => {
    const [dialog, setDialog] = createSignal<DialogState>({
      open: false,
    });

    const [state, setState] = createStore<State>({
      aspectRatio: "Wide",
      background: {
        source: { type: "Wallpaper", id: 0 },
        blur: 0,
        padding: 0,
        rounding: 0,
        inset: 0,
      },
      camera: {
        hide: false,
        mirror: false,
        position: { x: "r", y: "b" },
        rounding: 0,
        shadow: 0,
      },
      audio: {
        mute: false,
        improve: false,
      },
      cursor: {
        hideWhenIdle: false,
        size: 0,
        type: "pointer",
      },
      hotkeys: {
        show: false,
      },
    });

    const [selectedTab, setSelectedTab] = createSignal<
      "background" | "camera" | "transcript" | "audio" | "cursor" | "hotkeys"
    >("background");

    return {
      dialog,
      setDialog,
      state,
      setState,
      selectedTab,
      setSelectedTab,
    };
    // biome-ignore lint/style/noNonNullAssertion: context
  },
  null!
);
