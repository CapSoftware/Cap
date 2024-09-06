import { createContextProvider } from "@solid-primitives/context";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import type { AspectRatio, ProjectConfiguration } from "../../utils/tauri";
import { useSearchParams } from "@solidjs/router";

export const ASPECT_RATIOS = {
  wide: { name: "Wide", ratio: [16, 9] },
  vertical: { name: "Vertical", ratio: [9, 16] },
  square: { name: "Square", ratio: [1, 1] },
  classic: { name: "Classic", ratio: [4, 3] },
  tall: { name: "Tall", ratio: [3, 4] },
} satisfies Record<AspectRatio, { name: string; ratio: [number, number] }>;

export type CurrentDialog =
  | { type: "createPreset" }
  | { type: "renamePreset"; presetId: string }
  | { type: "deletePreset"; presetId: string }
  | { type: "crop" };

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

export const DEFAULT_FROM = [71, 133, 255] satisfies [number, number, number];
export const DEFAULT_TO = [255, 71, 102] satisfies [number, number, number];

export const DEFAULT_CONFIG: ProjectConfiguration = {
  aspectRatio: "wide",
  background: {
    source: {
      type: "gradient",
      from: DEFAULT_FROM,
      to: DEFAULT_TO,
    },
    blur: 0,
    padding: 10,
    rounding: 20,
    inset: 0,
  },
  camera: {
    hide: false,
    mirror: false,
    position: { x: "left", y: "top" },
    rounding: 100,
    shadow: 50,
  },
  audio: { mute: false, improve: false },
  cursor: { hideWhenIdle: false, size: 0, type: "pointer" },
  hotkeys: { show: false },
};

export const [EditorContextProvider, useEditorContext] = createContextProvider(
  () => {
    const [dialog, setDialog] = createSignal<DialogState>({
      open: false,
    });

    const [state, setState] = createStore<ProjectConfiguration>(DEFAULT_CONFIG);

    const [selectedTab, setSelectedTab] = createSignal<
      "background" | "camera" | "transcript" | "audio" | "cursor" | "hotkeys"
    >("background");

    const [canvasRef, setCanvasRef] = createSignal<HTMLCanvasElement | null>(
      null
    );

    const [params] = useSearchParams<{ path: string }>();

    const videoId = () => params.path.split("/").at(-1)?.split(".")[0]!;

    return {
      dialog,
      setDialog,
      state,
      setState,
      selectedTab,
      setSelectedTab,
      canvasRef,
      setCanvasRef,
      videoId,
    };
    // biome-ignore lint/style/noNonNullAssertion: context
  },
  null!
);
