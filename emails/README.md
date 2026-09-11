# Cap email library

Start with the [email catalogue and flow maps](CATALOG.md). It contains all four Loops journeys, two campaign templates, every marketing email's copy, customer variations, and the existing Resend application email inventory. The catalogue is generated from the same definitions used by the migration tooling.

## Where to make changes

| Change                                                                | Source                               |
| --------------------------------------------------------------------- | ------------------------------------ |
| See all flows, timing and email copy                                  | [CATALOG.md](CATALOG.md)             |
| Colours, typography, buttons, header, signature, sender and fallbacks | [brand.ts](brand.ts)                 |
| Subject, preview, body and purpose of one marketing email             | [marketing/](marketing/)             |
| Flow order, relative delays and milestone branches                    | [flows.ts](flows.ts)                 |
| Campaign definitions and targeting                                    | [campaigns.ts](campaigns.ts)         |
| Shared audience filter rules and contact property names               | [audiences.ts](audiences.ts)         |
| Paid-plan names and customer welcome variations                       | [customer-copy.ts](customer-copy.ts) |
| Existing application email purposes, triggers and send locations      | [application.ts](application.ts)     |
| Nonsecret Loops resource and node IDs                                 | [resources.json](resources.json)     |

Marketing copy belongs here. `scripts/loops/program.ts` is a compatibility export, not another source to edit. Each marketing file holds its subject, preview, purpose, declared variables and LMX body. Paragraphs are separate strings joined without changing the resulting email. Shared branding is composed around each body by `emailContent()`.

Application emails keep their existing React Email templates under `packages/database/emails/`. This index links to those sources; it does not duplicate their templates or change their provider. Loops audience filters and marketing branding do not automatically apply to Resend sends.

## Edit and inspect locally

From the repository root:

```sh
bun run emails:catalog
bun run emails:check
bun test scripts/emails scripts/loops/profile.test.ts
```

`emails:catalog` rebuilds the readable catalogue and Mermaid diagrams. `emails:check` is offline: it checks catalogue freshness, duplicate/missing email files, declared variables and fallbacks, shared branding use, delays, and the application template/send-source inventory. It does not replace Loops' LMX compiler, Guardian or a rendered preview.

Flow delays are relative to the previous step. The catalogue computes cumulative day numbers automatically. A skipped milestone reminder rejoins the flow and still observes the subsequent delay. The first-recording Resend email is also listed so future changes can account for overlap.

## Compare with Loops

Provide `LOOPS_API_KEY` in the process environment, then run:

```sh
bun run emails:check-loops
```

This command only reads Loops. It checks the expected team, registered resource IDs, draft status, workflow graph, downstream audience guards, branch reconnections, delays, campaign audiences, configured theme styles, shared components, message content, sender fields, fallbacks and Guardian results. It reports a failure when local and remote content differ. Live status is not embedded in the generated catalogue.

Dashboard edits must be reconciled into the local source before updating a managed draft. Read the current email and its `contentRevisionId`, compare it with the proposed local content, and preserve intentional dashboard changes. Updates must include `expectedRevisionId` so an intervening edit causes a conflict. The older provisioner uses a resumable migration receipt and is not a two-way editor or a replacement for this comparison.

Use the official Loops API/LMX skills for draft changes. Review the local diff, update only the intended drafts, run the read-only check again, and inspect the Loops render. Do not send a test or preview email as part of local validation. Sending and workflow activation remain separate actions.

## Branding changes

All marketing messages inherit one theme and shared header/signature components. Keep brand styling in `brand.ts`; individual messages should contain content and layout, not copied colours, fonts or logos.

Shared Loops theme/component updates can affect every email using them. Create a new named branding version for a redesign, attach it to reviewed drafts, then verify the rendered result. The provisioner refuses to silently reuse a same-named theme/component whose content differs. Retain the previous version while any live email uses it.

Changing `customer-copy.ts` changes the copy produced by profile sync; it does not instantly rewrite contact properties already stored in Loops. Review and refresh the intended profiles separately.

## Add an email or flow

1. Add one `marketing/<stable-id>.ts` file implementing `EmailDefinition`; use the same ID as its filename.
2. Declare every contact variable used in the subject, preview and body. Add an appropriate shared fallback and contact property contract when needed. Current journeys use contact-property triggers; event variables need an explicit event-trigger design first.
3. Register it in `flows.ts` or `campaigns.ts`. Keep existing step keys stable because migration receipts identify nodes by these keys.
4. Regenerate and review the catalogue. For a new flow, verify consent, customers, teammate exclusions, downstream guards and re-entry behavior.
5. Create or update the intended Loops draft using the migration/API tooling and record verified resource/node IDs in `resources.json`. Workflow graph editing currently uses the migration beta integration; content checks do not grant activation permission.
6. Run local and remote checks, inspect the render, and commit the source and regenerated catalogue together.

Never add exports, subscriber records, consent hashes or credentials to this directory. The [migration runbook](../scripts/loops/README.md) owns imports, consent seeding, live sync and cutover requirements. No local library command enrolls contacts or sends emails.
