# `@cap/web`

Cap's NextJS web app for video sharing.
Used for both self hosting and on [cap.so](https://cap.so).

## Error monitoring

The hosted app reports browser, server, and edge errors to the `cap-s2/cap-web`
Sentry project when `NEXT_PUBLIC_SENTRY_DSN` is set. Performance tracing and
Session Replay are disabled. Builds upload source maps when `SENTRY_AUTH_TOKEN`
is available; keep that token in deployment secrets. Deployments without a DSN
do not initialize Sentry.
