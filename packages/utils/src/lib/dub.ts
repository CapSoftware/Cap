export const dub = () => ({
	links: {
		create: (_input: { url: string; domain: string; key: string }) =>
			Promise.resolve(),
	},
});
