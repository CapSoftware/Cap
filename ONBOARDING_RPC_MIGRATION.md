# Onboarding API to RPC Migration Summary

## Overview
Successfully migrated all onboarding API endpoints from Next.js API routes to Effect RPC mutations.

## Changes Made

### 1. Domain Layer (`packages/web-domain/src/Onboarding.ts`)
Created a single **UserCompleteOnboardingStep** RPC with discriminated union payload:

**Payload Schema** (`OnboardingStepPayload`):
- `{ step: "welcome", data: { firstName, lastName? } }`
- `{ step: "organizationSetup", data: { organizationName, organizationIcon? } }`
- `{ step: "customDomain", data: void }`
- `{ step: "inviteTeam", data: void }`

**Result Schema** (`OnboardingStepResult`):
- `{ step: "welcome", data: void }`
- `{ step: "organizationSetup", data: { organizationId } }`
- `{ step: "customDomain", data: void }`
- `{ step: "inviteTeam", data: void }`

Benefits of single RPC approach:
- Cleaner API surface with one endpoint instead of four
- Type-safe discriminated unions ensure correct payload per step
- Easier to extend with new onboarding steps
- Uses `RpcAuthMiddleware` for authentication
- Returns `InternalError` on failure

### 2. Backend Service (`packages/web-backend/src/Onboarding/`)

#### `index.ts` - OnboardingService
Domain service with business logic:
- Queries database for full user object (to access `onboardingSteps`)
- Uses `CurrentUser` from auth middleware for user ID
- Handles S3 uploads gracefully (logs errors but doesn't fail onboarding)
- Uses Effect Config for environment variables instead of `@cap/env`

#### `OnboardingRpcs.ts` - RPC Layer
Maps single `UserCompleteOnboardingStep` RPC to appropriate service method:
- Uses switch statement on `payload.step` to route to correct service method
- Catches `DatabaseError` and converts to `InternalError`
- Returns correctly typed result based on step

### 3. Client Components (`apps/web/app/(org)/onboarding/components/`)

Updated all four step components to use single `UserCompleteOnboardingStep` RPC:
- **WelcomePage.tsx** - Calls with `{ step: "welcome", data: { firstName, lastName } }`
- **OrganizationSetupPage.tsx** - Calls with `{ step: "organizationSetup", data: { organizationName, organizationIcon? } }`
- **CustomDomainPage.tsx** - Calls with `{ step: "customDomain", data: undefined }`
- **InviteTeamPage.tsx** - Calls with `{ step: "inviteTeam", data: undefined }`

All components:
- Use `useEffectMutation` from `@/lib/EffectRuntime`
- Use `withRpc` helper to access RPC client
- Handle file uploads by converting File to Uint8Array
- Show loading states and handle errors appropriately

### 4. Integration
- Added `OnboardingRpcs` to `packages/web-domain/src/Rpcs.ts`
- Added `OnboardingRpcsLive` to `packages/web-backend/src/Rpcs.ts`
- Exported `Onboarding` namespace in `packages/web-domain/src/index.ts`

## Old API Routes (Can be removed)
The following API routes are now obsolete:
- `/apps/web/app/api/settings/onboarding/welcome/route.ts`
- `/apps/web/app/api/settings/onboarding/org-setup/route.ts`
- `/apps/web/app/api/settings/onboarding/custom-domain/route.ts`
- `/apps/web/app/api/settings/onboarding/invite-your-team/route.ts`
- `/apps/web/app/api/settings/onboarding/complete/route.ts` (if exists)

## Benefits
1. **Type Safety** - Full end-to-end type safety from client to server with discriminated unions
2. **Single Endpoint** - One RPC instead of four separate endpoints, simpler API surface
3. **Consistency** - Follows established RPC pattern used by Videos, Folders, etc.
4. **Error Handling** - Standardized error handling with Effect
5. **Testability** - Service layer can be tested independently
6. **Maintainability** - Clear separation of concerns (domain, service, RPC, client)
7. **Extensibility** - Easy to add new onboarding steps by extending the union types

## Testing
To test the changes:
1. Run `pnpm dev:web`
2. Navigate to `/onboarding/welcome`
3. Complete each onboarding step
4. Verify data is saved correctly in the database
5. Check organization icon uploads to S3

## Notes
- Organization icon upload errors are logged but don't fail the onboarding process
- All onboarding steps update the user's `onboardingSteps` object progressively
- The invite team step also sets `onboarding_completed_at` timestamp

