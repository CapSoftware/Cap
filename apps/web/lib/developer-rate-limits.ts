export const DEVELOPER_RATE_LIMIT_WINDOW_SECONDS = 60;

export const DEVELOPER_KEY_REQUESTS_PER_MINUTE = 60;

// An upload signs one part per request and the smallest part is 5 MB, so this
// is the ceiling on upload speed: 1,200 parts a minute is 6 GB a minute.
export const DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE = 1200;
