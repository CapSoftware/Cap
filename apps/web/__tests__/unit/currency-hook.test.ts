// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let useCurrency: typeof import("../../hooks/useCurrency").useCurrency;
let roots: Root[];
let containers: HTMLDivElement[];

function Price() {
	const { currency, symbol } = useCurrency();
	return createElement("output", null, `${currency}:${symbol}`);
}

async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	containers.push(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(createElement(Price)));
	return { container, root };
}

beforeEach(async () => {
	vi.resetModules();
	({ useCurrency } = await import("../../hooks/useCurrency"));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	roots = [];
	containers = [];
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	for (const container of containers) container.remove();
	vi.unstubAllGlobals();
});

it.each([429, 500])(
	"retries on the next mount after HTTP %s",
	async (status) => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ error: "Try later" }, { status }))
			.mockResolvedValueOnce(Response.json({ currency: "eur" }));
		vi.stubGlobal("fetch", fetcher);
		const first = await mount();
		expect(first.container.textContent).toBe("usd:$");
		const second = await mount();
		expect(second.container.textContent).toBe("eur:€");
		expect(fetcher).toHaveBeenCalledTimes(2);
	},
);

it.each([null, {}, { currency: "cad" }, { currency: 42 }])(
	"does not permanently cache a malformed success response: %j",
	async (body) => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json(body))
			.mockResolvedValueOnce(Response.json({ currency: "gbp" }));
		vi.stubGlobal("fetch", fetcher);
		const first = await mount();
		expect(first.container.textContent).toBe("usd:$");
		const second = await mount();
		expect(second.container.textContent).toBe("gbp:£");
		expect(fetcher).toHaveBeenCalledTimes(2);
	},
);

it("does not display a currency returned with an HTTP error", async () => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValue(Response.json({ currency: "eur" }, { status: 503 })),
	);
	expect((await mount()).container.textContent).toBe("usd:$");
});

it.each(["usd", "eur", "gbp"])(
	"shares and caches a successful %s lookup",
	async (currency) => {
		let resolve!: (value: Response) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((done) => {
					resolve = done;
				}),
		);
		vi.stubGlobal("fetch", fetcher);
		const first = await mount();
		const second = await mount();
		expect(fetcher).toHaveBeenCalledOnce();
		await act(async () => resolve(Response.json({ currency })));
		expect(first.container.textContent).toContain(`${currency}:`);
		expect(second.container.textContent).toBe(first.container.textContent);
		const third = await mount();
		expect(third.container.textContent).toBe(first.container.textContent);
		expect(fetcher).toHaveBeenCalledOnce();
	},
);

it("keeps a shared lookup alive when its first consumer unmounts", async () => {
	let resolve!: (value: Response) => void;
	const fetcher = vi.fn(
		() =>
			new Promise<Response>((done) => {
				resolve = done;
			}),
	);
	vi.stubGlobal("fetch", fetcher);
	const first = await mount();
	await act(async () => first.root.unmount());
	roots.shift();
	const second = await mount();
	await act(async () => resolve(Response.json({ currency: "eur" })));
	expect(second.container.textContent).toBe("eur:€");
	expect(fetcher).toHaveBeenCalledOnce();
});
