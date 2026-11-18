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
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) =>
		createElement("a", { href }, children),
}));

const conversation = { id: "chat", agent: "Support", mode: "agent" as const };
const snapshot = (...replies: string[]) => ({
	conversation,
	messages: replies.map((content) => ({
		id: content,
		role: "agent" as const,
		content,
		createdAt: new Date(0).toISOString(),
	})),
});

let root: Root;
let container: HTMLDivElement;
let hidden: boolean;

const polls = () => actions.fetchMessengerConversation.mock.calls.length;

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

async function setHidden(value: boolean) {
	hidden = value;
	await act(async () => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

async function countPollsOver(ms: number, step = 1000) {
	const before = polls();
	for (let elapsed = 0; elapsed < ms; elapsed += step) await advance(step);
	return polls() - before;
}

async function mount(kind: "page" | "widget") {
	await act(async () =>
		root.render(
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
	expect(container.querySelector("textarea")).not.toBeNull();
	actions.fetchMessengerConversation.mockClear();
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	hidden = false;
	vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("AudioContext", vi.fn());
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
	actions.fetchMessengerConversations.mockResolvedValue([]);
	actions.createMessengerConversation.mockResolvedValue(conversation.id);
	actions.fetchMessengerConversation.mockReset().mockResolvedValue(snapshot());
	actions.sendMessengerUserMessage
		.mockReset()
		.mockResolvedValue({ mode: "agent" });
	document.title = "Cap";
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe.each(["page", "widget"] as const)("%s poll cadence", (kind) => {
	it("slows down step by step while nothing changes", async () => {
		await mount(kind);
		const firstPolls: number[] = [];
		let elapsed = 0;
		while (firstPolls.length < 6 && elapsed < 300_000) {
			const before = polls();
			await advance(1000);
			elapsed += 1000;
			if (polls() > before) firstPolls.push(elapsed);
		}
		expect(firstPolls).toEqual([3000, 9000, 21000, 51000, 111000, 171000]);
		expect(await countPollsOver(10 * 60_000)).toBe(10);
	});

	it("goes back to 3 s when a new reply arrives", async () => {
		await mount(kind);
		await countPollsOver(120_000);
		actions.fetchMessengerConversation.mockResolvedValue(
			snapshot("A reply from the team"),
		);
		const beforeReply = polls();
		while (polls() === beforeReply) await advance(1000);
		expect(container.textContent).toContain("A reply from the team");
		const before = polls();
		await advance(3000);
		expect(polls()).toBe(before + 1);
	});

	it("goes back to 3 s after the user sends a message", async () => {
		await mount(kind);
		await countPollsOver(120_000);
		const prompt = [...container.querySelectorAll("button")].find(
			(element) => element.textContent === MESSENGER_SUGGESTED_PROMPTS[0],
		);
		if (!prompt) throw new Error("Missing suggested prompt");
		actions.fetchMessengerConversation.mockResolvedValue(snapshot("Answer"));
		await act(async () => prompt.click());
		expect(actions.sendMessengerUserMessage).toHaveBeenCalledOnce();
		const before = polls();
		await advance(3000);
		expect(polls()).toBe(before + 1);
	});

	it("fetches right away when the tab becomes visible again", async () => {
		await mount(kind);
		await countPollsOver(120_000);
		await setHidden(true);
		await advance(30_000);
		const before = polls();
		await setHidden(false);
		expect(polls()).toBe(before + 1);
	});
});

it("stops polling the full page chat while the tab is hidden", async () => {
	await mount("page");
	await setHidden(true);
	expect(await countPollsOver(10 * 60_000)).toBe(0);
});

it("keeps a once a minute poll in a hidden widget so new reply alerts still work", async () => {
	await mount("widget");
	await setHidden(true);
	expect(await countPollsOver(10 * 60_000)).toBe(10);
	actions.fetchMessengerConversation.mockResolvedValue(
		snapshot("Reply while away"),
	);
	await advance(60_000);
	expect(document.title).toMatch(/^New Reply/);
	expect(AudioContext).toHaveBeenCalledOnce();
});

it("does not poll once the widget panel is closed", async () => {
	await mount("widget");
	const close = container.querySelector<HTMLButtonElement>(
		"[aria-label='Close messenger']",
	);
	if (!close) throw new Error("Missing close button");
	await act(async () => close.click());
	await advance(1000);
	expect(container.querySelector("textarea")).toBeNull();
	const before = polls();
	await countPollsOver(10 * 60_000);
	expect(polls()).toBe(before);
});
