// @ts-check

import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import { log } from "@clack/prompts";
import { group } from "@clack/prompts";
import { outro } from "@clack/prompts";
import { text } from "@clack/prompts";
import { confirm } from "@clack/prompts";
import { intro, multiselect, isCancel } from "@clack/prompts";

const DOCKER_S3_ENVS = {
  accessKey: "capS3root",
  secretKey: "capS3root",
  bucket: "capso",
  region: "us-east-1",
  endpoint: "http://localhost:3902",
};

const DOCKER_DB_ENVS = {
  url: "mysql://root:@localhost:3306/planetscale",
};

async function main() {
  intro("Welcome to the Cap env setup CLI!");

  const targets = await multiselect({
    message: "Which apps will you be working on?",
    options: [
      { value: "desktop", label: "Desktop" },
      { value: "web", label: "Web" },
    ],
    required: true,
  });

  if (isCancel(targets)) return;

  const file = await fs
    .readFile("./target/env-profiles/default.json", "utf8")
    .catch(() => null);
  let allEnvs = file ? JSON.parse(file) : {};

  let envs = {
    NODE_ENV: "development",
  };

  const hasWeb = targets.includes("web");
  const hasDesktop = targets.includes("desktop");

  /** @type {boolean | symbol} */
  let usingDockerEnvironment = false;

  if (hasWeb) {
    envs.VITE_SERVER_URL = "https://opavc.com";
    envs.NEXT_PUBLIC_WEB_URL = "http://localhost:3000";
    envs.NEXTAUTH_URL = envs.NEXT_PUBLIC_WEB_URL;

    if (!allEnvs.NEXTAUTH_SECRET) {
      allEnvs.NEXTAUTH_SECRET = crypto.randomBytes(32).toString("base64");
      log.info("Generated NEXTAUTH_SECRET");
    }
    envs.NEXTAUTH_SECRET = allEnvs.NEXTAUTH_SECRET;

    if (!allEnvs.DATABASE_ENCRYPTION_KEY) {
      allEnvs.DATABASE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
      log.info("Generated DATABASE_ENCRYPTION_KEY");
    }
    envs.DATABASE_ENCRYPTION_KEY = allEnvs.DATABASE_ENCRYPTION_KEY;

    usingDockerEnvironment = await confirm({
      message: "Will you be running S3 and MySQL via Docker?",
    });

    if (isCancel(usingDockerEnvironment)) return;
    if (!usingDockerEnvironment) {
      log.info("Database Envs");

      const dbValues = await group({
        DATABASE_URL: () =>
          text({
            message:
              "DATABASE_URL - Can be plain mysql:// or a PlanetScale https:// URL",
            placeholder:
              allEnvs.DATABASE_URL ??
              "mysql://root:@localhost:3306/planetscale",
            defaultValue:
              allEnvs.DATABASE_URL ??
              "mysql://root:@localhost:3306/planetscale",
          }),
        DATABASE_MIGRATION_URL: (v) => {
          if (v.results.DATABASE_URL?.startsWith("http")) {
            log.info("Planetscale HTTP URL detected");
            return text({
              message: "DATABASE_MIGRATION_URL",
            });
          }
        },
      });

      envs.DATABASE_URL = dbValues.DATABASE_URL;
      if (dbValues.DATABASE_MIGRATION_URL)
        envs.DATABASE_MIGRATION_URL = dbValues.DATABASE_MIGRATION_URL;

      log.info("S3 Envs");

      const s3Values = await group(
        {
          CAP_AWS_ACCESS_KEY: () =>
            text({
              message: "CAP_AWS_ACCESS_KEY",
              placeholder: allEnvs.CAP_AWS_ACCESS_KEY,
              defaultValue: allEnvs.CAP_AWS_ACCESS_KEY,
            }),
          CAP_AWS_SECRET_KEY: () =>
            text({
              message: "CAP_AWS_SECRET_KEY",
              placeholder: allEnvs.CAP_AWS_SECRET_KEY,
              defaultValue: allEnvs.CAP_AWS_SECRET_KEY,
            }),
          NEXT_PUBLIC_CAP_AWS_BUCKET: () =>
            text({
              message: "NEXT_PUBLIC_CAP_AWS_BUCKET",
              defaultValue: allEnvs.NEXT_PUBLIC_CAP_AWS_BUCKET,
              placeholder: allEnvs.NEXT_PUBLIC_CAP_AWS_BUCKET,
            }),
          NEXT_PUBLIC_CAP_AWS_REGION: () =>
            text({
              message: "NEXT_PUBLIC_CAP_AWS_REGION",
              defaultValue: allEnvs.NEXT_PUBLIC_CAP_AWS_REGION,
              placeholder: allEnvs.NEXT_PUBLIC_CAP_AWS_REGION,
            }),
          NEXT_PUBLIC_CAP_AWS_ENDPOINT: () =>
            text({
              message: "NEXT_PUBLIC_CAP_AWS_ENDPOINT",
              defaultValue: allEnvs.NEXT_PUBLIC_CAP_AWS_ENDPOINT,
              placeholder: allEnvs.NEXT_PUBLIC_CAP_AWS_ENDPOINT,
            }),
          NEXT_PUBLIC_CAP_AWS_BUCKET_URL: () =>
            text({ message: "NEXT_PUBLIC_CAP_AWS_BUCKET_URL" }),
          CAP_CLOUDFRONT_DISTRIBUTION_ID: () =>
            text({ message: "CAP_CLOUDFRONT_DISTRIBUTION_ID" }),
        },
        { onCancel: () => process.exit(0) }
      );

      envs = { ...envs, ...s3Values };
    } else {
      envs.DATABASE_URL = DOCKER_DB_ENVS.url;
      envs.DATABASE_MIGRATION_URL = DOCKER_DB_ENVS.url;

      envs.CAP_AWS_ACCESS_KEY = DOCKER_S3_ENVS.accessKey;
      envs.CAP_AWS_SECRET_KEY = DOCKER_S3_ENVS.secretKey;
      envs.NEXT_PUBLIC_CAP_AWS_BUCKET = DOCKER_S3_ENVS.bucket;
      envs.NEXT_PUBLIC_CAP_AWS_REGION = DOCKER_S3_ENVS.region;
      envs.NEXT_PUBLIC_CAP_AWS_ENDPOINT = DOCKER_S3_ENVS.endpoint;
    }
  } else {
    envs.VITE_SERVER_URL = "https://opavc.com";
  }

  if (hasDesktop) {
    envs.RUST_BACKTRACE = "1";

    const values = await group(
      {
        VITE_VERCEL_AUTOMATION_BYPASS_SECRET: () => {
          if (!hasWeb)
            return text({
              message:
                "VITE_VERCEL_AUTOMATION_BYPASS_SECRET - skip if you're not a Cap team member",
              placeholder: allEnvs.VITE_VERCEL_AUTOMATION_BYPASS_SECRET,
              defaultValue: allEnvs.VITE_VERCEL_AUTOMATION_BYPASS_SECRET,
            });
        },
      },
      { onCancel: () => process.exit(0) }
    );

    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === "undefined") continue;
      envs[key] = value;
    }
  }

  await fs.writeFile(
    ".env",
    Object.entries(envs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
  );

  log.info(`Written ${Object.keys(envs).length} envs`);

  allEnvs = { ...allEnvs, ...envs };
  await fs.mkdir("./target/env-profiles", { recursive: true });
  await fs.writeFile(
    "./target/env-profiles/default.json",
    JSON.stringify(allEnvs, null, 4)
  );

  const DESKTOP_MSG = "'pnpm dev:desktop' to start the desktop app";
  const WEB_DOCKER_MSG =
    "'pnpm dev:web' to start the web app + Docker services";
  const WEB_MSG = "'pnpm web dev' to start the web app";

  if (hasWeb) {
    if (hasDesktop) {
      if (usingDockerEnvironment) {
        outro(`Run ${DESKTOP_MSG}, and ${WEB_DOCKER_MSG}`);
      } else {
        outro(`Run ${DESKTOP_MSG}, and ${WEB_MSG}`);
      }
    } else {
      if (usingDockerEnvironment) {
        outro(`Run ${WEB_DOCKER_MSG}`);
      } else {
        outro(`Run ${WEB_MSG}`);
      }
    }
  } else if (hasDesktop) {
    outro(`Run ${DESKTOP_MSG}`);
  }
}

await main();
