import type { AspectRatio, ProjectConfiguration } from "~/utils/tauri";

export type RGBColor = [number, number, number];

export const DEFAULT_GRADIENT_FROM = [71, 133, 255] satisfies RGBColor;
export const DEFAULT_GRADIENT_TO = [255, 71, 102] satisfies RGBColor;

export const DEFAULT_PROJECT_CONFIG = {
  aspectRatio: null,
  background: {
    source: {
      type: "gradient",
      from: DEFAULT_GRADIENT_FROM,
      to: DEFAULT_GRADIENT_TO,
    },
    blur: 0,
    padding: 0,
    rounding: 0,
    inset: 0,
    crop: null,
  },
  camera: {
    hide: false,
    mirror: false,
    position: { x: "right", y: "bottom" },
    rounding: 100,
    shadow: 50,
    size: 30,
    zoom_size: 60,
  },
  audio: { mute: false, improve: false },
  cursor: {
    hideWhenIdle: false,
    size: 0,
    type: "pointer",
    animationStyle: "regular" as const,
  },
  hotkeys: { show: false },
  motionBlur: 0.2,
} satisfies ProjectConfiguration;

export const ASPECT_RATIOS = {
  wide: { name: "Wide", ratio: [16, 9] },
  vertical: { name: "Vertical", ratio: [9, 16] },
  square: { name: "Square", ratio: [1, 1] },
  classic: { name: "Classic", ratio: [4, 3] },
  tall: { name: "Tall", ratio: [3, 4] },
} satisfies Record<AspectRatio, { name: string; ratio: [number, number] }>;
