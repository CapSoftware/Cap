/* tslint:disable */
/* eslint-disable */
export function decode_image(bytes: Uint8Array, max_dimension: number): DecodedImage;
export function decode_overlay_image(bytes: Uint8Array, max_dimension: number): DecodedOverlayImage;
export class DecodedImage {
  private constructor();
  free(): void;
  width(): number;
  height(): number;
  pixels(): Uint8Array;
}
export class DecodedOverlayImage {
  private constructor();
  free(): void;
  level_count(): number;
  level_width(index: number): number;
  level_height(index: number): number;
  take_level_pixels(index: number): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_decodedimage_free: (a: number, b: number) => void;
  readonly decodedimage_width: (a: number) => number;
  readonly decodedimage_height: (a: number) => number;
  readonly decodedimage_pixels: (a: number) => [number, number];
  readonly decode_image: (a: number, b: number, c: number) => [number, number, number];
  readonly __wbg_decodedoverlayimage_free: (a: number, b: number) => void;
  readonly decodedoverlayimage_level_count: (a: number) => number;
  readonly decodedoverlayimage_level_width: (a: number, b: number) => number;
  readonly decodedoverlayimage_level_height: (a: number, b: number) => number;
  readonly decodedoverlayimage_take_level_pixels: (a: number, b: number) => [number, number];
  readonly decode_overlay_image: (a: number, b: number, c: number) => [number, number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
