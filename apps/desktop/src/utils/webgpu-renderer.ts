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

const NV12_FRAGMENT_SHADER = `
@group(0) @binding(0) var frameSampler: sampler;
@group(0) @binding(1) var yTexture: texture_2d<f32>;
@group(0) @binding(2) var uvTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) texCoord: vec2f) -> @location(0) vec4f {
	let y = textureSample(yTexture, frameSampler, texCoord).r;
	let uv = textureSample(uvTexture, frameSampler, texCoord).rg;
	
	let yScaled = y - 0.0625;
	let u = uv.r - 0.5;
	let v = uv.g - 0.5;
	
	let r = clamp(1.164 * yScaled + 1.596 * v, 0.0, 1.0);
	let g = clamp(1.164 * yScaled - 0.391 * u - 0.813 * v, 0.0, 1.0);
	let b = clamp(1.164 * yScaled + 2.018 * u, 0.0, 1.0);
	
	return vec4f(r, g, b, 1.0);
}
`;

const NV12_FULL_FRAGMENT_SHADER = `
@group(0) @binding(0) var frameSampler: sampler;
@group(0) @binding(1) var yTexture: texture_2d<f32>;
@group(0) @binding(2) var uvTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) texCoord: vec2f) -> @location(0) vec4f {
	let y = textureSample(yTexture, frameSampler, texCoord).r;
	let uv = textureSample(uvTexture, frameSampler, texCoord).rg;

	let u = uv.r - 0.5;
	let v = uv.g - 0.5;

	let r = clamp(y + 1.402 * v, 0.0, 1.0);
	let g = clamp(y - 0.344136 * u - 0.714136 * v, 0.0, 1.0);
	let b = clamp(y + 1.772 * u, 0.0, 1.0);

	return vec4f(r, g, b, 1.0);
}
`;

export interface WebGPURenderer {
	device: GPUDevice;
	context: GPUCanvasContext;
	pipeline: GPURenderPipeline;
	nv12Pipeline: GPURenderPipeline;
	nv12FullPipeline: GPURenderPipeline;
	sampler: GPUSampler;
	frameTexture: GPUTexture | null;
	bindGroup: GPUBindGroup | null;
	bindGroupLayout: GPUBindGroupLayout;
	nv12BindGroupLayout: GPUBindGroupLayout;
	yTexture: GPUTexture | null;
	uvTexture: GPUTexture | null;
	nv12BindGroup: GPUBindGroup | null;
	cachedWidth: number;
	cachedHeight: number;
	cachedNv12Width: number;
	cachedNv12Height: number;
	canvas: OffscreenCanvas;
}

export interface WebGPURenderTiming {
	resizeMs: number;
	textureSetupMs: number;
	uploadMs: number;
	drawMs: number;
	totalMs: number;
}

function createEmptyTiming(start: number): WebGPURenderTiming {
	return {
		resizeMs: 0,
		textureSetupMs: 0,
		uploadMs: 0,
		drawMs: 0,
		totalMs: performance.now() - start,
	};
}

async function requestWebGPUAdapter(
	powerPreference: GPUPowerPreference = "high-performance",
): Promise<GPUAdapter | null> {
	let preferredAdapter: GPUAdapter | null = null;
	try {
		preferredAdapter = await navigator.gpu.requestAdapter({
			powerPreference,
		});
	} catch {}
	return preferredAdapter ?? navigator.gpu.requestAdapter();
}

export async function isWebGPUSupported(
	powerPreference: GPUPowerPreference = "high-performance",
): Promise<boolean> {
	if (typeof navigator === "undefined" || !navigator.gpu) {
		return false;
	}
	try {
		const adapter = await requestWebGPUAdapter(powerPreference);
		return adapter !== null;
	} catch {
		return false;
	}
}

export async function initWebGPU(
	canvas: OffscreenCanvas,
	powerPreference: GPUPowerPreference = "high-performance",
): Promise<WebGPURenderer> {
	const adapter = await requestWebGPUAdapter(powerPreference);
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

	const nv12BindGroupLayout = device.createBindGroupLayout({
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
			{
				binding: 2,
				visibility: GPUShaderStage.FRAGMENT,
				texture: { sampleType: "float" },
			},
		],
	});

	const pipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [bindGroupLayout],
	});

	const nv12PipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [nv12BindGroupLayout],
	});

	const vertexModule = device.createShaderModule({ code: VERTEX_SHADER });
	const fragmentModule = device.createShaderModule({ code: FRAGMENT_SHADER });
	const nv12FragmentModule = device.createShaderModule({
		code: NV12_FRAGMENT_SHADER,
	});
	const nv12FullFragmentModule = device.createShaderModule({
		code: NV12_FULL_FRAGMENT_SHADER,
	});

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

	const nv12Pipeline = device.createRenderPipeline({
		layout: nv12PipelineLayout,
		vertex: {
			module: vertexModule,
			entryPoint: "vs",
		},
		fragment: {
			module: nv12FragmentModule,
			entryPoint: "fs",
			targets: [{ format }],
		},
		primitive: {
			topology: "triangle-list",
		},
	});

	const nv12FullPipeline = device.createRenderPipeline({
		layout: nv12PipelineLayout,
		vertex: {
			module: vertexModule,
			entryPoint: "vs",
		},
		fragment: {
			module: nv12FullFragmentModule,
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
		nv12Pipeline,
		nv12FullPipeline,
		sampler,
		frameTexture: null,
		bindGroup: null,
		bindGroupLayout,
		nv12BindGroupLayout,
		yTexture: null,
		uvTexture: null,
		nv12BindGroup: null,
		cachedWidth: 0,
		cachedHeight: 0,
		cachedNv12Width: 0,
		cachedNv12Height: 0,
		canvas,
	};
}

export function renderFrameWebGPU(
	renderer: WebGPURenderer,
	data: Uint8ClampedArray,
	width: number,
	height: number,
	bytesPerRow: number = width * 4,
): WebGPURenderTiming {
	const totalStart = performance.now();
	let resizeMs = 0;
	let textureSetupMs = 0;
	let uploadMs = 0;
	let drawMs = 0;
	const { device, context, pipeline, sampler, bindGroupLayout, canvas } =
		renderer;

	if (canvas.width !== width || canvas.height !== height) {
		const start = performance.now();
		canvas.width = width;
		canvas.height = height;
		const format = navigator.gpu.getPreferredCanvasFormat();
		context.configure({
			device,
			format,
			alphaMode: "opaque",
		});
		resizeMs = performance.now() - start;
	}

	if (renderer.cachedWidth !== width || renderer.cachedHeight !== height) {
		const start = performance.now();
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
		textureSetupMs = performance.now() - start;
	}

	if (!renderer.frameTexture || !renderer.bindGroup) {
		return createEmptyTiming(totalStart);
	}

	const requiredBytes = bytesPerRow * height;
	if (data.byteLength < requiredBytes) {
		console.error(
			`WebGPU renderFrame: buffer too small. Expected at least ${requiredBytes} bytes, got ${data.byteLength}`,
		);
		return createEmptyTiming(totalStart);
	}

	const textureData =
		data.byteLength > requiredBytes ? data.subarray(0, requiredBytes) : data;

	const uploadStart = performance.now();
	device.queue.writeTexture(
		{ texture: renderer.frameTexture },
		textureData.buffer as unknown as GPUAllowSharedBufferSource,
		{ offset: textureData.byteOffset, bytesPerRow, rowsPerImage: height },
		{ width, height },
	);
	uploadMs = performance.now() - uploadStart;

	const drawStart = performance.now();
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
	drawMs = performance.now() - drawStart;

	return {
		resizeMs,
		textureSetupMs,
		uploadMs,
		drawMs,
		totalMs: performance.now() - totalStart,
	};
}

export function renderNv12FrameWebGPU(
	renderer: WebGPURenderer,
	data: Uint8ClampedArray,
	width: number,
	height: number,
	yStride: number,
	fullRange = false,
): WebGPURenderTiming {
	const totalStart = performance.now();
	let resizeMs = 0;
	let textureSetupMs = 0;
	let uploadMs = 0;
	let drawMs = 0;
	const {
		device,
		context,
		nv12Pipeline,
		nv12FullPipeline,
		sampler,
		nv12BindGroupLayout,
		canvas,
	} = renderer;

	if (canvas.width !== width || canvas.height !== height) {
		const start = performance.now();
		canvas.width = width;
		canvas.height = height;
		const format = navigator.gpu.getPreferredCanvasFormat();
		context.configure({
			device,
			format,
			alphaMode: "opaque",
		});
		resizeMs = performance.now() - start;
	}

	if (
		renderer.cachedNv12Width !== width ||
		renderer.cachedNv12Height !== height
	) {
		const start = performance.now();
		renderer.yTexture?.destroy();
		renderer.uvTexture?.destroy();

		renderer.yTexture = device.createTexture({
			size: { width, height },
			format: "r8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});

		renderer.uvTexture = device.createTexture({
			size: { width: width / 2, height: height / 2 },
			format: "rg8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});

		renderer.nv12BindGroup = device.createBindGroup({
			layout: nv12BindGroupLayout,
			entries: [
				{ binding: 0, resource: sampler },
				{ binding: 1, resource: renderer.yTexture.createView() },
				{ binding: 2, resource: renderer.uvTexture.createView() },
			],
		});

		renderer.cachedNv12Width = width;
		renderer.cachedNv12Height = height;
		textureSetupMs = performance.now() - start;
	}

	if (!renderer.yTexture || !renderer.uvTexture || !renderer.nv12BindGroup) {
		return createEmptyTiming(totalStart);
	}

	const ySize = yStride * height;
	const uvWidth = width / 2;
	const uvHeight = height / 2;
	const uvStride = yStride;
	const uvSize = uvStride * uvHeight;

	if (data.byteLength < ySize + uvSize) {
		return createEmptyTiming(totalStart);
	}

	const yData = data.subarray(0, ySize);
	const uvData = data.subarray(ySize, ySize + uvSize);

	const uploadStart = performance.now();
	device.queue.writeTexture(
		{ texture: renderer.yTexture },
		yData.buffer as unknown as GPUAllowSharedBufferSource,
		{ bytesPerRow: yStride, rowsPerImage: height, offset: yData.byteOffset },
		{ width, height },
	);

	device.queue.writeTexture(
		{ texture: renderer.uvTexture },
		uvData.buffer as unknown as GPUAllowSharedBufferSource,
		{
			bytesPerRow: uvStride,
			rowsPerImage: uvHeight,
			offset: uvData.byteOffset,
		},
		{ width: uvWidth, height: uvHeight },
	);
	uploadMs = performance.now() - uploadStart;

	const drawStart = performance.now();
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginRenderPass({
		colorAttachments: [
			{
				view: context.getCurrentTexture().createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 1 },
				loadOp: "clear",
				storeOp: "store",
			},
		],
	});

	pass.setPipeline(fullRange ? nv12FullPipeline : nv12Pipeline);
	pass.setBindGroup(0, renderer.nv12BindGroup);
	pass.draw(3);
	pass.end();

	device.queue.submit([encoder.finish()]);
	drawMs = performance.now() - drawStart;

	return {
		resizeMs,
		textureSetupMs,
		uploadMs,
		drawMs,
		totalMs: performance.now() - totalStart,
	};
}

export function disposeWebGPU(renderer: WebGPURenderer): void {
	renderer.frameTexture?.destroy();
	renderer.frameTexture = null;
	renderer.bindGroup = null;
	renderer.yTexture?.destroy();
	renderer.yTexture = null;
	renderer.uvTexture?.destroy();
	renderer.uvTexture = null;
	renderer.nv12BindGroup = null;
	renderer.device.destroy();
}
