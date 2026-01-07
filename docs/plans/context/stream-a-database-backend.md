# Stream A: Database & Backend Context

**Workstream:** Database schema, migrations, and server actions for Notion integration

**Dependencies:** None - can start immediately

**Prerequisites:** Clone the repo, have database access

---

## Key Files to Understand

### Environment Configuration
- `packages/env/server.ts` - Where to add new env vars (NOTION_CLIENT_ID, etc.)
- Pattern: Use `z.string().optional()` for optional integration configs

### Database Schema
- `packages/database/schema.ts` - Main schema file (~770 lines)
- Uses Drizzle ORM with MySQL
- Key patterns:
  - `nanoId("id")` for primary keys (15 char)
  - `encryptedText` custom type for sensitive data
  - Relations defined separately via `relations()`

### Crypto Utilities
- `packages/database/crypto.ts` - `encrypt()` and `decrypt()` functions
- Uses AES-GCM with PBKDF2 key derivation
- Requires `DATABASE_ENCRYPTION_KEY` env var

### Server Actions Pattern
- Location: `apps/web/actions/`
- Pattern:
```typescript
"use server";
import { getCurrentUser } from "@cap/database/auth/session";

export async function myAction() {
  const user = await getCurrentUser();
  if (!user) return { success: false, error: "Unauthorized" };
  // ... logic
  return { success: true, data: ... };
}
```

---

## Tasks in This Stream

1. **A1:** Add Notion env vars to `packages/env/server.ts`
2. **A2:** Create `notionIntegrations` table in schema
3. **A3:** Generate and run database migration
4. **A4:** Create Notion server actions in `apps/web/actions/integrations/notion.ts`

---

## Schema to Create

```typescript
export const notionIntegrations = mysqlTable(
  "notion_integrations",
  {
    id: nanoId("id").notNull().primaryKey(),
    userId: nanoId("userId").notNull().$type<User.UserId>(),
    accessToken: encryptedText("accessToken").notNull(),
    workspaceId: varchar("workspaceId", { length: 255 }),
    workspaceName: varchar("workspaceName", { length: 255 }),
    workspaceIcon: varchar("workspaceIcon", { length: 1024 }),
    databaseId: varchar("databaseId", { length: 255 }),
    databaseName: varchar("databaseName", { length: 255 }),
    botId: varchar("botId", { length: 255 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdIndex: uniqueIndex("user_id_idx").on(table.userId),
  }),
);
```

---

## Commands

```bash
# Generate migration
cd packages/database && pnpm drizzle-kit generate

# Run migration
pnpm drizzle-kit migrate

# Type check
cd apps/web && pnpm tsc --noEmit
```

---

## Handoff to Stream B

Stream B (OAuth) depends on:
- `notionIntegrations` table existing
- `packages/database/crypto.ts` encrypt/decrypt functions

Provide: Schema created, migration run, server actions available
