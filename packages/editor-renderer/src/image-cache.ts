type CachedImage = {
	img: HTMLImageElement;
	loaded: boolean;
};

export class ImageCache {
	private cache = new Map<string, CachedImage>();

	preload(url: string, onLoad?: () => void): void {
		const existing = this.cache.get(url);
		if (existing) {
			if (existing.loaded && onLoad) onLoad();
			return;
		}

		const img = new Image();
		img.crossOrigin = "anonymous";
		const entry: CachedImage = { img, loaded: false };
		this.cache.set(url, entry);

		img.onload = () => {
			entry.loaded = true;
			onLoad?.();
		};
		img.onerror = () => {
			this.cache.delete(url);
		};
		img.src = url;
	}

	get(url: string): HTMLImageElement | null {
		const entry = this.cache.get(url);
		if (entry?.loaded) return entry.img;
		return null;
	}

	clear(): void {
		this.cache.clear();
	}
}
