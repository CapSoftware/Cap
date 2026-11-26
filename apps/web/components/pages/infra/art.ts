export const ART_PATH = "/infra";

export const PLAIN = {
	horizon: 0.68,
	slabBase: 0.7349,
	slitTop: 0.5977,
	slab: { left: 0.3742, top: 0.497, right: 0.6258 },
	lit: { x: 0.47, y: 0.56, w: 0.06, h: 0.44 },
	placeholder:
		"data:image/webp;base64,UklGRlAAAABXRUJQVlA4IEQAAACwAwCdASogABAAPu1qrU8ppiQiMAgBMB2JZwABHoQQWxKGRah2AAD+/ZuLySEmHHFjwEf2wGqJEj3RcriqZwBjjFAAAA==",
} as const;

export const NIGHT = {
	ratio: "3200 / 960",
	placeholder:
		"data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAAAQAwCdASogAAoAPu1kqU2ppaQiMAgBMB2JaQAAetFYfmAA/vDt+/kb6gTtwAAA",
} as const;

export const PLATES = {
	ratio: "2800 / 1064",
	ratioSmall: "1582 / 924",
	placeholder:
		"data:image/webp;base64,UklGRkIAAABXRUJQVlA4IDYAAABwAwCdASogAAwAPu1krU6ppaSiMAgBMB2JaQAAetJ1f3rk4YAA/vD/WVh+UsktKTU885GRgAA=",
	rungs: [
		{ x: 0.7627, y: 0.29, sx: 0.7571, sy: 0.2581 },
		{ x: 0.7324, y: 0.4037, sx: 0.7033, sy: 0.3891 },
		{ x: 0.7031, y: 0.5131, sx: 0.6516, sy: 0.5151 },
		{ x: 0.675, y: 0.6185, sx: 0.6018, sy: 0.6365 },
		{ x: 0.6479, y: 0.72, sx: 0.5538, sy: 0.7534 },
	],
	leadTo: 0.805,
	leadToSmall: 0.83,
} as const;
