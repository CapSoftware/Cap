if (
	!("innerText" in HTMLElement.prototype) ||
	document.createElement("b").innerText === undefined
)
	Object.defineProperty(HTMLElement.prototype, "innerText", {
		get(this: HTMLElement) {
			return this.textContent ?? "";
		},
		configurable: true,
	});

const css = globalThis as unknown as {
	CSS?: { escape?: (value: string) => string };
};
if (!css.CSS?.escape)
	css.CSS = {
		...css.CSS,
		escape: (value: string) =>
			value.replace(/[^\w-]/g, (character) => `\\${character}`),
	};
