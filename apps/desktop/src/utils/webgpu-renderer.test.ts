import { afterEach, describe, expect, it, vi } from "vitest";
import { initWebGPU, renderFrameWebGPU } from "./webgpu-renderer";

afterEach(() => vi.unstubAllGlobals());

describe("camera preview transparency", () => {
	it.each([false, true])(
		"preserves the canvas alpha contract through resize (%s)",
		async (preserveAlpha) => {
			const texture = { createView: vi.fn(() => ({})), destroy: vi.fn() };
			const pass = {
				setPipeline: vi.fn(),
				setBindGroup: vi.fn(),
				draw: vi.fn(),
				end: vi.fn(),
			};
			const device = {
				lost: new Promise(() => {}),
				createBindGroupLayout: vi.fn(() => ({})),
				createPipelineLayout: vi.fn(() => ({})),
				createShaderModule: vi.fn(() => ({})),
				createRenderPipeline: vi.fn(() => ({})),
				createSampler: vi.fn(() => ({})),
				createTexture: vi.fn(() => texture),
				createBindGroup: vi.fn(() => ({})),
				createCommandEncoder: vi.fn(() => ({
					beginRenderPass: () => pass,
					finish: () => ({}),
				})),
				queue: { writeTexture: vi.fn(), submit: vi.fn() },
			};
			vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
			vi.stubGlobal("GPUShaderStage", { FRAGMENT: 2 });
			vi.stubGlobal("navigator", {
				gpu: {
					requestAdapter: async () => ({ requestDevice: async () => device }),
					getPreferredCanvasFormat: () => "rgba8unorm",
				},
			});
			const context = {
				configure: vi.fn(),
				getCurrentTexture: () => texture,
			};
			const canvas = {
				width: 1,
				height: 1,
				getContext: () => context,
			} as unknown as OffscreenCanvas;
			const renderer = await initWebGPU(canvas, "low-power", preserveAlpha);
			renderFrameWebGPU(renderer, new Uint8ClampedArray(64 * 32 * 4), 64, 32);
			expect(context.configure).toHaveBeenCalledTimes(2);
			for (const [configuration] of context.configure.mock.calls) {
				expect(configuration.alphaMode).toBe(
					preserveAlpha ? "premultiplied" : "opaque",
				);
			}
			expect(pass.draw).toHaveBeenCalledTimes(1);
		},
	);
});

describe("failed WebGPU initialization", () => {
	it.each(["missing context", "context throws", "configuration", "pipeline"])(
		"releases the acquired device after %s failure",
		async (failure) => {
			const error = new Error(failure);
			const device = {
				lost: new Promise(() => {}),
				destroy: vi.fn(),
				createBindGroupLayout: vi.fn(() => {
					throw error;
				}),
			};
			vi.stubGlobal("GPUShaderStage", { FRAGMENT: 2 });
			vi.stubGlobal("navigator", {
				gpu: {
					requestAdapter: async () => ({ requestDevice: async () => device }),
					getPreferredCanvasFormat: () => "rgba8unorm",
				},
			});
			const canvas = {
				getContext: () => {
					if (failure === "missing context") return null;
					if (failure === "context throws") throw error;
					return {
						configure: () => {
							if (failure === "configuration") throw error;
						},
					};
				},
			} as unknown as OffscreenCanvas;
			await expect(initWebGPU(canvas)).rejects.toThrow(
				failure === "missing context" ? "Failed to get WebGPU context" : error,
			);
			expect(device.destroy).toHaveBeenCalledTimes(1);
		},
	);
});
