/* tslint:disable */
/* eslint-disable */
export function start(): void;
export function default_project_config_json(): string;
export function animated_gradient_catalog_json(): string;
export function random_animated_gradient_json(seed: number): string;
/**
 * Registers a font face for text, caption and keyboard overlays.
 */
export function register_font(data: Uint8Array): void;
/**
 * Registers an image the renderer reads by project path (backgrounds, image
 * overlays, cursor images).
 */
export function register_asset(path: string, data: Uint8Array): void;
/**
 * Registers straight RGBA the page decoded off the main thread.
 */
export function register_decoded_asset(path: string, width: number, height: number, pixels: Uint8Array): void;
export function has_asset(path: string): boolean;
export function remove_asset(path: string): void;
/**
 * Converts a browser recording's input-event NDJSON into native cursor
 * events and cursor metadata, exactly as the web export worker stages them,
 * and registers the stand-in cursor images the cursor layer may load.
 */
export function web_input_recording(ndjson: string): string;
export function webgl2_available(canvas: HTMLCanvasElement): boolean;
export class BrowserExportAudio {
  free(): void;
  constructor(config_json: string, total_frames: number);
  /**
   * Adds a decoded recording track. `offset_seconds` is where recording
   * time zero falls in the track (the preview's `audio_times` offset).
   */
  add_track(clip: number, microphone: boolean, channels: number, sample_rate: number, offset_seconds: number, samples: Float32Array): void;
  add_music(path: string, channels: number, sample_rate: number, samples: Float32Array): void;
  /**
   * Interleaved stereo 48 kHz samples; empty once the timeline is done.
   */
  next_chunk(frames: number): Float32Array;
}
export class BrowserRecordingTimes {
  free(): void;
  constructor(meta_json: string, clips_json: string);
  source_times(segment_index: number, source_time: number): Float64Array;
  audio_times(segment_index: number, source_time: number): Float64Array;
}
/**
 * Owns the native render core for one canvas. `frame_renderer` borrows
 * `constants`, so it is declared first and therefore dropped first.
 */
export class BrowserStudioRenderer {
  private constructor();
  free(): void;
  /**
   * `recording_meta_json` is a `RecordingMeta` for a studio recording and
   * `cursors_json` an array with one `CursorEvents` per recording clip.
   */
  static create(canvas: any, prefer_webgpu: boolean, recording_meta_json: string, screen_width: number, screen_height: number, camera_width: number, camera_height: number): Promise<BrowserStudioRenderer>;
  set_project(config_json: string): void;
  set_cursor(recording_clip: number, cursor_json: string): void;
  /**
   * Output size the next frame will have for a preview box.
   */
  output_size(resolution_width: number, resolution_height: number): Uint32Array;
  render(frame_number: number, fps: number, resolution_width: number, resolution_height: number, recording_clip: number, segment_time: number, screen: any, screen_color_fix: boolean, camera: any, camera_color_fix: boolean): Float64Array;
  render_transition(frame_number: number, fps: number, resolution_width: number, resolution_height: number, outgoing_clip: number, outgoing_time: number, outgoing_screen: any, outgoing_screen_color_fix: boolean, outgoing_camera: any, outgoing_camera_color_fix: boolean, incoming_clip: number, incoming_time: number, incoming_screen: any, incoming_screen_color_fix: boolean, incoming_camera: any, incoming_camera_color_fix: boolean, kind: number, progress: number): Float64Array;
  /**
   * Presents the last rendered frame again, so a canvas snapshot taken in
   * the same task sees it.
   */
  redraw_last(): boolean;
  snapshot_rgba(): Promise<Uint8Array>;
  /**
   * `[display x0, y0, x1, y1, camera x0, y0, x1, y1, output width, height]`
   * of the last frame; camera entries are NaN when it is hidden.
   */
  last_layout(): Float64Array;
  readonly backend: string;
  readonly max_texture_dimension: number;
}
export class BrowserTimeline {
  free(): void;
  constructor(timeline_json: string);
  /**
   * Output duration in seconds, as native export sizes its frame count.
   */
  duration(): number;
  map_frame(time: number): Float64Array;
}
export class BrowserVisualConfig {
  free(): void;
  constructor(config_json: string);
  /**
   * Output frame size for a preview box, identical to the native renderer's
   * `ProjectUniforms::get_output_size`.
   */
  output_dimensions(source_width: number, source_height: number, resolution_width: number, resolution_height: number): Uint32Array;
  aspect_locked(): boolean;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly log10: (a: number) => number;
  readonly sin: (a: number) => number;
  readonly cos: (a: number) => number;
  readonly __wbg_browserexportaudio_free: (a: number, b: number) => void;
  readonly browserexportaudio_new: (a: number, b: number, c: number) => [number, number, number];
  readonly browserexportaudio_add_track: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
  readonly browserexportaudio_add_music: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
  readonly browserexportaudio_next_chunk: (a: number, b: number) => [number, number];
  readonly start: () => void;
  readonly default_project_config_json: () => [number, number, number, number];
  readonly animated_gradient_catalog_json: () => [number, number, number, number];
  readonly random_animated_gradient_json: (a: number) => [number, number, number, number];
  readonly register_font: (a: number, b: number) => void;
  readonly register_asset: (a: number, b: number, c: number, d: number) => void;
  readonly register_decoded_asset: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly has_asset: (a: number, b: number) => number;
  readonly remove_asset: (a: number, b: number) => void;
  readonly web_input_recording: (a: number, b: number) => [number, number, number, number];
  readonly __wbg_browsertimeline_free: (a: number, b: number) => void;
  readonly browsertimeline_new: (a: number, b: number) => [number, number, number];
  readonly browsertimeline_duration: (a: number) => number;
  readonly browsertimeline_map_frame: (a: number, b: number) => [number, number];
  readonly __wbg_browserrecordingtimes_free: (a: number, b: number) => void;
  readonly browserrecordingtimes_new: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly browserrecordingtimes_source_times: (a: number, b: number, c: number) => [number, number];
  readonly browserrecordingtimes_audio_times: (a: number, b: number, c: number) => [number, number];
  readonly __wbg_browservisualconfig_free: (a: number, b: number) => void;
  readonly browservisualconfig_new: (a: number, b: number) => [number, number, number];
  readonly browservisualconfig_output_dimensions: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly browservisualconfig_aspect_locked: (a: number) => number;
  readonly __wbg_browserstudiorenderer_free: (a: number, b: number) => void;
  readonly browserstudiorenderer_create: (a: any, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
  readonly browserstudiorenderer_backend: (a: number) => [number, number];
  readonly browserstudiorenderer_max_texture_dimension: (a: number) => number;
  readonly browserstudiorenderer_set_project: (a: number, b: number, c: number) => [number, number];
  readonly browserstudiorenderer_set_cursor: (a: number, b: number, c: number, d: number) => [number, number];
  readonly browserstudiorenderer_output_size: (a: number, b: number, c: number) => [number, number];
  readonly browserstudiorenderer_render: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: any, i: number, j: any, k: number) => [number, number, number, number];
  readonly browserstudiorenderer_render_transition: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: any, i: number, j: any, k: number, l: number, m: number, n: any, o: number, p: any, q: number, r: number, s: number) => [number, number, number, number];
  readonly browserstudiorenderer_redraw_last: (a: number) => number;
  readonly browserstudiorenderer_snapshot_rgba: (a: number) => any;
  readonly browserstudiorenderer_last_layout: (a: number) => [number, number];
  readonly webgl2_available: (a: any) => number;
  readonly malloc: (a: number) => number;
  readonly calloc: (a: number, b: number) => number;
  readonly free: (a: number) => void;
  readonly realloc: (a: number, b: number) => number;
  readonly abs: (a: number) => number;
  readonly strcmp: (a: number, b: number) => number;
  readonly sqrt: (a: number) => number;
  readonly floor: (a: number) => number;
  readonly fopen: (a: number, b: number) => number;
  readonly fread: (a: number, b: number, c: number, d: number) => number;
  readonly fclose: (a: number) => number;
  readonly fseek: (a: number, b: number, c: number) => number;
  readonly ftell: (a: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_6: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly wasm_bindgen__convert__closures_____invoke__h9f7756242072ca73: (a: number, b: number) => void;
  readonly closure1634_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure1250_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure2706_externref_shim: (a: number, b: number, c: any, d: any) => void;
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
