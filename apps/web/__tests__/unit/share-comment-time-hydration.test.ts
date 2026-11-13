// @vitest-environment jsdom

import { act, createElement, type ReactElement, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RelativeTime,
	ShareNowProvider,
} from "@/app/s/[videoId]/_components/RelativeTime";
import CommentComponent from "@/app/s/[videoId]/_components/tabs/Activity/Comment";
import { formatTimeAgo } from "@/app/s/[videoId]/_components/tabs/Activity/utils";
import { fromNow } from "@/app/s/[videoId]/_components/utils/from-now";
import type { CommentType } from "@/app/s/[videoId]/Share";

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => null,
}));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/LinkifiedText", () => ({
	LinkifiedText: ({ text }: { text: string }) => text,
}));
vi.mock("motion/react", () => ({
	motion: {
		div: ({
			children,
			className,
		}: {
			children: ReactNode;
			className?: string;
		}) => createElement("div", { className }, children),
	},
}));

const CREATED_AT = new Date("2026-11-13T12:00:00.000Z");
const SERVER_NOW = CREATED_AT.getTime() + 6 * 60_000;
const SKEWED_CLIENT_NOW = SERVER_NOW + 90 * 60_000;

const comment = {
	id: "c1",
	authorId: "u1",
	authorName: "Ada",
	authorImage: null,
	content: "Nice cut",
	type: "text",
	timestamp: null,
	parentCommentId: null,
	videoId: "v1",
	createdAt: CREATED_AT,
	updatedAt: CREATED_AT,
	sending: false,
} as unknown as CommentType;

const commentTree = (serverNow: number | null) => {
	const node = createElement(CommentComponent, {
		comment,
		replies: [],
		onReply: () => undefined,
		replyingToId: null,
		handleReply: async () => undefined,
		onCancelReply: () => undefined,
		onDelete: () => undefined,
	});
	return serverNow === null
		? node
		: createElement(ShareNowProvider, { now: serverNow }, node);
};

async function serverThenClient(
	tree: () => ReactElement,
	serverNow: number,
	clientNow: number,
) {
	vi.setSystemTime(serverNow);
	const html = renderToString(tree());
	const container = document.createElement("div");
	container.innerHTML = html;
	document.body.append(container);
	vi.setSystemTime(clientNow);
	const recoverableErrors: unknown[] = [];
	let root: ReturnType<typeof hydrateRoot> | undefined;
	await act(async () => {
		root = hydrateRoot(container, tree(), {
			onRecoverableError: (error) => recoverableErrors.push(error),
		});
	});
	return {
		html,
		container,
		recoverableErrors,
		unmount: () => act(() => root?.unmount()),
	};
}

const timeText = (root: ParentNode) => root.querySelector("time")?.textContent;

describe("share page relative times hydrate without a mismatch", () => {
	let cleanup: (() => void) | undefined;

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
		document.body.innerHTML = "";
		vi.useRealTimers();
	});

	it("reproduces the mismatch when the time is computed during render", async () => {
		const RenderTimeAgo = () =>
			createElement("p", null, formatTimeAgo(CREATED_AT));
		const result = await serverThenClient(
			() => createElement(RenderTimeAgo),
			SERVER_NOW,
			SKEWED_CLIENT_NOW,
		);
		cleanup = result.unmount;
		expect(String(result.recoverableErrors[0])).toMatch(
			/server rendered text didn't match the client/,
		);
	});

	it("hydrates a comment cleanly when the viewer's clock is 90 minutes off", async () => {
		const result = await serverThenClient(
			() => commentTree(SERVER_NOW),
			SERVER_NOW,
			SKEWED_CLIENT_NOW,
		);
		cleanup = result.unmount;
		expect(result.recoverableErrors).toEqual([]);
		expect(result.html).toContain(
			'<time dateTime="2026-11-13T12:00:00.000Z">6m ago</time>',
		);
		expect(timeText(result.container)).toBe("1h ago");
	});

	it("hydrates cleanly when a minute boundary falls between the renders", async () => {
		const serverNow = CREATED_AT.getTime() + 59_900;
		const result = await serverThenClient(
			() => commentTree(serverNow),
			serverNow,
			CREATED_AT.getTime() + 60_100,
		);
		cleanup = result.unmount;
		expect(result.recoverableErrors).toEqual([]);
		expect(result.html).toContain(">now</time>");
		expect(timeText(result.container)).toBe("1m ago");
	});

	it("keeps the header's fromNow wording and hydrates cleanly", async () => {
		const tree = () =>
			createElement(
				ShareNowProvider,
				{ now: SERVER_NOW },
				createElement(RelativeTime, { date: CREATED_AT, format: fromNow }),
			);
		const result = await serverThenClient(tree, SERVER_NOW, SKEWED_CLIENT_NOW);
		cleanup = result.unmount;
		expect(result.recoverableErrors).toEqual([]);
		expect(result.html).toContain(">6 minutes ago</time>");
		expect(timeText(result.container)).toBe("2 hours ago");
	});

	it("falls back to a fixed UTC date without a provider", async () => {
		const result = await serverThenClient(
			() => commentTree(null),
			SERVER_NOW,
			SKEWED_CLIENT_NOW,
		);
		cleanup = result.unmount;
		expect(result.recoverableErrors).toEqual([]);
		expect(result.html).toContain(">Nov 13, 2026</time>");
		expect(timeText(result.container)).toBe("1h ago");
	});

	it("renders an invalid date without throwing", () => {
		vi.setSystemTime(SERVER_NOW);
		const html = renderToString(
			createElement(RelativeTime, {
				date: new Date("not a date"),
				format: formatTimeAgo,
			}),
		);
		expect(html).toBe("<time></time>");
	});

	it("formats the same with an explicit now as with the clock", () => {
		vi.setSystemTime(SERVER_NOW);
		expect(formatTimeAgo(CREATED_AT, new Date(SERVER_NOW))).toBe(
			formatTimeAgo(CREATED_AT),
		);
	});
});
