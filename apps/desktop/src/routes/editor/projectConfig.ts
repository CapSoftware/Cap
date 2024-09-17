import type { AspectRatio, ProjectConfiguration } from "~/utils/tauri";

export type RGBColor = [number, number, number];

export const DEFAULT_GRADIENT_FROM = [71, 133, 255] satisfies RGBColor;
export const DEFAULT_GRADIENT_TO = [255, 71, 102] satisfies RGBColor;

export const DEFAULT_PROJECT_CONFIG: ProjectConfiguration = {
  aspectRatio: "wide",
  background: {
    source: {
      type: "gradient",
      from: DEFAULT_GRADIENT_FROM,
      to: DEFAULT_GRADIENT_TO,
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

export const ASPECT_RATIOS = {
  wide: { name: "Wide", ratio: [16, 9] },
  vertical: { name: "Vertical", ratio: [9, 16] },
  square: { name: "Square", ratio: [1, 1] },
  classic: { name: "Classic", ratio: [4, 3] },
  tall: { name: "Tall", ratio: [3, 4] },
} satisfies Record<AspectRatio, { name: string; ratio: [number, number] }>;
