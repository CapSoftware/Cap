import { clientEnv } from "@cap/env";

export const S3_BUCKET_URL = (() => {
  const fixedUrl = clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET_URL;
  const endpoint = clientEnv.NEXT_PUBLIC_CAP_AWS_ENDPOINT;
  const bucket = clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET;
  const region = clientEnv.NEXT_PUBLIC_CAP_AWS_REGION;

  if (fixedUrl) return fixedUrl;
  if (endpoint) return `${endpoint}/${bucket}`;
  return `s3.${region}.amazonaws.com/${bucket}`;
})();
