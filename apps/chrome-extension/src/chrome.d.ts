// Chrome API typings come from @types/chrome; this file only declares the
// Vite-specific module shapes the extension relies on.
interface ImportMeta {
	readonly env: {
		readonly MODE: string;
	};
}

declare module "*.css?inline" {
	const content: string;
	export default content;
}
