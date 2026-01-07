# Stream B: Notion OAuth Flow Context

**Workstream:** API routes for Notion OAuth authentication

**Dependencies:** Stream A (database schema must exist)

**Prerequisites:** Stream A complete, Notion integration credentials

---

## Key Files to Understand

### API Route Pattern
- Location: `apps/web/app/api/`
- Uses Next.js App Router conventions
- Example: `apps/web/app/api/video/comment/route.ts`

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // ... logic
}

export async function POST(request: NextRequest) {
  // ...
}
```

### Auth Utilities
- `apps/web/app/utils/auth.ts` - Cached getCurrentUser
- `@cap/database/auth/session` - Core auth functions

### Environment Access
```typescript
import { serverEnv } from "@cap/env";
const env = serverEnv();
// env.NOTION_CLIENT_ID, env.NOTION_CLIENT_SECRET, etc.
```

---

## Notion OAuth Flow

1. **Initiate:** `/api/integrations/notion/auth`
   - Generate state token for CSRF
   - Store in httpOnly cookie
   - Redirect to Notion authorize URL

2. **Callback:** `/api/integrations/notion/callback`
   - Verify state matches cookie
   - Exchange code for access token
   - Encrypt token and store in DB
   - Redirect to settings page

3. **Databases:** `/api/integrations/notion/databases`
   - Fetch user's Notion databases
   - Return list for selection dropdown

---

## Notion API Details

**Token Exchange:**
```
POST https://api.notion.com/v1/oauth/token
Authorization: Basic base64(client_id:client_secret)
Body: { grant_type: "authorization_code", code, redirect_uri }
```

**Response:**
```json
{
  "access_token": "...",
  "workspace_id": "...",
  "workspace_name": "...",
  "workspace_icon": "...",
  "bot_id": "..."
}
```

**Search Databases:**
```
POST https://api.notion.com/v1/search
Authorization: Bearer {access_token}
Notion-Version: 2022-06-28
Body: { filter: { value: "database", property: "object" } }
```

---

## Tasks in This Stream

1. **B1:** Create `/api/integrations/notion/auth/route.ts` - OAuth initiation
2. **B2:** Create `/api/integrations/notion/callback/route.ts` - Token exchange
3. **B3:** Create `/api/integrations/notion/databases/route.ts` - List databases

---

## Credentials (for testing)

```
NOTION_CLIENT_ID=<your-notion-client-id>
NOTION_CLIENT_SECRET=<your-notion-client-secret>
NOTION_REDIRECT_URI=https://cap-web-production-d5ac.up.railway.app/api/integrations/notion/callback
```

Note: Get actual credentials from Railway environment or ask project owner.

---

## Cookie Pattern for State

```typescript
import { cookies } from "next/headers";
import { nanoId } from "@cap/database/helpers";

// Set
const state = nanoId();
const cookieStore = await cookies();
cookieStore.set("notion_oauth_state", state, {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 60 * 10,
  path: "/",
});

// Get and delete
const storedState = cookieStore.get("notion_oauth_state")?.value;
cookieStore.delete("notion_oauth_state");
```

---

## Handoff to Stream D

Stream D (Frontend) depends on:
- OAuth routes working
- `/api/integrations/notion/databases` returning database list

Provide: Working OAuth flow, database listing endpoint
