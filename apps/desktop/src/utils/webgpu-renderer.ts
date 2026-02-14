const VERTEX_SHADER = `
struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) texCoord: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOutput {
	var positions = array<vec2f, 3>(
		vec2f(-1.0, -1.0),
		vec2f(3.0, -1.0),
		vec2f(-1.0, 3.0)
	);
	var texCoords = array<vec2f, 3>(
		vec2f(0.0, 1.0),
		vec2f(2.0, 1.0),
		vec2f(0.0, -1.0)
	);
	var output: VertexOutput;
	output.position = vec4f(positions[vi], 0.0, 1.0);
	output.texCoord = texCoords[vi];
	return output;
}
`;

const FRAGMENT_SHADER = `
@group(0) @binding(0) var frameSampler: sampler;
@group(0) @binding(1) var frameTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) texCoord: vec2f) -> @location(0) vec4f {
	let sampled = textureSample(frameTexture, frameSampler, texCoord);
	return vec4f(sampled.r, sampled.g, sampled.b, 1.0);
}
`;

export interface WebGPURenderer {
	device: GPUDevice;
	context: GPUCanvasContext;
	pipeline: GPURenderPipeline;
	sampler: GPUSampler;
	frameTexture: GPUTexture | null;
	bindGroup: GPUBindGroup | null;
	bindGroupLayout: GPUBindGroupLayout;
	cachedWidth: number;
	cachedHeight: number;
	canvas: OffscreenCanvas;
}

export async function isWebGPUSupported(): Promise<boolean> {
	if (typeof navigator === "undefined" || !navigator.gpu) {
		return false;
	}
	try {
		const adapter = await navigator.gpu.requestAdapter();
		return adapter !== null;
	} catch {
		return false;
	}
}

export async function initWebGPU(
	canvas: OffscreenCanvas,
): Promise<WebGPURenderer> {
	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) {
		throw new Error("No WebGPU adapter available");
	}

	const device = await adapter.requestDevice();

	device.lost.then((info) => {
		if (info.reason !== "destroyed") {
			self.postMessage({
				type: "error",
				message: `WebGPU device lost: ${info.reason} - ${info.message}`,
			});
		}
	});

	const context = canvas.getContext("webgpu");
	if (!context) {
		throw new Error("Failed to get WebGPU context from OffscreenCanvas");
	}

	const format = navigator.gpu.getPreferredCanvasFormat();
	context.configure({
		device,
		format,
		alphaMode: "opaque",
	});

	const bindGroupLayout = device.createBindGroupLayout({
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.FRAGMENT,
				sampler: { type: "filtering" },
			},
			{
				binding: 1,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: "float" },
			},
		],
	});

	const pipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [bindGroupLayout],
	});

	const vertexModule = device.createShaderModule({ code: VERTEX_SHADER });
	const fragmentModule = device.createShaderModule({ code: FRAGMENT_SHADER });

	const pipeline = device.createRenderPipeline({
		layout: pipelineLayout,
		vertex: {
			module: vertexModule,
			entryPoint: "vs",
		},
		fragment: {
			module: fragmentModule,
			entryPoint: "fs",
			targets: [{ format }],
		},
		primitive: {
			topology: "triangle-list",
		},
	});

	const sampler = device.createSampler({
		magFilter: "linear",
		minFilter: "linear",
		addressModeU: "clamp-to-edge",
		addressModeV: "clamp-to-edge",
	});

	return {
		device,
		context,
		pipeline,
		sampler,
		frameTexture: null,
		bindGroup: null,
		bindGroupLayout,
		cachedWidth: 0,
		cachedHeight: 0,
		canvas,
	};
}

export function renderFrameWebGPU(
	renderer: WebGPURenderer,
	data: Uint8ClampedArray,
	width: number,
	height: number,
	bytesPerRow: number = width * 4,
): void {
	const { device, context, pipeline, sampler, bindGroupLayout, canvas } =
		renderer;

	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
		const format = navigator.gpu.getPreferredCanvasFormat();
		context.configure({
			device,
			format,
			alphaMode: "opaque",
		});
	}

	if (renderer.cachedWidth !== width || renderer.cachedHeight !== height) {
		renderer.frameTexture?.destroy();
		renderer.frameTexture = device.createTexture({
			size: { width, height },
			format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		renderer.bindGroup = device.createBindGroup({
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: sampler },
				{ binding: 1, resource: renderer.frameTexture.createView() },
			],
		});
		renderer.cachedWidth = width;
		renderer.cachedHeight = height;
	}

	if (!renderer.frameTexture || !renderer.bindGroup) {
		return;
	}

	const requiredBytes = bytesPerRow * height;
	if (data.byteLength < requiredBytes) {
		console.error(
			`WebGPU renderFrame: buffer too small. Expected at least ${requiredBytes} bytes, got ${data.byteLength}`,
		);
		return;
	}

	const textureData =
		data.byteLength > requiredBytes ? data.subarray(0, requiredBytes) : data;

	device.queue.writeTexture(
		{ texture: renderer.frameTexture },
		textureData.buffer as unknown as GPUAllowSharedBufferSource,
		{ offset: textureData.byteOffset, bytesPerRow, rowsPerImage: height },
		{ width, height },
	);

	const encoder = device.createCommandEncoder();
	const currentTexture = context.getCurrentTexture();
	const pass = encoder.beginRenderPass({
		colorAttachments: [
			{
				view: currentTexture.createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 1 },
				loadOp: "clear",
				storeOp: "store",
			},
		],
	});

	pass.setPipeline(pipeline);
	pass.setBindGroup(0, renderer.bindGroup);
	pass.draw(3);
	pass.end();

	device.queue.submit([encoder.finish()]);
}

export function disposeWebGPU(renderer: WebGPURenderer): void {
	renderer.frameTexture?.destroy();
	renderer.frameTexture = null;
	renderer.bindGroup = null;
	renderer.device.destroy();
}
