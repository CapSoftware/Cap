// This file is used to run database migrations in the docker builds or other self hosting environments.
// It is not suitable (a.k.a DEADLY) for serverless environments where the server will be restarted on each request.

import { serverEnv } from "@cap/env";
import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("Waiting 5 seconds to run migrations");

    // Function to trigger migrations with retry logic
    const triggerMigrations = async (retryCount = 0, maxRetries = 3) => {
      try {
        const response = await fetch(
          `${serverEnv().WEB_URL}/api/selfhosted/migrations`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        // This will throw an error if the response status is not ok
        response.ok ||
          (await Promise.reject(new Error(`HTTP error ${response.status}`)));

        const responseData = await response.json();
        console.log(
          "✅ Migrations triggered successfully:",
          responseData.message
        );
      } catch (error) {
        console.error(
          `🚨 Error triggering migrations (attempt ${retryCount + 1}):`,
          error
        );
        if (retryCount < maxRetries - 1) {
          console.log(
            `🔄 Retrying in 5 seconds... (${retryCount + 1}/${maxRetries})`
          );
          setTimeout(() => triggerMigrations(retryCount + 1, maxRetries), 5000);
        } else {
          console.error(`🚨 All ${maxRetries} migration attempts failed.`);
          process.exit(1); // Exit with error code if all attempts fail
        }
      }
    };

    // Add a timeout to trigger migrations after 5 seconds on server start
    setTimeout(() => triggerMigrations(), 5000);

    setTimeout(() => createS3Bucket(), 5000);
  }
  return;
}

async function createS3Bucket() {
  const s3Client = new S3Client({
    endpoint: serverEnv().CAP_AWS_ENDPOINT,
    region: serverEnv().CAP_AWS_REGION,
    credentials: {
      accessKeyId: serverEnv().CAP_AWS_ACCESS_KEY ?? "",
      secretAccessKey: serverEnv().CAP_AWS_SECRET_KEY ?? "",
    },
    forcePathStyle: serverEnv().S3_PATH_STYLE,
  });

  await s3Client
    .send(new CreateBucketCommand({ Bucket: serverEnv().CAP_AWS_BUCKET }))
    .then(() => {
      console.log("Created S3 bucket");
      return s3Client.send(
        new PutBucketPolicyCommand({
          Bucket: serverEnv().CAP_AWS_BUCKET,
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: "*",
                Action: ["s3:GetObject"],
                Resource: [`arn:aws:s3:::${serverEnv().CAP_AWS_BUCKET}/*`],
              },
            ],
          }),
        })
      );
    })
    .then(() => {
      console.log("Configured S3 buckeet");
    })
    .catch((e) => {
      if (e instanceof BucketAlreadyOwnedByYou) {
        console.log("Found existing S3 bucket");
        return;
      }
    });
}
