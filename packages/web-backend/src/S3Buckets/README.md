# Regional Instant uploads

Disabled by default. On Vercel, new desktop Instant recordings use the request's
`x-vercel-ip-latitude` and `x-vercel-ip-longitude` headers to choose the geographically
nearest configured region, including the existing Virginia destination. Missing or
invalid location, disabled routing, or no usable regional configuration keeps the
original path. Selection is local arithmetic: no geolocation request or extra database
query. Custom storage and Google Drive retain priority.

Supported destinations are Virginia (existing default), Ohio, Oregon, Montreal,
Calgary, Ireland, London, Paris, Frankfurt, Stockholm, Milan, Spain, Bahrain, UAE,
Mumbai, Hyderabad, Singapore, Malaysia, Tokyo, Osaka, Sydney, and Melbourne. São Paulo
and Cape Town are excluded for cost. Only provisioned and configured regions
participate. Geographic proximity does not guarantee the fastest network route;
validate each region before adding it to the configuration.

The destination is stored on the recording, not the user. Travel affects the next new
recording; retries, processing, playback, edits, transfers, and deletion keep the
original destination. Reserved `cap-*` IDs fit `videos.bucket` and cannot collide with
generated customer IDs. No schema migration or desktop change is needed.

Provision a private S3 bucket and CloudFront distribution for each enabled region.
Use the existing CloudFront signing key group, match Virginia's upload CORS rules,
and grant the server/worker AWS identity bucket access and distribution invalidation.
Enable opt-in AWS regions (such as UAE and Malaysia) in the account first. Configure every
web and workflow deployment with `CAP_REGIONAL_UPLOAD_BUCKETS`, a JSON object keyed
by supported AWS region. For example:

```json
{
  "ap-northeast-1": {
    "bucket": "your-tokyo-bucket",
    "bucketUrl": "https://your-tokyo-cdn.example.com",
    "distributionId": "YOUR_TOKYO_DISTRIBUTION_ID"
  },
  "eu-central-1": {
    "bucket": "your-frankfurt-bucket",
    "bucketUrl": "https://your-frankfurt-cdn.example.com",
    "distributionId": "YOUR_FRANKFURT_DISTRIBUTION_ID"
  }
}
```

Use HTTPS CDN origins without a trailing slash or path. Retain the existing default
AWS/CloudFront configuration (`CAP_AWS_REGION=us-east-1`). After validating the
configured destinations, set `CAP_REGIONAL_UPLOADS_ENABLED=true`. Roll back selection
by setting it to `false`; retain regional bucket configuration while recordings refer
to it, and never repoint a region's bucket name. Missing configuration for an existing
regional recording fails explicitly rather than splitting its objects across regions.

The Japan benchmark improved upload completion but used direct S3 playback and was
slower to first playback/final MP4 than accelerated Virginia with CDN. Before enabling,
repeat the GPUI benchmark with the configured CDN path and verify preparation,
playback, finalization, replacement, and deletion. Additional buckets do not replicate
recordings, but regional storage rates and cross-region processing transfers affect
cost. This change does not provision infrastructure or enable production routing.
