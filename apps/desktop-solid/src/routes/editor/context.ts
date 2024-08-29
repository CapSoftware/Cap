import { createContextProvider } from "@solid-primitives/context";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import type { AspectRatio, ProjectConfiguration } from "../../utils/tauri";

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

export const [EditorContextProvider, useEditorContext] = createContextProvider(
  () => {
    const [dialog, setDialog] = createSignal<DialogState>({
      open: false,
    });

    const [state, setState] = createStore<ProjectConfiguration>({
      aspectRatio: "wide",
      background: {
        // source: { type: "color", value: [255, 0, ] },
        source: {
          type: "gradient",
          from: [71, 133, 255],
          to: [255, 71, 102],
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
    });

    const [selectedTab, setSelectedTab] = createSignal<
      "background" | "camera" | "transcript" | "audio" | "cursor" | "hotkeys"
    >("camera");

    const [canvasRef, setCanvasRef] = createSignal<HTMLCanvasElement | null>(
      null
    );

    return {
      dialog,
      setDialog,
      state,
      setState,
      selectedTab,
      setSelectedTab,
      canvasRef,
      setCanvasRef,
    };
    // biome-ignore lint/style/noNonNullAssertion: context
  },
  null!
);
