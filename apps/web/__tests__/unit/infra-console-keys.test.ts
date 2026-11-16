// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	button,
	click,
	flush,
	openStage,
	type Stage,
	text,
	type,
	until,
} from "./infra-console-harness";

const PUBLIC_KEY = "cpk_public_key_value";
const SECRET_KEY = "csk_secret_key_value";

const mocks = vi.hoisted(() => ({
	router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
	toast: { success: vi.fn(), error: vi.fn() },
	createApp: vi.fn(),
	regenerate: vi.fn(),
	writeText: vi.fn(async (_value: string) => undefined),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => mocks.router,
	usePathname: () => "/dashboard/infra/a1",
}));
vi.mock("next/link", () => ({
	default: ({
		href,
		children,
		className,
	}: {
		href: string;
		children: ReactNode;
		className?: string;
	}) => createElement("a", { href, className }, children),
}));
vi.mock("next/font/google", () => ({
	Geist: () => ({ variable: "sans" }),
	Geist_Mono: () => ({ variable: "mono" }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("js-cookie", () => ({ default: { set: vi.fn(), remove: vi.fn() } }));
vi.mock("@/actions/developers/create-app", () => ({
	createDeveloperApp: mocks.createApp,
}));
vi.mock("@/actions/developers/regenerate-keys", () => ({
	regenerateDeveloperKeys: mocks.regenerate,
}));
vi.mock("@/actions/developers/delete-video", () => ({
	deleteDeveloperVideo: vi.fn(),
}));
vi.mock("@/lib/EffectRuntime", async () => {
	const { useMutation } = await import("@tanstack/react-query");
	const { Cause, Effect, Exit } = await import("effect");
	type Options = {
		mutationFn: (input: unknown) => Parameters<typeof Effect.runPromiseExit>[0];
		onSuccess?: (result: unknown, input: unknown) => void;
		onError?: (cause: unknown) => void;
	};
	return {
		useEffectMutation: (options: Options) =>
			useMutation({
				mutationFn: async (input: unknown) => {
					const exit = await Effect.runPromiseExit(options.mutationFn(input));
					if (Exit.isSuccess(exit)) return exit.value;
					throw exit.cause;
				},
				onSuccess: options.onSuccess,
				onError: (cause) =>
					options.onError?.(Cause.isCause(cause) ? cause : Cause.die(cause)),
			}),
	};
});
vi.mock("@/app/(infra)/dashboard/infra/_components/shell", () => ({
	Brand: () => createElement("span", null, "Cap Infra"),
}));
vi.mock("@/app/(infra)/dashboard/infra/_components/pro-credit", () => ({
	ProCredit: () => null,
}));

const { NewAppModal } = await import(
	"@/app/(infra)/dashboard/infra/_components/create-app"
);
const { FirstRun } = await import(
	"@/app/(infra)/dashboard/infra/_components/first-run"
);
const { ApiKeysClient } = await import(
	"@/app/(infra)/dashboard/infra/[appId]/keys/api-keys-client"
);

let stage: Stage;
let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

const dialog = () => document.querySelector("[role=dialog]");

const pressEscape = () =>
	act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
	});

const pressOutside = async () => {
	await flush();
	const outside = document.querySelector(".fixed.inset-0") ?? document.body;
	await act(async () => {
		outside.dispatchEvent(
			new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
		);
		outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await flush();
};

const openNewApp = async () => {
	onOpenChange = vi.fn<(open: boolean) => void>();
	await stage.render(createElement(NewAppModal, { open: true, onOpenChange }));
	await flush();
};

const createApp = async (name: string) => {
	const input = document.querySelector<HTMLInputElement>(
		'input[placeholder^="App name"]',
	);
	if (!input) throw new Error("Name input not found");
	await type(input, name);
	await click(button("Create app"));
	await until(() => text().includes("Secret key"), "the one-time key");
};

beforeEach(() => {
	stage = openStage();
	mocks.createApp.mockResolvedValue({
		appId: "a2",
		publicKey: PUBLIC_KEY,
		secretKey: SECRET_KEY,
	});
	mocks.regenerate.mockResolvedValue({
		publicKey: PUBLIC_KEY,
		secretKey: SECRET_KEY,
	});
	vi.stubGlobal("navigator", {
		...navigator,
		clipboard: { writeText: mocks.writeText },
	});
});

afterEach(async () => {
	await stage.close();
});

describe("the new app dialog before the key exists", () => {
	it("closes on Escape like any other dialog", async () => {
		await openNewApp();
		expect(dialog()).not.toBeNull();

		await pressEscape();

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("closes on a click outside like any other dialog", async () => {
		await openNewApp();

		await pressOutside();

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});

describe("the one-time secret key dialog", () => {
	beforeEach(async () => {
		await openNewApp();
		await createApp("Acme Player");
	});

	it("names the app and shows the secret key only", () => {
		expect(text()).toContain("Copy your secret key");
		expect(text()).toContain("Acme Player is ready.");
		expect(text()).toContain("Shown once.");
		expect(text()).not.toContain("Public key");
		expect(text()).not.toContain("cpk_");
	});

	it("stays open on Escape", async () => {
		await pressEscape();
		await pressEscape();

		expect(onOpenChange).not.toHaveBeenCalled();
		expect(mocks.router.push).not.toHaveBeenCalled();
		expect(dialog()?.textContent).toContain("Copy your secret key");
	});

	it("stays open on a click outside", async () => {
		await pressOutside();

		expect(onOpenChange).not.toHaveBeenCalled();
		expect(mocks.router.push).not.toHaveBeenCalled();
		expect(dialog()?.textContent).toContain("Copy your secret key");
	});

	it("copies the secret key alone as .env", async () => {
		await click(button("Copy as .env"));

		expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(
			`CAP_SECRET_KEY=${SECRET_KEY}\n`,
		);
	});

	it("closes through its own button and opens the app", async () => {
		await click(button("Open app"));

		expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith(
			"/dashboard/infra/a2",
		);
		expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
	});
});

describe("first run", () => {
	it("shows the secret key without asking for a click, and no public key", async () => {
		await stage.render(
			createElement(FirstRun, {
				organizations: [],
				proCredit: { status: "not_pro", nextDate: "2026-12-01T00:00:00Z" },
			}),
		);
		await createApp("Acme Player");

		const keys = [...document.querySelectorAll("details")].find((element) =>
			element.textContent?.includes("Secret key"),
		);
		expect(keys?.open).toBe(true);
		expect(text()).toContain("Copy as .env");
		expect(text()).not.toContain("Public key");
		expect(text()).not.toContain("cpk_");
	});
});

describe("the API keys page", () => {
	it("lists the secret key only", async () => {
		await stage.render(
			createElement(ApiKeysClient, {
				appId: "a1",
				secretKeyPrefix: "csk_abcd1234",
			}),
		);

		expect(text()).toContain("csk_abcd1234");
		expect(text()).toContain("It belongs on your server");
		expect(text()).not.toMatch(/public key/i);
		expect(text()).not.toContain("cpk_");
	});

	it("reveals only the new secret key after rotating", async () => {
		await stage.render(
			createElement(ApiKeysClient, {
				appId: "a1",
				secretKeyPrefix: "csk_abcd1234",
			}),
		);

		await click(button("Generate a new secret key"));
		await click(button("Generate new key"));
		await until(() => text().includes("Your new secret key"), "the new key");
		await click(button("Copy as .env"));

		expect(mocks.regenerate).toHaveBeenCalledExactlyOnceWith("a1");
		expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(
			`CAP_SECRET_KEY=${SECRET_KEY}\n`,
		);
		expect(text()).not.toMatch(/public key/i);
		expect(text()).not.toContain("cpk_");
	});
});
