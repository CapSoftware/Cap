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

export interface WebGPURenderer {
	device: GPUDevice;
	context: GPUCanvasContext;
	pipeline: GPURenderPipeline;
	nv12Pipeline: GPURenderPipeline;
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

export async function isWebGPUSupported(): Promise<boolean> {
	if (typeof navigator === "undefined" || !navigator.gpu) {
		return false;
	}
	try {
		const adapter = await navigator.gpu.requestAdapter({
			powerPreference: "high-performance",
		});
		return adapter !== null;
	} catch {
		return false;
	}
}

export async function initWebGPU(
	canvas: OffscreenCanvas,
): Promise<WebGPURenderer> {
	const adapter = await navigator.gpu.requestAdapter({
		powerPreference: "high-performance",
	});
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

export function renderNv12FrameWebGPU(
	renderer: WebGPURenderer,
	data: Uint8ClampedArray,
	width: number,
	height: number,
	yStride: number,
): void {
	const {
		device,
		context,
		nv12Pipeline,
		sampler,
		nv12BindGroupLayout,
		canvas,
	} = renderer;

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

	if (
		renderer.cachedNv12Width !== width ||
		renderer.cachedNv12Height !== height
	) {
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
	}

	if (!renderer.yTexture || !renderer.uvTexture || !renderer.nv12BindGroup) {
		return;
	}

	const ySize = yStride * height;
	const uvWidth = width / 2;
	const uvHeight = height / 2;
	const uvStride = yStride;
	const uvSize = uvStride * uvHeight;

	if (data.byteLength < ySize + uvSize) {
		return;
	}

	const yData = data.subarray(0, ySize);
	const uvData = data.subarray(ySize, ySize + uvSize);

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

	pass.setPipeline(nv12Pipeline);
	pass.setBindGroup(0, renderer.nv12BindGroup);
	pass.draw(3);
	pass.end();

	device.queue.submit([encoder.finish()]);
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
