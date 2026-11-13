import { MAX_UPLOAD_BYTES } from "@/lib/infra-upload";

export const IMPORT_MAX_IN_FLIGHT_PER_APP = 2;
export const IMPORT_MAX_PER_KEY_PER_HOUR = 30;
export const IMPORT_RATE_WINDOW_MS = 60 * 60 * 1000;
// A slot whose download never reported back (its function was killed) stops
// counting against the app after this long.
export const IMPORT_STALE_SLOT_MS = 20 * 60 * 1000;
// Under the 800 second ceiling of the function the download step runs in, so
// the step always gets to record the outcome itself.
export const IMPORT_TOTAL_TIMEOUT_MS = 12 * 60 * 1000;
export const IMPORT_STALL_TIMEOUT_MS = 30 * 1000;
export const IMPORT_PREFLIGHT_TIMEOUT_MS = 15 * 1000;
export const IMPORT_MAX_REDIRECTS = 3;
export const IMPORT_URL_MAX_LENGTH = 2_048;
export const IMPORT_MAX_BYTES = MAX_UPLOAD_BYTES;
export const IMPORT_PART_BYTES = 16 * 1024 * 1024;
