// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessengerWidget } from "@/app/Layout/MessengerWidget";
import { ChatWindow } from "@/app/messenger/[id]/ChatWindow";
import { MESSENGER_SUGGESTED_PROMPTS } from "@/lib/messenger/constants";

const actions = vi.hoisted(() => ({
	fetchMessengerConversation: vi.fn(),
	fetchMessengerConversations: vi.fn(),
	createMessengerConversation: vi.fn(),
	sendMessengerUserMessage: vi.fn(),
}));
vi.mock("@/actions/messenger", () => actions);
vi.mock("next/image", () => ({
	default: ({ src, alt }: { src: string; alt: string }) =>
		createElement("img", { src, alt }),
}));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) =>
		createElement("a", { href }, children),
}));

const conversation = { id: "chat", agent: "Support", mode: "agent" as const };
const data = (content?: string, role: "user" | "agent" = "agent") => ({
	conversation,
	messages: content
		? [{ id: content, role, content, createdAt: new Date().toISOString() }]
		: [],
});
type Data = ReturnType<typeof data>;
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

let root: Root | null;
let container: HTMLDivElement;
let polls: Map<number, () => void>;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("AudioContext", vi.fn());
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
	polls = new Map();
	let next = 0;
	vi.stubGlobal("setInterval", (callback: () => void) => {
		const id = ++next;
		polls.set(id, callback);
		return id;
	});
	vi.stubGlobal("clearInterval", (id: number) => polls.delete(id));
	actions.fetchMessengerConversations.mockResolvedValue([]);
	actions.createMessengerConversation.mockResolvedValue(conversation.id);
	actions.fetchMessengerConversation.mockReset().mockResolvedValue(data());
	actions.sendMessengerUserMessage.mockReset().mockResolvedValue(undefined);
	document.title = "Cap";
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	container.remove();
	Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	vi.unstubAllGlobals();
});

async function mount(kind: "page" | "widget") {
	await act(async () =>
		root?.render(
			kind === "page"
				? createElement(ChatWindow, { conversation, initialMessages: [] })
				: createElement(MessengerWidget),
		),
	);
	if (kind === "widget") {
		const open = container.querySelector<HTMLButtonElement>(
			"[aria-label='Open messenger']",
		);
		if (!open) throw new Error("Missing messenger button");
		await act(async () => open.click());
	}
	expect(polls.size).toBe(1);
	actions.fetchMessengerConversation.mockClear();
}
async function tick() {
	await act(async () => {
		for (const poll of polls.values()) poll();
	});
}
async function send() {
	const button = [...container.querySelectorAll("button")].find(
		(element) => element.textContent === MESSENGER_SUGGESTED_PROMPTS[0],
	);
	if (!button) throw new Error("Missing suggested prompt");
	await act(async () => button.click());
}

describe.each(["page", "widget"] as const)("%s polling ownership", (kind) => {
	it("retains the latest snapshot when older polls finish last", async () => {
		await mount(kind);
		const older = deferred<Data>();
		const newer = deferred<Data>();
		actions.fetchMessengerConversation
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise);
		await tick();
		await tick();
		await act(async () => newer.resolve(data("Newest reply")));
		expect(container.textContent).toContain("Newest reply");
		await act(async () => older.resolve(data("Old reply")));
		expect(container.textContent).toContain("Newest reply");
		expect(container.textContent).not.toContain("Old reply");
	});

	it("discards a pre-send poll even when it returns after sending completes", async () => {
		await mount(kind);
		const older = deferred<Data>();
		actions.fetchMessengerConversation
			.mockReturnValueOnce(older.promise)
			.mockResolvedValueOnce(data("Sent message", "user"));
		await tick();
		await send();
		expect(actions.sendMessengerUserMessage).toHaveBeenCalledOnce();
		expect(container.textContent).toContain("Sent message");
		await act(async () => older.resolve(data()));
		expect(container.textContent).toContain("Sent message");
	});

	it("does not apply an old snapshot after the newer poll fails, and can refresh again", async () => {
		await mount(kind);
		const older = deferred<Data>();
		const newer = deferred<Data>();
		actions.fetchMessengerConversation
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise)
			.mockResolvedValueOnce(data("Recovered reply"));
		await tick();
		await tick();
		await act(async () => newer.reject(new Error("Offline")));
		await act(async () => older.resolve(data("Superseded reply")));
		expect(container.textContent).not.toContain("Superseded reply");
		await tick();
		expect(container.textContent).toContain("Recovered reply");
	});

	it("keeps polling paused while a send is still pending", async () => {
		await mount(kind);
		const sending = deferred<void>();
		actions.sendMessengerUserMessage.mockReturnValueOnce(sending.promise);
		await send();
		await tick();
		expect(actions.fetchMessengerConversation).not.toHaveBeenCalled();
		await act(async () => sending.resolve());
		expect(actions.fetchMessengerConversation).toHaveBeenCalledOnce();
	});
});

it("does not replay a notification after a stale poll restores an older reply count", async () => {
	await mount("widget");
	vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	const older = deferred<Data>();
	const newer = deferred<Data>();
	actions.fetchMessengerConversation
		.mockReturnValueOnce(older.promise)
		.mockReturnValueOnce(newer.promise)
		.mockResolvedValueOnce(data("Newest reply"));
	await tick();
	await tick();
	await act(async () => newer.resolve(data("Newest reply")));
	expect(AudioContext).toHaveBeenCalledOnce();
	await act(async () => older.resolve(data()));
	await tick();
	expect(AudioContext).toHaveBeenCalledOnce();
});

it("does not notify or change the title when a widget poll finishes after unmount", async () => {
	await mount("widget");
	const pending = deferred<Data>();
	actions.fetchMessengerConversation.mockReturnValueOnce(pending.promise);
	await tick();
	await act(async () => root?.unmount());
	root = null;
	vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	await act(async () => pending.resolve(data("Late reply")));
	expect(document.title).toBe("Cap");
	expect(AudioContext).not.toHaveBeenCalled();
	expect(polls.size).toBe(0);
});
