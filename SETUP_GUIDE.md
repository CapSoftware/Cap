# 🎉 Cap Pro Unlocked - Setup Guide

This is a fork of Cap with **all pro features unlocked for everyone**!

## What's Different?

✅ **All Pro Features Unlocked:**
- Unlimited recording length (no 5-minute limit)
- Unlimited cloud storage
- Google Drive integration
- Custom S3 storage buckets
- Password-protected videos
- Custom domain support
- Team workspaces with unlimited members
- Advanced analytics & viewer insights
- All viewer customization settings

## Quick Start - 2 Ways

### Option 1: Docker Compose (Recommended - 5 minutes)

**Prerequisites:** Docker & Docker Compose installed

```bash
# Clone your fork (if you haven't already)
git clone https://github.com/Owie6789/Cap.git
cd Cap

# Generate a secure secret
export NEXTAUTH_SECRET=$(openssl rand -hex 32)

# Start all services (MySQL, MinIO, Media Server, Web App)
docker-compose -f docker-compose-unlocked.yml up -d

# Wait 30-60 seconds for initialization...

# Access Cap at: http://localhost:3000
```

**What gets installed:**
- ✅ MySQL database (port 3306)
- ✅ MinIO S3 storage (ports 9000, 9001)
- ✅ Media Server (port 3456)
- ✅ Web App (port 3000)

**Useful commands:**
```bash
# View logs
docker-compose -f docker-compose-unlocked.yml logs -f web

# Stop services
docker-compose -f docker-compose-unlocked.yml down

# Reset everything (⚠️ removes data)
docker-compose -f docker-compose-unlocked.yml down -v

# Rebuild images
docker-compose -f docker-compose-unlocked.yml up -d --build
```

### Option 2: Local Development (15 minutes)

**Prerequisites:**
- Node.js 24+
- Rust 1.88+
- MySQL 8.0
- FFmpeg

```bash
# 1. Install dependencies
node scripts/setup.js
pnpm install

# 2. Setup environment
cp .env.local.example .env.local

# 3. Setup database
# Make sure MySQL is running, then:
pnpm db:push

# 4. Start dev servers (in separate terminals)

# Terminal 1: Web app
cd apps/web
pnpm dev

# Terminal 2: Media server
cd apps/media-server
cargo run

# Terminal 3: Desktop app (optional)
cd apps/desktop
pnpm dev
```

Access at `http://localhost:3000`

## Using the GitHub Actions Workflow

The workflow automatically builds Docker images whenever you push code.

### Trigger a Manual Build

1. Go to **Actions** in your GitHub repo
2. Click **"Build Cap Pro Unlocked"**
3. Click **"Run workflow"**
4. Choose build type:
   - `web-docker` - Web app only
   - `desktop-macos` - macOS app
   - `desktop-windows` - Windows app
   - `media-server` - Media server only
   - `all` - Everything
5. Click **"Run workflow"**

### Pull Built Docker Images

After the workflow completes:

```bash
# Login to GitHub Container Registry
docker login ghcr.io -u YOUR_GITHUB_USERNAME

# Pull the web app image
docker pull ghcr.io/Owie6789/Cap-web:latest

# Pull the media server image
docker pull ghcr.io/Owie6789/Cap-media-server:latest

# Run with docker-compose
docker-compose -f docker-compose-unlocked.yml up -d
```

## Verify Pro Features Are Unlocked

After starting Cap, you should see:

### Desktop App
- ✅ No "Upgrade to Pro" buttons
- ✅ All storage integrations available (Google Drive, S3)
- ✅ Unlimited recording length
- ✅ All editor features available

### Web App
- ✅ Unlimited video upload length
- ✅ All storage options available
- ✅ Team features with unlimited members
- ✅ Password protection available
- ✅ Advanced analytics visible

### Creating a Test Account

The local build doesn't require Stripe:

1. Go to `http://localhost:3000/login`
2. Click "Sign up"
3. Use any email (e.g., `test@example.com`)
4. Set a password
5. ✅ You're now a "Pro" user with all features!

## How It Works

### The Key Change

In `packages/utils/src/constants/plans.ts`:

```typescript
export const userIsPro = (user) => {
  // Always return true - everyone is pro!
  return true;
};
```

This single change unlocks all pro features throughout the app because:
- Every feature check calls `userIsPro()`
- Now it always returns `true`
- All premium features are accessible

### Alternative Approach

You can also set an environment variable:

```bash
NEXT_PUBLIC_IS_CAP=false  # This also unlocks all pro features
```

## Troubleshooting

### Services won't start

```bash
# Check if ports are in use
lsof -i :3000   # Web app
lsof -i :3456   # Media server
lsof -i :3306   # MySQL

# Kill processes if needed (macOS/Linux)
kill -9 <PID>
```

### Database errors

```bash
# Reset database (⚠️ deletes all data)
docker-compose -f docker-compose-unlocked.yml down -v
docker-compose -f docker-compose-unlocked.yml up -d
```

### Memory issues

The Docker stack needs ~4GB RAM. Allocate more in Docker Desktop settings if needed.

### Build failures

Check the GitHub Actions logs:
1. Go to your repo → **Actions**
2. Click the failed workflow
3. View the job logs
4. Look for error messages

## File Structure

```
Cap/
├── packages/utils/src/constants/
│   └── plans.ts                    # 🔓 Modified: userIsPro always returns true
├── .github/workflows/
│   └── build-and-deploy.yml        # 🚀 New: GitHub Actions workflow
├── docker-compose-unlocked.yml     # 🐳 New: Docker Compose config
├── .env.local.example              # 📝 New: Environment variables example
└── SETUP_GUIDE.md                  # 📚 This file
```

## Next Steps

### Deploy to Production

For cloud deployment:

1. **Docker Swarm:**
   ```bash
   docker stack deploy -c docker-compose-unlocked.yml cap-pro
   ```

2. **Kubernetes:**
   ```bash
   # Convert docker-compose to k8s manifests
   kompose convert -f docker-compose-unlocked.yml
   kubectl apply -f .
   ```

3. **Railway / Render / Heroku:**
   - Push to GitHub
   - Connect your repo
   - Set environment variables
   - Deploy!

### Customize

- Modify pricing page (remove upgrade buttons)
- Customize branding
- Add your own features
- Deploy to your own domain

## Support & Contributions

- 🐛 Found a bug? Open an issue
- 💡 Have an idea? Create a discussion
- 🤝 Want to help? Submit a PR
- 📖 Questions? Check the original Cap documentation: https://cap.so/docs

## Legal Notice

This is a fork of Cap which is licensed under MIT. All modifications maintain the same license. Always respect the original project's licensing and contribution guidelines.

---

**Built with ❤️ from the Cap community**

Enjoy unlimited screen recording with all pro features unlocked! 🎉
