/* This file is required to use gif.js in the browser. 
   It's quite an antiquated library so doesn't have built in types, but it's reliable for GIF generation.
   This is not an AI comment just an observation by me on the need for this file :D 
*/

declare module "gif.js" {
	interface GIFOptions {
		workers?: number;
		quality?: number;
		width?: number;
		height?: number;
		workerScript?: string;
		repeat?: number;
		transparent?: string | number[];
		background?: string | number[];
		dither?: boolean;
	}

	interface GIFFrameOptions {
		delay?: number;
		copy?: boolean;
		dispose?: number;
	}

	export default class GIF {
		constructor(options: GIFOptions);
		addFrame(
			imageElement: CanvasImageSource | HTMLCanvasElement,
			options?: GIFFrameOptions,
		): void;
		on(event: "finished", callback: (blob: Blob) => void): void;
		on(event: "progress", callback: (progress: number) => void): void;
		on(event: string, callback: (...args: any[]) => void): void;
		render(): void;
		abort(): void;
	}
}
