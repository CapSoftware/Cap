import { Effect, Store, useStore } from "@tanstack/react-store";

const defaultFeatureFlags = {};

type FeatureFlags = typeof defaultFeatureFlags;

function safeJsonFromLocalStorage(key: string) {
	try {
		return JSON.parse(localStorage.getItem(key) || "{}");
	} catch {
		return {};
	}
}

const featureFlagsLocalStorageKey = "featureFlags";
export const featureFlags = new Store<FeatureFlags>({
	...defaultFeatureFlags,
	...safeJsonFromLocalStorage(featureFlagsLocalStorageKey),
});

new Effect({
	fn: () =>
		localStorage.setItem(
			featureFlagsLocalStorageKey,
			JSON.stringify(featureFlags.state),
		),
	deps: [featureFlags],
}).mount();

export function useFeatureFlag(name: keyof FeatureFlags) {
	return useStore(featureFlags, (state) => state[name]);
}

export function useFeatureFlags() {
	return useStore(featureFlags);
}
