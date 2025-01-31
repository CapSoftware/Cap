export const S3_BUCKET_URL = (() => {
  const fixedUrl = process.env.NEXT_PUBLIC_CAP_AWS_BUCKET_URL;
  const endpoint = process.env.NEXT_PUBLIC_CAP_AWS_ENDPOINT;
  const bucket = process.env.NEXT_PUBLIC_CAP_AWS_BUCKET;
  const region = process.env.NEXT_PUBLIC_CAP_AWS_REGION;

  if (fixedUrl) return fixedUrl;
  if (endpoint) return `${endpoint}/${bucket}`;
  return `s3.${region}.amazonaws.com/${bucket}`;
})();
