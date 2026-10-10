# Regional Instant uploads

Routing is disabled by default. On Vercel, new desktop Instant recordings use the
request's `x-vercel-ip-country` header. Only `JP` selects Tokyo; missing/unknown
location, disabled routing, or incomplete/invalid configuration keeps the existing
Virginia path. No geolocation service, extra database query, or client change is
needed. Custom storage and Google Drive take precedence.

The chosen bucket is stored on the recording, not the user. Each new recording
uses the current request location; retries, resume, processing, playback, edits,
transfers, and deletion keep the recording's original destination. `cap-tokyo` is
a reserved bucket ID (generated customer IDs cannot contain hyphens); no schema
migration or customer storage row is needed.

Before enabling, provision a private S3 bucket in `ap-northeast-1` and a CloudFront
distribution pointing to it. Use the existing CloudFront signing key group, permit
the server/worker AWS identity to access the bucket and invalidate the distribution,
and configure the same upload CORS rules as Virginia. Set these on every web and
workflow deployment:

- `CAP_TOKYO_BUCKET`: bucket name.
- `CAP_TOKYO_BUCKET_URL`: HTTPS CDN origin, without a trailing slash or path.
- `CAP_TOKYO_CLOUDFRONT_DISTRIBUTION_ID`: that distribution's ID.
- `CAP_TOKYO_UPLOADS_ENABLED=true`: enable selection for new uploads from Japan.

Keep the existing default AWS and CloudFront configuration. To roll back routing,
set `CAP_TOKYO_UPLOADS_ENABLED=false`; retain the Tokyo bucket and configuration
while recordings reference it. Never repoint its bucket name. Losing configuration
for a stored Tokyo recording fails explicitly instead of writing its remaining
objects into Virginia.

The Tokyo benchmark improved upload completion but used direct S3 playback and
was slower to first playback/final MP4 than accelerated Virginia with CDN. Before
enabling, repeat the GPUI streaming benchmark with this CDN configuration and verify
source preparation, first playback, finalization, replacement, and deletion. This
PR does not enable routing or provision infrastructure.
