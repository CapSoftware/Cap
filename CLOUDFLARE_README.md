# Cap Cloudflare Deployment - Complete Guide

This repository is now configured for deployment to Cloudflare infrastructure without Docker.

## 🏗️ Architecture

- **Web App**: Cloudflare Pages (Next.js via @opennextjs/cloudflare)
- **Tasks Service**: Deno Deploy (FFmpeg audio processing)
- **Web-cluster**: Deno Deploy (Effect.js workflows)
- **Storage**: Cloudflare R2 (S3-compatible, zero egress fees)
- **Database**: MySQL/PlanetScale via Cloudflare Hyperdrive

## 🚀 Quick Start

### Automated Deployment

```bash
./deploy-cloudflare.sh
```

This script will:
1. Create R2 buckets
2. Set up Hyperdrive configuration
3. Build and deploy the web app to Cloudflare Pages
4. Deploy tasks service to Deno Deploy
5. Deploy web-cluster to Deno Deploy

### Manual Deployment

See [apps/web/CLOUDFLARE_DEPLOYMENT.md](apps/web/CLOUDFLARE_DEPLOYMENT.md) for detailed manual deployment instructions.

## 📦 What's Been Configured

### Web App (apps/web)

**New Files:**
- `wrangler.jsonc` - Cloudflare Workers configuration
- `open-next.config.ts` - OpenNext adapter configuration
- `image-loader.ts` - Cloudflare Images integration
- `.dev.vars` - Local development variables
- `CLOUDFLARE_DEPLOYMENT.md` - Detailed deployment guide

**Modified Files:**
- `package.json` - Added Cloudflare build scripts and dependencies
- `next.config.mjs` - Configured for Cloudflare Pages
- `.gitignore` - Added Cloudflare-specific ignores

**New Scripts:**
```bash
pnpm build:cloudflare    # Build for Cloudflare
pnpm preview:cloudflare  # Preview locally with Workers runtime
pnpm deploy:cloudflare   # Deploy to Cloudflare Pages
pnpm cf-typegen          # Generate TypeScript types for bindings
```

### Tasks Service (apps/tasks)

**New Files:**
- `deno.json` - Deno configuration
- `src/index-deno.ts` - Deno-compatible version using Hono + FFmpeg
- `deployctl.json` - Deno Deploy configuration

**Deployment:**
```bash
cd apps/tasks
deployctl deploy --project=cap-tasks --prod src/index-deno.ts
```

### Environment Variables

**New File:**
- `.env.cloudflare.example` - Complete template for all environment variables

**Required Variables:**
- Core: `WEB_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`
- Database: `DATABASE_URL`
- R2 Storage: `CAP_AWS_*` variables (see template)
- Optional: AI keys, email, analytics, payments

## 🔧 Prerequisites

### Required Tools

1. **Wrangler CLI** (Cloudflare)
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **Deno** (for tasks and web-cluster)
   ```bash
   curl -fsSL https://deno.land/install.sh | sh
   ```

3. **pnpm** (package manager)
   ```bash
   npm install -g pnpm
   ```

### Required Accounts

1. **Cloudflare** account with Workers Paid plan ($5/month minimum)
2. **Deno Deploy** account (free tier available)
3. **MySQL database** (PlanetScale recommended)

## 📝 Environment Setup

### 1. Create .env File

```bash
cp .env.cloudflare.example .env
```

Edit `.env` and fill in your values.

### 2. Set Up Cloudflare R2

```bash
# Create bucket
wrangler r2 bucket create cap-videos-prod

# Get R2 credentials
# Dashboard → R2 → Manage R2 API Tokens → Create API token
```

Update `.env` with R2 credentials:
- `CAP_AWS_ACCESS_KEY`
- `CAP_AWS_SECRET_KEY`
- `CAP_AWS_ENDPOINT` (format: https://ACCOUNT_ID.r2.cloudflarestorage.com)

### 3. Set Up Hyperdrive (Database Connection)

```bash
wrangler hyperdrive create cap-db \
  --connection-string="mysql://user:password@host:port/database"
```

Copy the Hyperdrive ID and update `apps/web/wrangler.jsonc`:
```jsonc
{
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "YOUR_HYPERDRIVE_ID_HERE"
    }
  ]
}
```

## 🚢 Deployment Steps

### Option A: Automated (Recommended)

```bash
./deploy-cloudflare.sh
```

### Option B: Manual

**1. Deploy Web App**
```bash
cd apps/web
pnpm build:cloudflare
pnpm deploy:cloudflare
```

**2. Deploy Tasks Service**
```bash
cd apps/tasks
deployctl deploy --project=cap-tasks --prod src/index-deno.ts
```

**3. Deploy Web-cluster**
```bash
cd apps/web-cluster
deployctl deploy --project=cap-cluster --prod src/runner/index.ts
```

### Post-Deployment Configuration

**1. Set Environment Variables in Cloudflare**
- Go to Cloudflare Dashboard → Workers & Pages → cap-web → Settings → Variables
- Add all variables from your `.env` file
- Mark sensitive values as "Encrypt"

**2. Set Environment Variables in Deno Deploy**
- **Tasks**: https://dash.deno.com/projects/cap-tasks → Settings → Environment Variables
- **Web-cluster**: https://dash.deno.com/projects/cap-cluster → Settings → Environment Variables

Required for both:
- `DATABASE_URL`
- `CAP_AWS_*` (R2 credentials)
- Any other service-specific variables

**3. Configure Custom Domains (Optional)**
- **Web App**: Cloudflare Dashboard → Workers & Pages → cap-web → Custom domains
- **R2 Storage**: R2 → cap-videos-prod → Settings → Connect Domain

## ✅ Verification

### Test Web App

1. Visit your Cloudflare Pages URL (provided after deployment)
2. Try logging in
3. Test video recording and playback
4. Check browser console for errors

### Test Tasks Service

```bash
curl -X POST https://cap-tasks.deno.dev/api/v1/merge-audio-segments \
  -H "Content-Type: application/json" \
  -d '{"segments":[],"uploadUrl":"","videoId":"test"}'
```

Expected: 400 Bad Request (because we sent empty data, but service is running)

### Test R2 Storage

```bash
# List buckets
wrangler r2 bucket list

# Test upload (requires AWS CLI configured with R2 credentials)
echo "test" > test.txt
aws s3 cp test.txt s3://cap-videos-prod/test.txt \
  --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
```

## 🔍 Monitoring

### Cloudflare Analytics
- Dashboard → Workers & Pages → cap-web → Analytics
- View requests, errors, CPU time, bandwidth

### Deno Deploy Logs
- https://dash.deno.com/projects/cap-tasks → Logs
- https://dash.deno.com/projects/cap-cluster → Logs

### Cloudflare Logs

```bash
# Web app logs
wrangler pages deployment tail

# Real-time monitoring
wrangler pages deployment list
```

## 💰 Cost Estimate

| Service | Cost |
|---------|------|
| Cloudflare Workers Paid | $5/month base |
| Cloudflare R2 (100GB storage) | $1.50/month |
| R2 Egress | $0 (zero egress fees!) |
| Cloudflare Hyperdrive | Free forever |
| Deno Deploy (tasks) | Free tier or ~$10/month |
| Deno Deploy (web-cluster) | Free tier or ~$10/month |
| **Total** | ~$7-25/month |

**Savings vs Railway/Docker**: 50-75% cost reduction
**R2 vs S3**: 98% cost reduction on egress fees for video streaming

## 🐛 Troubleshooting

### Build Errors

**"Module not found" errors**
```bash
# Reinstall dependencies
pnpm install
```

**"Invalid environment variables"**
- Ensure `NEXT_PUBLIC_WEB_URL` is set
- Check `.env` file exists and has correct values

### Deployment Errors

**"Hyperdrive connection failed"**
- Verify Hyperdrive ID in `wrangler.jsonc`
- Check database connection string is correct
- Ensure database is accessible from Cloudflare's network

**"R2 bucket not found"**
```bash
# Verify bucket exists
wrangler r2 bucket list

# Create if missing
wrangler r2 bucket create cap-videos-prod
```

### Runtime Errors

**Database connection errors**
- Check Hyperdrive configuration
- Verify DATABASE_URL in Cloudflare environment variables
- Ensure `nodejs_compat` flag is enabled

**Image optimization not working**
- Verify custom image loader is configured
- Check Cloudflare Images is available in your plan

## 📚 Additional Resources

- [Cloudflare Pages Documentation](https://developers.cloudflare.com/pages/)
- [OpenNext Cloudflare Adapter](https://opennext.js.org/cloudflare)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
- [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
- [Deno Deploy Documentation](https://deno.com/deploy/docs)

## 🔄 Updating the Deployment

```bash
# Pull latest changes
git pull

# Deploy web app
cd apps/web
pnpm deploy:cloudflare

# Deploy tasks service
cd ../tasks
deployctl deploy --project=cap-tasks --prod src/index-deno.ts

# Deploy web-cluster
cd ../web-cluster
deployctl deploy --project=cap-cluster --prod src/runner/index.ts
```

## 🆘 Support

For issues specific to this Cloudflare deployment:
1. Check the [CLOUDFLARE_DEPLOYMENT.md](apps/web/CLOUDFLARE_DEPLOYMENT.md) for detailed instructions
2. Review Cloudflare Workers/Pages documentation
3. Check Deno Deploy documentation for service issues

For Cap-specific issues:
- GitHub Issues: https://github.com/capsoftware/cap/issues
- Documentation: https://cap.so/docs

## 📋 File Structure

```
Cap/
├── deploy-cloudflare.sh          # Automated deployment script
├── .env.cloudflare.example       # Environment variables template
├── CLOUDFLARE_README.md          # This file
│
├── apps/web/                     # Next.js web application
│   ├── wrangler.jsonc            # Cloudflare Workers config
│   ├── open-next.config.ts       # OpenNext adapter config
│   ├── image-loader.ts           # Cloudflare Images integration
│   ├── .dev.vars                 # Local dev variables
│   └── CLOUDFLARE_DEPLOYMENT.md  # Detailed deployment guide
│
├── apps/tasks/                   # Audio processing service
│   ├── deno.json                 # Deno configuration
│   ├── deployctl.json            # Deno Deploy config
│   └── src/index-deno.ts         # Deno-compatible entry point
│
└── apps/web-cluster/             # Workflow engine
    └── (uses existing Deno setup)
```

## 🎯 Next Steps

After successful deployment:

1. **Set up monitoring**
   - Enable Cloudflare Analytics
   - Set up alerts for errors and high latency
   - Monitor R2 storage usage

2. **Configure CDN caching**
   - Set up cache rules in Cloudflare
   - Configure page rules for static assets
   - Enable Argo Smart Routing (optional)

3. **Optimize performance**
   - Review bundle size in Cloudflare dashboard
   - Enable Cloudflare Image Optimization
   - Configure worker routes for specific paths

4. **Set up backups**
   - Regular database backups
   - R2 versioning (if needed)
   - Export environment variables

5. **Security hardening**
   - Review CORS policies
   - Set up rate limiting
   - Enable Web Application Firewall (WAF)
   - Configure DDoS protection

## 🎉 Success!

Your Cap deployment is now running on Cloudflare infrastructure with:
- ✅ Global edge network distribution
- ✅ Zero egress fees for video streaming
- ✅ Automatic SSL/TLS
- ✅ DDoS protection
- ✅ Automatic scaling
- ✅ Significant cost savings

Enjoy your deployment!
