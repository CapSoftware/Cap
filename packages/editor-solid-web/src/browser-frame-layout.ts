import type { FrameLayoutEvent } from "../../../apps/desktop/src/utils/tauri";

function targetBounds(uniforms: Uint8Array): [number, number, number, number] {
	if (uniforms.byteLength < 32) {
		throw new Error("Editor layer layout is unavailable");
	}
	// CompositeVideoFrameUniforms is repr(C); target_bounds starts after two vec2 fields.
	const values = new DataView(uniforms.buffer, uniforms.byteOffset + 16, 16);
	return [
		values.getFloat32(0, true),
		values.getFloat32(4, true),
		values.getFloat32(8, true),
		values.getFloat32(12, true),
	];
}

export function browserFrameLayout(
	displayUniforms: Uint8Array,
	cameraUniforms: Uint8Array | null,
	width: number,
	height: number,
): FrameLayoutEvent {
	return {
		display: targetBounds(displayUniforms),
		camera: cameraUniforms ? targetBounds(cameraUniforms) : null,
		output_width: width,
		output_height: height,
	};
}
