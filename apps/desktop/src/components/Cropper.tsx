import { createEventListenerMap } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import {
  type CheckMenuItemOptions,
  Menu,
  PredefinedMenuItemOptions,
  SubmenuOptions,
} from "@tauri-apps/api/menu";
import { type as ostype } from "@tauri-apps/plugin-os";
import {
  type ParentProps,
  batch,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Transition } from "solid-transition-group";
import { generalSettingsStore } from "~/store";
import Box from "~/utils/crop/box";
import { type Crop, type XY, commands } from "~/utils/tauri";
import CropAreaRenderer from "./CropAreaRenderer";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CropController } from "~/utils/crop/controller";

type Direction = "n" | "e" | "s" | "w" | "nw" | "ne" | "se" | "sw";
type HandleSide = {
  x: "l" | "r" | "c";
  y: "t" | "b" | "c";
  direction: Direction;
  cursor: `${"ew" | "ns" | "nesw" | "nwse"}-resize`;
};

const HANDLES: HandleSide[] = [
  { x: "l", y: "t", direction: "nw", cursor: "nwse-resize" },
  { x: "r", y: "t", direction: "ne", cursor: "nesw-resize" },
  { x: "l", y: "b", direction: "sw", cursor: "nesw-resize" },
  { x: "r", y: "b", direction: "se", cursor: "nwse-resize" },
  { x: "c", y: "t", direction: "n", cursor: "ns-resize" },
  { x: "c", y: "b", direction: "s", cursor: "ns-resize" },
  { x: "l", y: "c", direction: "w", cursor: "ew-resize" },
  { x: "r", y: "c", direction: "e", cursor: "ew-resize" },
];

type Ratio = [number, number];
const COMMON_RATIOS: Ratio[] = [
  [1, 1],
  [4, 3],
  [3, 2],
  [16, 9],
  [2, 1],
  [21, 9],
];
const SNAP_RATIO_EL_WIDTH_PX = 40;

const KEY_MAPPINGS = new Map([
  ["ArrowRight", "e"],
  ["ArrowDown", "s"],
  ["ArrowLeft", "w"],
  ["ArrowUp", "n"],
]);

const ORIGIN_CENTER: XY<number> = { x: 0.5, y: 0.5 };

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

function distanceOf(firstPoint: Touch, secondPoint: Touch): number {
  const dx = firstPoint.clientX - secondPoint.clientX;
  const dy = firstPoint.clientY - secondPoint.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export default function Cropper(
  props: ParentProps<{
    class?: string;
    controller: CropController;
    showGuideLines?: boolean;
  }>
) {
  const controller = props.controller;
}
