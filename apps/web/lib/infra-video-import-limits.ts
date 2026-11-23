import { MAX_UPLOAD_BYTES } from "@/lib/infra-upload";

export const IMPORT_MAX_IN_FLIGHT_PER_APP = 2;
export const IMPORT_MAX_PER_KEY_PER_HOUR = 30;
export const IMPORT_RATE_WINDOW_MS = 60 * 60 * 1000;
// A slot whose download never reported back (its function was killed) stops
// counting against the app after this long.
export const IMPORT_STALE_SLOT_MS = 20 * 60 * 1000;
// The download step runs in the workflow step function, which Vercel stops at
// 800 seconds. The download deadline leaves room for opening the source,
// completing the multipart upload, and recording a failure.
export const IMPORT_STEP_MAX_DURATION_MS = 800 * 1000;
export const IMPORT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
// A step re-run is allowed to start up to a minute after the first run's
// deadline and then gets a full deadline of its own. An import still
// downloading after both, plus completion time, lost its function (out of
// memory, a crash) and is failed by the purge cron.
export const IMPORT_RETRY_WINDOW_MS = IMPORT_TOTAL_TIMEOUT_MS + 60 * 1000;
export const IMPORT_REAP_AFTER_MS = 30 * 60 * 1000;
export const IMPORT_STALL_TIMEOUT_MS = 30 * 1000;
export const IMPORT_PREFLIGHT_TIMEOUT_MS = 15 * 1000;
export const IMPORT_MAX_REDIRECTS = 3;
export const IMPORT_URL_MAX_LENGTH = 2_048;
export const IMPORT_MAX_BYTES = MAX_UPLOAD_BYTES;
export const IMPORT_PART_BYTES = 16 * 1024 * 1024;
export const IMPORT_ADMISSION_CHECK_BYTES = 1024 * 1024 * 1024;
