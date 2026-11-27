const target = process.env.TARGET ?? "chrome";

if (target !== "chrome" && target !== "firefox") {
	throw new Error(
		`Unknown extension TARGET "${target}", expected "chrome" or "firefox"`,
	);
}

export const targetDefine = { __TARGET__: JSON.stringify(target) };
