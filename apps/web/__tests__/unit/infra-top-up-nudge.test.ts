import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ query: "" }));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(navigation.query),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { TopUp } from "@/app/(infra)/dashboard/infra/[appId]/billing/top-up";

const NUDGE =
	"to add credit as soon as the balance falls below a threshold you set.";

const render = (autoTopUpHref: string | null) =>
	renderToStaticMarkup(createElement(TopUp, { appId: "app-1", autoTopUpHref }));

describe("the nudge after a purchase", () => {
	beforeEach(() => {
		navigation.query = "";
	});

	it("points to auto top-up after a purchase while it is off", () => {
		navigation.query = "purchase=success";
		const html = render("#auto-top-up");

		expect(html).toContain(NUDGE);
		expect(html).toContain('href="#auto-top-up"');
	});

	it("stays out of the way before a purchase and when auto top-up is on", () => {
		expect(render("#auto-top-up")).not.toContain(NUDGE);
		navigation.query = "purchase=success";
		expect(render(null)).not.toContain(NUDGE);
	});
});
