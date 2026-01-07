# Notion Ticket Integration Design

**Date:** 2026-01-07
**Status:** Ready for implementation

## Overview

Add a "Create Ticket" feature to Cap that auto-generates Notion tickets from screen recordings. The feature transcribes video content, uses AI to extract ticket fields, and creates structured tickets in the user's Notion database.

## User Flow

```
1. CONNECT (one-time)              2. CREATE TICKET (per-video)
┌──────────────────────┐           ┌────────────────────────────┐
│ Settings > Integrations │         │ Video Page > "Create Ticket"│
│ Click "Connect Notion"  │         │ Button in header OR         │
│ OAuth flow → select DB  │         │ Integrations sidebar tab    │
│ Save to user account    │         └────────────┬───────────────┘
└──────────────────────┘                         │
                                                 ▼
                                 ┌───────────────────────────────┐
                                 │ Transcribe (if not cached)    │
                                 │ ~10-30s via Deepgram          │
                                 └───────────────┬───────────────┘
                                                 ▼
                                 ┌───────────────────────────────┐
                                 │ AI Extract fields (single call)│
                                 │ OpenAI GPT-4o-mini            │
                                 └───────────────┬───────────────┘
                                                 ▼
                                 ┌───────────────────────────────┐
                                 │ Review Modal                  │
                                 │ - Title (editable)            │
                                 │ - Type dropdown               │
                                 │ - Priority dropdown           │
                                 │ - Product Area (optional)     │
                                 │ - Description (editable)      │
                                 │ - Steps to Reproduce (editable)│
                                 │ [Cancel] [Create in Notion]   │
                                 └───────────────┬───────────────┘
                                                 ▼
                                 ┌───────────────────────────────┐
                                 │ Notion API: Create Page       │
                                 │ Success toast + link          │
                                 └───────────────────────────────┘
```

## Notion Schema Mapping

| Notion Field | Source | Notes |
|--------------|--------|-------|
| Name | AI-extracted | Editable in modal |
| Status | Default | "New" or user's default |
| Assignee | Skip | Left unassigned |
| Ticket Type | AI-extracted | Bug / Feature / Enhancement / Task |
| Priority | AI-extracted | Low / Medium / High / Critical |
| Product Area | User input | Optional text field |
| Description | AI-extracted | Combined summary + steps + video link |

### Description Format in Notion

```markdown
## Summary
[AI-generated description of the issue/request]

## Steps to Reproduce
1. Navigate to...
2. Click on...
3. Observe that...

## Video Reference
[View original recording](https://cap-web-production.../s/xxx)
```

## Database Schema

### New Table: `notionIntegrations`

```typescript
notionIntegrations: {
  id: varchar(255).primaryKey(),
  userId: varchar(255).notNull().references(() => users.id),
  accessToken: text().notNull(),      // encrypted
  workspaceId: varchar(255),          // Notion workspace ID
  workspaceName: varchar(255),        // For display
  databaseId: varchar(255),           // Selected ticket database
  databaseName: varchar(255),         // For display
  createdAt: timestamp(),
  updatedAt: timestamp(),
}
```

## API Routes & Server Actions

### New API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/integrations/notion/auth` | GET | Initiate OAuth redirect |
| `/api/integrations/notion/callback` | GET | Handle OAuth callback, store token |
| `/api/integrations/notion/databases` | GET | List user's Notion databases |

### New Server Actions

| Action | Purpose |
|--------|---------|
| `getNotionConnection()` | Check if user has connected Notion |
| `disconnectNotion()` | Remove token from DB |
| `saveNotionDatabase()` | Save selected database preference |
| `createNotionTicket()` | Main flow: transcribe → extract → create page |

## Frontend Components

### New Files

```
apps/web/
├── app/s/[videoId]/_components/
│   ├── CreateTicketButton.tsx      # Header button
│   ├── CreateTicketModal.tsx       # Review/edit modal
│   └── tabs/Integrations.tsx       # New sidebar tab
│
├── app/(org)/dashboard/settings/
│   └── integrations/
│       └── page.tsx                # Notion connection settings
│
├── components/integrations/
│   ├── NotionConnectButton.tsx     # OAuth trigger
│   └── NotionDatabaseSelect.tsx    # Database picker dropdown
```

### Component Behavior

**CreateTicketButton (header)**
- Shows "Create Ticket" with Notion icon
- If not connected → prompts to connect first
- If connected → triggers transcription + opens modal

**CreateTicketModal**
- Loading state while transcribing/extracting
- Form fields: Title, Type, Priority, Product Area, Description, Steps to Reproduce
- Cancel / Create buttons

**Integrations Tab (sidebar)**
- Shows Notion connection status
- "Create Ticket" button (same functionality as header)

**Settings > Integrations Page**
- Connect/disconnect Notion
- Select default database from dropdown
- Shows current workspace/database names

## Environment Variables

Add to `packages/env/server.ts`:

```typescript
NOTION_CLIENT_ID: z.string(),
NOTION_CLIENT_SECRET: z.string(),
NOTION_REDIRECT_URI: z.string(),
```

### Values for Railway

```
NOTION_CLIENT_ID=<your-notion-client-id>
NOTION_CLIENT_SECRET=<your-notion-client-secret>
NOTION_REDIRECT_URI=https://cap-web-production-d5ac.up.railway.app/api/integrations/notion/callback
```

**Note:** Update redirect URI in Notion integration settings to match.

## AI Extraction Prompt

Single call to extract all fields:

```
You are analyzing a transcript from a screen recording. Extract the following:

1. Title: A concise ticket title (max 80 chars)
2. Type: One of [Bug, Feature, Enhancement, Task]
3. Priority: One of [Low, Medium, High, Critical] based on urgency/severity
4. Description: 2-3 sentence summary of the issue or request
5. Steps to Reproduce: Numbered list of actions (if applicable, otherwise empty)

Transcript:
{transcript}

Respond in JSON format.
```

## Security Considerations

- Notion access tokens encrypted at rest (use existing Cap encryption utils)
- OAuth state parameter to prevent CSRF
- Token refresh handled on API errors
- Users can disconnect integration at any time

## Dependencies

- `@notionhq/client` - Official Notion SDK
- Existing: Deepgram (transcription), OpenAI (extraction)

## Out of Scope (Future)

- Ticket creation history
- Multiple Notion workspaces per user
- Other integrations (Linear, Jira, GitHub)
- Automatic ticket creation (without review modal)
- Bi-directional sync with Notion
