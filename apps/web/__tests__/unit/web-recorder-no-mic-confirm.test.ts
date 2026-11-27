// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modulePath =
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/no-microphone-confirm";

let storage = new Map<string, string>();

const loadModule = async () => {
	vi.resetModules();
	return import(modulePath);
};

beforeEach(() => {
	storage = new Map();
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("no microphone confirm", () => {
	it("asks when no microphone is active and nothing was chosen", async () => {
		const { shouldConfirmNoMicrophone } = await loadModule();
		expect(
			shouldConfirmNoMicrophone({ micEnabled: false, micExplicitlyOff: false }),
		).toBe(true);
	});

	it("never asks when a microphone is active", async () => {
		const { shouldConfirmNoMicrophone } = await loadModule();
		expect(
			shouldConfirmNoMicrophone({ micEnabled: true, micExplicitlyOff: false }),
		).toBe(false);
	});

	it("does not ask when the user chose No Microphone", async () => {
		const { shouldConfirmNoMicrophone } = await loadModule();
		expect(
			shouldConfirmNoMicrophone({ micEnabled: false, micExplicitlyOff: true }),
		).toBe(false);
	});

	it("asks once per session", async () => {
		const { shouldConfirmNoMicrophone, rememberNoMicrophoneConfirmed } =
			await loadModule();
		rememberNoMicrophoneConfirmed();
		expect(
			shouldConfirmNoMicrophone({ micEnabled: false, micExplicitlyOff: false }),
		).toBe(false);

		const reloaded = await loadModule();
		expect(
			reloaded.shouldConfirmNoMicrophone({
				micEnabled: false,
				micExplicitlyOff: false,
			}),
		).toBe(false);

		storage.clear();
		const newSession = await loadModule();
		expect(
			newSession.shouldConfirmNoMicrophone({
				micEnabled: false,
				micExplicitlyOff: false,
			}),
		).toBe(true);
	});

	it("still remembers the answer when sessionStorage throws", async () => {
		vi.stubGlobal("sessionStorage", {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		});
		const { shouldConfirmNoMicrophone, rememberNoMicrophoneConfirmed } =
			await loadModule();
		expect(
			shouldConfirmNoMicrophone({ micEnabled: false, micExplicitlyOff: false }),
		).toBe(true);
		rememberNoMicrophoneConfirmed();
		expect(
			shouldConfirmNoMicrophone({ micEnabled: false, micExplicitlyOff: false }),
		).toBe(false);
	});
});
