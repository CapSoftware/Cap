"use client";

import dynamic from "next/dynamic";
import { createElement } from "react";
import type { ModeKey } from "../theme";
import { SCENE_META } from "./catalog";
import type { SceneModule } from "./engine";

export const SCENES: Record<ModeKey, SceneModule> = {
	instant: {
		...SCENE_META.instant,
		Scene: dynamic(() => import("./InstantScene").then((m) => m.InstantScene)),
	},
	studio: {
		...SCENE_META.studio,
		Scene: dynamic(() => import("./StudioScene").then((m) => m.StudioScene)),
	},
	screenshot: {
		...SCENE_META.screenshot,
		Scene: dynamic(() =>
			import("./ScreenshotScene").then((m) => m.ScreenshotScene),
		),
	},
	share: {
		...SCENE_META.share,
		Scene: dynamic(() => import("./AiScene").then((m) => m.AiScene)),
	},
};

export const AGENT: SceneModule = {
	...SCENE_META.agent,
	Scene: dynamic(() => import("./AgentScene").then((m) => m.AgentScene), {
		loading: () =>
			createElement("div", { style: { aspectRatio: "1200 / 520" } }),
	}),
};

export type { SceneModule, SceneProps } from "./engine";
export { Fit, STAGE } from "./engine";
