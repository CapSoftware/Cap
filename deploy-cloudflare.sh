#!/bin/bash

set -e

echo "🚀 Cap Cloudflare Deployment Script"
echo "===================================="
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_command() {
    if ! command -v $1 &> /dev/null; then
        echo -e "${RED}Error: $1 is not installed${NC}"
        echo "Please install $1 and try again"
        exit 1
    fi
}

echo "📋 Checking prerequisites..."
check_command "wrangler"
check_command "pnpm"
check_command "deno"

echo -e "${GREEN}✓ All prerequisites met${NC}"
echo ""

echo "🔐 Checking Cloudflare authentication..."
if ! wrangler whoami &> /dev/null; then
    echo -e "${YELLOW}Please login to Cloudflare:${NC}"
    wrangler login
fi
echo -e "${GREEN}✓ Authenticated with Cloudflare${NC}"
echo ""

echo "📦 Step 1: Setting up R2 buckets..."
echo ""
echo "Creating R2 bucket for video storage..."

if wrangler r2 bucket list | grep -q "cap-videos-prod"; then
    echo -e "${YELLOW}R2 bucket 'cap-videos-prod' already exists${NC}"
else
    wrangler r2 bucket create cap-videos-prod
    echo -e "${GREEN}✓ Created R2 bucket 'cap-videos-prod'${NC}"
fi

echo ""
echo -e "${YELLOW}⚠️  Manual step required:${NC}"
echo "1. Go to Cloudflare Dashboard → R2 → cap-videos-prod"
echo "2. Settings → Public Access → Connect Domain"
echo "3. Add your domain (e.g., cdn.cap.so)"
echo ""
read -p "Press Enter once you've completed this step..."

echo ""
echo "📊 Step 2: Setting up Hyperdrive for database..."
echo ""
echo -e "${YELLOW}⚠️  Manual step required:${NC}"
echo "To create Hyperdrive configuration:"
echo "  wrangler hyperdrive create cap-db --connection-string=\"mysql://user:password@host:port/database\""
echo ""
echo "OR via Dashboard:"
echo "1. Go to Cloudflare Dashboard → Workers & Pages → Hyperdrive"
echo "2. Create configuration with your MySQL connection string"
echo "3. Copy the Hyperdrive ID"
echo ""
read -p "Enter your Hyperdrive ID: " HYPERDRIVE_ID

if [ -z "$HYPERDRIVE_ID" ]; then
    echo -e "${RED}Error: Hyperdrive ID is required${NC}"
    exit 1
fi

echo ""
echo "Updating wrangler.jsonc with Hyperdrive ID..."
cd apps/web

if grep -q "\"id\": \"your-hyperdrive-id-here\"" wrangler.jsonc; then
    sed -i.bak "s/your-hyperdrive-id-here/$HYPERDRIVE_ID/g" wrangler.jsonc
    rm wrangler.jsonc.bak
    echo -e "${GREEN}✓ Updated wrangler.jsonc${NC}"
else
    echo -e "${YELLOW}Hyperdrive already configured or not found in template${NC}"
fi

echo ""
echo "🔧 Step 3: Installing dependencies..."
cd ../..
pnpm install

echo ""
echo "🏗️  Step 4: Building and deploying web app to Cloudflare Pages..."
cd apps/web

echo "Building Next.js app for Cloudflare..."
pnpm build:cloudflare

echo ""
echo "Deploying to Cloudflare Pages..."
pnpm deploy:cloudflare

echo -e "${GREEN}✓ Web app deployed to Cloudflare Pages${NC}"

echo ""
echo "🌐 Step 5: Deploying tasks service to Deno Deploy..."
cd ../tasks

if ! command -v deployctl &> /dev/null; then
    echo -e "${YELLOW}Installing deployctl...${NC}"
    deno install -A --no-check -r -f https://deno.land/x/deploy/deployctl.ts
fi

echo "Deploying tasks service..."
deployctl deploy \
  --project=cap-tasks \
  --prod \
  src/index-deno.ts || echo -e "${YELLOW}Note: First time deployment may require manual project creation in Deno Deploy dashboard${NC}"

echo -e "${GREEN}✓ Tasks service deployment initiated${NC}"

echo ""
echo "⚙️  Step 6: Deploying web-cluster to Deno Deploy..."
cd ../web-cluster

deployctl deploy \
  --project=cap-cluster \
  --prod \
  src/runner/index.ts || echo -e "${YELLOW}Note: First time deployment may require manual project creation in Deno Deploy dashboard${NC}"

echo -e "${GREEN}✓ Web-cluster deployment initiated${NC}"

echo ""
echo "✅ Deployment Complete!"
echo ""
echo "📝 Next Steps:"
echo ""
echo "1. Configure environment variables in Cloudflare Dashboard:"
echo "   - Go to Workers & Pages → cap-web → Settings → Variables"
echo "   - Add all required environment variables (see .env.example)"
echo ""
echo "2. Configure environment variables in Deno Deploy:"
echo "   - Go to https://dash.deno.com/projects/cap-tasks"
echo "   - Settings → Environment Variables"
echo "   - Add DATABASE_URL, R2 credentials, etc."
echo ""
echo "   - Go to https://dash.deno.com/projects/cap-cluster"
echo "   - Settings → Environment Variables"
echo "   - Add required variables"
echo ""
echo "3. Set up custom domains (optional):"
echo "   - Cloudflare Pages: Workers & Pages → cap-web → Custom domains"
echo "   - Add your domain (e.g., cap.so)"
echo ""
echo "4. Test your deployment:"
echo "   - Visit your Cloudflare Pages URL"
echo "   - Try recording and uploading a video"
echo "   - Check browser console for errors"
echo ""
echo "📚 For detailed instructions, see:"
echo "   apps/web/CLOUDFLARE_DEPLOYMENT.md"
echo ""
echo -e "${GREEN}🎉 Deployment script completed successfully!${NC}"
