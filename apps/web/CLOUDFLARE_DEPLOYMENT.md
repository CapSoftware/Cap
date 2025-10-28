# Cap Cloudflare Deployment Guide

This guide covers deploying Cap to Cloudflare infrastructure without Docker.

## Architecture Overview

- **Next.js Web App**: Cloudflare Pages (via @opennextjs/cloudflare)
- **Tasks Service**: Cloudflare Containers (FFmpeg audio merging)
- **Web-cluster Service**: Deno Deploy (Effect.js workflows)
- **Storage**: Cloudflare R2 (S3-compatible, zero egress fees)
- **Database**: Keep existing MySQL/PlanetScale with Cloudflare Hyperdrive

## Prerequisites

1. Cloudflare account with Workers Paid plan ($5/month minimum)
2. Wrangler CLI authenticated: `wrangler login`
3. MySQL database (PlanetScale recommended)
4. Domain configured in Cloudflare (optional but recommended)

## Step 1: Set Up Cloudflare R2 Storage

### Create R2 Bucket

```bash
wrangler r2 bucket create cap-videos-prod
```

### Enable Public Access

1. Go to Cloudflare Dashboard → R2
2. Select `cap-videos-prod` bucket
3. Settings → Public Access → Connect Domain
4. Add custom domain (e.g., `cdn.cap.so`)

### Create R2 API Tokens

1. R2 → Overview → Manage R2 API Tokens
2. Create API token with Admin Read & Write permissions
3. Save Access Key ID and Secret Access Key
4. Note your Account ID from the dashboard URL

## Step 2: Set Up Cloudflare Hyperdrive (Database)

### Create Hyperdrive Configuration

```bash
wrangler hyperdrive create cap-db \\
  --connection-string="mysql://user:password@host:port/database"
```

Or via Dashboard:
1. Workers & Pages → Hyperdrive
2. Create configuration
3. Enter your MySQL connection details
4. Copy the Hyperdrive ID

### Update wrangler.jsonc

Add Hyperdrive binding to `apps/web/wrangler.jsonc`:

```jsonc
{
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "your-hyperdrive-id-here"
    }
  ]
}
```

## Step 3: Configure Environment Variables

### For Development (.env)

Create or update your `.env` file:

```bash
# Core
DATABASE_URL="mysql://user:password@host:port/database"
WEB_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-secret-here"
NEXTAUTH_URL="http://localhost:3000"

# Cloudflare R2 Storage
CAP_AWS_BUCKET="cap-videos-prod"
CAP_AWS_REGION="auto"
CAP_AWS_ACCESS_KEY="your-r2-access-key"
CAP_AWS_SECRET_KEY="your-r2-secret-key"
CAP_AWS_ENDPOINT="https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com"
CAP_AWS_BUCKET_URL="https://cdn.cap.so"
S3_PUBLIC_ENDPOINT="https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com"
S3_INTERNAL_ENDPOINT="https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com"
S3_PATH_STYLE="true"

# AI (optional)
GROQ_API_KEY="your-groq-key"
OPENAI_API_KEY="your-openai-key"

# Email (optional)
RESEND_API_KEY="your-resend-key"
RESEND_FROM_DOMAIN="yourdomain.com"

# Analytics (optional)
NEXT_PUBLIC_POSTHOG_KEY="your-posthog-key"
NEXT_PUBLIC_POSTHOG_HOST="https://app.posthog.com"
```

### For Production (Cloudflare Dashboard)

Set environment variables in Cloudflare Dashboard:
1. Workers & Pages → Your project → Settings → Variables
2. Add all production environment variables
3. Mark sensitive values as "Encrypt"

Required variables:
- All variables from the .env template above
- Replace localhost URLs with production URLs
- Use production API keys

## Step 4: Deploy Next.js Web App to Cloudflare Pages

### Build and Deploy

```bash
cd apps/web

# Test build locally
pnpm build:cloudflare

# Preview locally
pnpm preview:cloudflare

# Deploy to Cloudflare
pnpm deploy:cloudflare
```

### First-Time Setup

If this is your first deployment:

```bash
# This will prompt you to create a new project
pnpm deploy:cloudflare

# Follow prompts:
# - Project name: cap-web
# - Production branch: main (or your deployment branch)
```

### Update Cloudflare Pages Settings

After first deployment:
1. Go to Workers & Pages → cap-web
2. Settings → Environment Variables
3. Add all production env vars
4. Settings → Functions
5. Set compatibility date to `2025-05-05`
6. Enable `nodejs_compat` compatibility flag

## Step 5: Set Up Tasks Service on Cloudflare Containers

The tasks service requires FFmpeg, so it must run on Cloudflare Containers (not standard Workers).

### Create Dockerfile for Tasks Service

See `apps/tasks/Dockerfile.cloudflare` (created by setup script).

### Deploy to Cloudflare Containers

```bash
cd apps/tasks

# Build and deploy
wrangler deploy
```

### Configure Environment Variables

Set in Cloudflare Dashboard for the tasks container:
- DATABASE_URL
- CAP_AWS_* (R2 credentials)
- Any other required variables

## Step 6: Deploy Web-cluster to Deno Deploy

The web-cluster service runs best on Deno Deploy due to Effect.js compatibility.

### Prerequisites

1. Create Deno Deploy account
2. Install Deno: `curl -fsSL https://deno.land/install.sh | sh`
3. Login: `deployctl login`

### Deploy

```bash
cd apps/web-cluster

# Deploy to Deno Deploy
deployctl deploy \\
  --project=cap-cluster \\
  --prod \\
  src/index.ts
```

### Configure Environment Variables

Set in Deno Deploy dashboard:
- DATABASE_URL
- WEB_URL
- WORKFLOWS_RPC_SECRET
- Any other required variables

## Step 7: Configure Custom Domains

### For Web App (Pages)

1. Workers & Pages → cap-web → Custom domains
2. Add domain (e.g., `cap.so`)
3. DNS records are automatically configured

### For R2 Storage

1. R2 → cap-videos-prod → Settings
2. Public Access → Connect Domain
3. Add domain (e.g., `cdn.cap.so`)

## Step 8: Database Migrations

Migrations run automatically on startup when using the Docker build.

For Cloudflare deployment, you may need to run migrations manually:

```bash
cd packages/database
pnpm db:push
```

Or trigger via API endpoint:
```bash
curl -X POST https://cap.so/api/selfhosted/migrations
```

## Step 9: Verify Deployment

### Check Web App

1. Visit your domain (e.g., https://cap.so)
2. Try logging in
3. Test video recording and playback
4. Check browser console for errors

### Check R2 Storage

```bash
# List objects
aws s3 ls s3://cap-videos-prod \\
  --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com

# Upload test file
echo "test" > test.txt
aws s3 cp test.txt s3://cap-videos-prod/test.txt \\
  --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
```

### Check Tasks Service

```bash
curl -X POST https://cap-tasks.YOUR_SUBDOMAIN.workers.dev/api/v1/merge-audio-segments \\
  -H "Content-Type: application/json" \\
  -d '{"test": true}'
```

## Monitoring & Debugging

### Cloudflare Analytics

- Workers & Pages → cap-web → Analytics
- View requests, errors, and performance

### Logs

```bash
# Tail Pages logs
wrangler pages deployment tail

# Tail Container logs
wrangler tail cap-tasks
```

### Common Issues

**Build fails with "Module not found"**
- Ensure all workspace dependencies are properly installed
- Run `pnpm install` from repository root

**Database connection errors**
- Verify Hyperdrive configuration
- Check DATABASE_URL is correctly set
- Ensure compatibility_flags includes `nodejs_compat`

**R2 upload errors**
- Verify R2 credentials are correct
- Check bucket exists and has correct permissions
- Ensure S3_PATH_STYLE="true" is set

**Image optimization not working**
- Verify custom image loader is configured
- Check Cloudflare Images is enabled in dashboard

## Cost Estimate

Based on typical usage:

| Service | Cost |
|---------|------|
| Workers Paid Plan | $5/month base |
| R2 Storage (100GB) | $1.50/month |
| R2 Requests | Included |
| R2 Egress | $0 (zero egress fees!) |
| Hyperdrive | Free forever |
| Containers (light usage) | ~$5-10/month |
| Deno Deploy (web-cluster) | Free tier or ~$10/month |
| **Total** | ~$20-25/month |

Compare to Railway/Docker: ~$30-60/month

## Rollback Procedure

If issues occur:

1. **Rollback Pages deployment:**
   ```bash
   wrangler pages deployment list
   wrangler pages deployment rollback
   ```

2. **Revert to previous Docker deployment** if needed

3. **Switch R2 back to S3:**
   - Update environment variables to point back to S3
   - Redeploy

## Maintenance

### Updating the Deployment

```bash
# Pull latest changes
git pull

# Deploy web app
cd apps/web
pnpm deploy:cloudflare

# Deploy tasks service
cd ../tasks
wrangler deploy

# Deploy web-cluster
cd ../web-cluster
deployctl deploy --project=cap-cluster --prod src/index.ts
```

### Database Migrations

```bash
# Generate new migration
cd packages/database
pnpm db:generate

# Apply to production
pnpm db:push
```

## Support

- Cloudflare Docs: https://developers.cloudflare.com/
- OpenNext Cloudflare: https://opennext.js.org/cloudflare
- Deno Deploy: https://deno.com/deploy/docs

## Next Steps

Once deployed:

1. Set up monitoring alerts in Cloudflare
2. Configure custom error pages
3. Enable Cloudflare Analytics
4. Set up automated backups for database
5. Configure CDN caching rules
6. Set up staging environment
