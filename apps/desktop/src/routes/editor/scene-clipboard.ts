import { createSignal } from "solid-js";
import type { SceneSegment, SplitLayout } from "~/utils/tauri";

export type SceneSettings = Pick<
	SceneSegment,
	"mode" | "splitLayout" | "transitionIn" | "transitionOut"
>;

const [copiedSceneSettings, setCopiedSceneSettings] =
	createSignal<SceneSettings | null>(null);

export { copiedSceneSettings };

function cloneSplitLayout(layout: SplitLayout | null | undefined) {
	if (!layout) return null;
	return {
		screenZoom: layout.screenZoom,
		screenPosition: { ...layout.screenPosition },
		cameraZoom: layout.cameraZoom,
		cameraPosition: { ...layout.cameraPosition },
	};
}

export function copySceneSettings(segment: SceneSegment) {
	setCopiedSceneSettings({
		mode: segment.mode,
		splitLayout: cloneSplitLayout(segment.splitLayout),
		transitionIn: segment.transitionIn,
		transitionOut: segment.transitionOut,
	});
}

export function withSceneSettings(
	segment: SceneSegment,
	settings: SceneSettings,
): SceneSegment {
	return {
		...segment,
		mode: settings.mode,
		splitLayout: cloneSplitLayout(settings.splitLayout),
		transitionIn: settings.transitionIn,
		transitionOut: settings.transitionOut,
	};
}

if (import.meta.vitest) {
	const { expect, it } = import.meta.vitest;

	it("pastes a scene's look without moving the target", () => {
		const source: SceneSegment = {
			start: 0,
			end: 4,
			mode: "cameraOnly",
			splitLayout: {
				screenZoom: 1,
				screenPosition: { x: 0.5, y: 0.5 },
				cameraZoom: 1.6,
				cameraPosition: { x: 0.3, y: 0.4 },
			},
			transitionIn: 0,
			transitionOut: 0.5,
		};
		copySceneSettings(source);
		const settings = copiedSceneSettings();
		expect(settings).not.toBeNull();
		const pasted = withSceneSettings(
			{
				start: 10,
				end: 12,
				mode: "default",
				splitLayout: null,
				transitionIn: 0.3,
				transitionOut: 0.3,
			},
			settings as SceneSettings,
		);
		expect(pasted.start).toBe(10);
		expect(pasted.end).toBe(12);
		expect(pasted.mode).toBe("cameraOnly");
		expect(pasted.splitLayout?.cameraZoom).toBe(1.6);
		expect(pasted.transitionOut).toBe(0.5);
		if (pasted.splitLayout) pasted.splitLayout.cameraPosition.x = 0.9;
		expect(source.splitLayout?.cameraPosition.x).toBe(0.3);
	});

	it("copies a scene whose layout is a store proxy", () => {
		const layout: SplitLayout = {
			screenZoom: 1.2,
			screenPosition: { x: 0.5, y: 0.5 },
			cameraZoom: 1,
			cameraPosition: { x: 0.2, y: 0.8 },
		};
		const proxied = new Proxy(layout, {});
		expect(() => structuredClone(proxied)).toThrow();
		copySceneSettings({
			start: 0,
			end: 1,
			mode: "splitScreen",
			splitLayout: proxied,
		});
		expect(copiedSceneSettings()?.splitLayout).toEqual(layout);
	});
}
