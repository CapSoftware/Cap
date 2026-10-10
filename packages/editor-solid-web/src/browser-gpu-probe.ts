let pending: Promise<boolean> | null = null;

async function inspectCanvas(canvas: HTMLCanvasElement) {
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, "image/png"),
	);
	if (!blob) return false;
	const bitmap = await createImageBitmap(blob);
	try {
		const sample = document.createElement("canvas");
		sample.width = bitmap.width;
		sample.height = bitmap.height;
		const context = sample.getContext("2d", { willReadFrequently: true });
		if (!context) return false;
		context.drawImage(bitmap, 0, 0);
		const pixel = context.getImageData(4, 4, 1, 1).data;
		return pixel[0] > 224 && pixel[1] > 224 && pixel[2] > 224;
	} finally {
		bitmap.close();
	}
}

async function probeWebGpuCanvas() {
	if (!navigator.gpu) return false;
	const adapter = await navigator.gpu.requestAdapter({
		powerPreference: "high-performance",
	});
	if (!adapter) return false;
	if (adapter.info?.architecture?.toLowerCase() === "swiftshader") return false;
	const device = await adapter.requestDevice();
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 8;
		canvas.height = 8;
		const context = canvas.getContext("webgpu");
		if (!context) return false;
		context.configure({
			device,
			format: navigator.gpu.getPreferredCanvasFormat(),
			alphaMode: "opaque",
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: context.getCurrentTexture().createView(),
					clearValue: { r: 1, g: 1, b: 1, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.end();
		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		return await inspectCanvas(canvas);
	} finally {
		device.destroy();
	}
}

export function browserWebGpuPresentationWorks() {
	if (!pending) {
		pending = new Promise<boolean>((resolve) => {
			const timeout = window.setTimeout(() => resolve(false), 1500);
			void probeWebGpuCanvas()
				.catch(() => false)
				.then((works) => {
					window.clearTimeout(timeout);
					resolve(works);
				});
		});
	}
	return pending;
}
