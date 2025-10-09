# Apps Package Overview

This workspace package contains the shared plumbing for Cap's integration modules. When you add a new app, prefer the helpers in `src/core` so each module stays lightweight and focused on provider-specific behaviour.

## Key helpers

- `createAppModuleContext(import.meta.url)` caches the module's app type and environment once, avoiding per-file boilerplate.
- `ensureOrganisationOwner(policy, organisationId)` (and `ensureOrganisationMember`) convert policy denials into `HttpApiError.Forbidden` responses.
- `createOAuthSessionManager({ stateCookie, verifierCookie, maxAgeSeconds })` handles setting, reading, and clearing the state + PKCE verifier cookies.
- `generatePkcePair()` returns a `{ codeVerifier, codeChallenge }` tuple for PKCE-enabled flows.

## Building a new OAuth app

1. Create a directory under `src/<app-name>` with `config.json` and `install.ts`.
2. Import the helpers above in `install.ts` instead of re-implementing caching, cookie handling, or PKCE logic.
3. Use `HttpServerResponse.json(...)` combined with `sessionManager.store(...)` to emit the authorization URL and persist cookies.
4. In the callback handler, call `sessionManager.read()` to validate state, then `sessionManager.clear(...)` once the install completes.
5. Register any provider-specific operations (dispatch, list destinations, etc.) while reusing `createAppHandlerError` for consistent error shaping.