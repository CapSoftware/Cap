import { createImageDataWS, type FrameData } from "~/utils/socket";

export function attachPreparingFrameTransport(options: {
	url: string;
	canvas: HTMLCanvasElement;
	retainedCanvas: HTMLCanvasElement;
	isActive: () => boolean;
	onRendered: (rendered: boolean) => void;
	onFrame?: (frame: FrameData) => void;
	onTerminal: () => void;
}) {
	let preservedFrame = false;
	const [socket, , , controls] = createImageDataWS(
		options.url,
		(frame) => {
			if (!options.isActive()) return;
			const rendered = controls.hasRenderedFrame();
			if (rendered && !preservedFrame) {
				preservedFrame = controls.drawLatestFrameToCanvas(
					options.retainedCanvas,
				);
			}
			options.onRendered(rendered);
			if (frame.renderedFrame) options.onFrame?.(frame);
		},
		undefined,
		{ retainLastFrameOnDispose: options.retainedCanvas },
	);
	controls.initDirectCanvas(options.canvas);
	const close = () => options.onTerminal();
	socket.addEventListener("close", close);
	socket.addEventListener("error", close);
	return {
		preserveFrame() {
			return (
				controls.drawLatestFrameToCanvas(options.retainedCanvas) ||
				preservedFrame
			);
		},
		dispose() {
			socket.removeEventListener("close", close);
			socket.removeEventListener("error", close);
			controls.dispose();
			socket.close();
		},
	};
}
