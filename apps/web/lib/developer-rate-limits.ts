export const DEVELOPER_RATE_LIMIT_WINDOW_SECONDS = 60;

export const DEVELOPER_KEY_REQUESTS_PER_MINUTE = 300;

// One account can hold many apps, each with its own key. Their requests also
// count together, so more apps do not mean an ever larger total.
export const DEVELOPER_OWNER_REQUESTS_PER_MINUTE = 1200;

export const DEVELOPER_AUTH_FAILURES_PER_MINUTE = 30;

// An upload signs one part per request and the smallest part is 5 MB, so this
// is the ceiling on upload speed: 1,200 parts a minute is 6 GB a minute.
export const DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE = 1200;

// The pace every doc, the OpenAPI document and the agent prompt recommend. A
// short video is playable about 3 seconds after its upload completes and a
// short transcript takes about 5 seconds, so one check usually finds it done.
export const DEVELOPER_VIDEO_STATUS_POLL_SECONDS = 3;
export const DEVELOPER_TRANSCRIPT_POLL_SECONDS = 5;
