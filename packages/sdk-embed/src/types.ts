export interface EmbedOptions {
	videoId: string;
	publicKey: string;
	apiBase?: string;
	autoplay?: boolean;
	branding?: {
		logoUrl?: string;
		accentColor?: string;
	};
}
