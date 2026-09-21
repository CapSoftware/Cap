/* tslint:disable */
/* eslint-disable */
export function default_project_config_json(): string;
export function animated_gradient_catalog_json(): string;
export function random_animated_gradient_json(seed: number): string;
export function default_layer_uniforms(output_width: number, output_height: number, source_width: number, source_height: number, camera: boolean): Uint8Array;
export class BrowserGpuRenderer {
  private constructor();
  free(): void;
  static create(canvas: HTMLCanvasElement): Promise<BrowserGpuRenderer>;
  set_background(project_json: string): void;
  resize(width: number, height: number): void;
  render(screen_video: HTMLVideoElement, screen_uniforms: Uint8Array, camera_video?: HTMLVideoElement | null, camera_uniforms?: Uint8Array | null): void;
  render_transition(outgoing_screen: HTMLVideoElement, outgoing_screen_uniforms: Uint8Array, outgoing_camera: HTMLVideoElement | null | undefined, outgoing_camera_uniforms: Uint8Array | null | undefined, incoming_screen: HTMLVideoElement, incoming_screen_uniforms: Uint8Array, incoming_camera: HTMLVideoElement | null | undefined, incoming_camera_uniforms: Uint8Array | null | undefined, kind: number, progress: number): void;
  redraw_last(): boolean;
  snapshot_rgba(): Promise<Uint8Array>;
  readonly backend: string;
}
export class BrowserRecordingTimes {
  free(): void;
  constructor(meta_json: string, clips_json: string);
  source_times(segment_index: number, source_time: number): Float64Array;
  audio_times(segment_index: number, source_time: number): Float64Array;
}
export class BrowserTimeline {
  free(): void;
  constructor(timeline_json: string);
  map_frame(time: number): Float64Array;
}
export class BrowserVisualConfig {
  free(): void;
  constructor(config_json: string);
  output_dimensions(source_width: number, source_height: number, resolution_width: number, resolution_height: number): Uint32Array;
  layer_uniforms(output_width: number, output_height: number, source_width: number, source_height: number, camera: boolean, frame_number: number): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly default_project_config_json: () => [number, number, number, number];
  readonly animated_gradient_catalog_json: () => [number, number, number, number];
  readonly random_animated_gradient_json: (a: number) => [number, number, number, number];
  readonly __wbg_browsertimeline_free: (a: number, b: number) => void;
  readonly browsertimeline_new: (a: number, b: number) => [number, number, number];
  readonly browsertimeline_map_frame: (a: number, b: number) => [number, number];
  readonly __wbg_browserrecordingtimes_free: (a: number, b: number) => void;
  readonly browserrecordingtimes_new: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly browserrecordingtimes_source_times: (a: number, b: number, c: number) => [number, number];
  readonly browserrecordingtimes_audio_times: (a: number, b: number, c: number) => [number, number];
  readonly __wbg_browsergpurenderer_free: (a: number, b: number) => void;
  readonly browsergpurenderer_create: (a: any) => any;
  readonly browsergpurenderer_backend: (a: number) => [number, number];
  readonly browsergpurenderer_set_background: (a: number, b: number, c: number) => [number, number];
  readonly browsergpurenderer_resize: (a: number, b: number, c: number) => [number, number];
  readonly browsergpurenderer_render: (a: number, b: any, c: number, d: number, e: number, f: number, g: number) => [number, number];
  readonly browsergpurenderer_render_transition: (a: number, b: any, c: number, d: number, e: number, f: number, g: number, h: any, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number];
  readonly browsergpurenderer_redraw_last: (a: number) => [number, number, number];
  readonly browsergpurenderer_snapshot_rgba: (a: number) => any;
  readonly default_layer_uniforms: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly __wbg_browservisualconfig_free: (a: number, b: number) => void;
  readonly browservisualconfig_new: (a: number, b: number) => [number, number, number];
  readonly browservisualconfig_output_dimensions: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly browservisualconfig_layer_uniforms: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_6: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly closure375_externref_shim: (a: number, b: number, c: any) => void;
  readonly wasm_bindgen__convert__closures_____invoke__hc6057b1851fd52df: (a: number, b: number) => void;
  readonly closure1445_externref_shim: (a: number, b: number, c: any, d: any) => void;
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
