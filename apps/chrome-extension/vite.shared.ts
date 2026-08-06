// Shared between vite.config.ts, vite.content.config.ts and
// vite.content-overlay.config.ts so all three chunks of one target build
// agree on the output directory and the injected __TARGET__ constant.
export type BuildTarget = "chrome" | "firefox";

export const resolveTarget = (): BuildTarget => {
	const target = process.env.TARGET ?? "chrome";
	if (target !== "chrome" && target !== "firefox") {
		throw new Error(
			`Unknown TARGET "${target}" (expected "chrome" or "firefox")`,
		);
	}
	return target;
};

export const outDirFor = (target: BuildTarget) => `dist/${target}`;

export const targetDefine = (target: BuildTarget) => ({
	__TARGET__: JSON.stringify(target),
});
