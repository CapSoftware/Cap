# Cap email library

Start with the [catalogue and flow maps](CATALOG.md), [copy guidance](VOICE.md), and [QA results](QA.md). The catalogue includes four Loops journeys, two campaign templates, all 12 marketing emails, customer variations, and the existing Resend application email inventory.

## Where to make changes

| Change                                                          | Source                                         |
| --------------------------------------------------------------- | ---------------------------------------------- |
| Copy, subject, preview and purpose                              | [marketing/](marketing/)                       |
| Logo, colours, spacing, signature, footer, sender and fallbacks | [brand.ts](brand.ts)                           |
| Shared delivery layout                                          | [mjml.ts](mjml.ts)                             |
| Flow ordering, delays and milestone branches                    | [flows.ts](flows.ts)                           |
| Campaign targeting                                              | [campaigns.ts](campaigns.ts)                   |
| Audience guards and contact properties                          | [audiences.ts](audiences.ts)                   |
| Paid-plan welcome variations                                    | [customer-copy.ts](customer-copy.ts)           |
| Application email purposes and send locations                   | [application.ts](application.ts)               |
| Registered Loops resource IDs                                   | [resources.json](resources.json)               |
| Last reviewed upload hashes                                     | [delivery-receipt.json](delivery-receipt.json) |

Each marketing file uses a small shared content vocabulary: Paragraph, Link, Strong, Em and Br. The MJML renderer combines that copy with the shared design. Unsupported new blocks fail export instead of silently disappearing. `scripts/loops/program.ts` is a compatibility export, not another copy source.

The header uses the actual Cap vector artwork from `packages/ui/src/components/icons/Logo.tsx`. `bun run emails:logo` renders its original paths to the checked-in PNG with white backing. This preserves the wordmark and keeps its dark lettering visible on dark backgrounds. Do not rebuild the wordmark with a font or substitute the icon alone. The image and body share the same left edge.

## Edit and upload

From the repository root:

```sh
bun run emails:catalog
bun run emails:check
bun test scripts/emails scripts/loops/profile.test.ts
bun run emails:export --output /absolute/path/to/reviewed-exports
```

The export creates one ZIP and MJML file per email, plus a manifest containing subjects, preview text, sender fields, fallbacks and hashes. Every ZIP contains `index.mjml` and its logo. All copy and design changes start here in source; the generated catalogue is never edited by hand.

In the intended Loops draft, choose **Code → Upload another email → Select**, select its ZIP, and upload. A native email uses **Code → Select** for its first conversion. Review the actual subject, preview text, sender, reply address and every variable fallback against the manifest. Uploading the body does not update these metadata fields automatically. Wait for the logo to load, inspect all copy and links, confirm one footer, and verify the email remains a draft.

Keep `capGreeting` as a complete salutation with `Hey,` as its fallback. Profile sync supplies `Hey Richie,` only when a nonblank name is known. Previously imported contacts need an approved profile refresh before their new greeting property is populated; until then the fallback applies. Changes to `customer-copy.ts` also require a profile refresh and do not instantly change stored Loops properties.

## Verification boundaries

With `LOOPS_API_KEY` supplied through the environment:

```sh
bun run emails:check-loops --structure-only
```

This read-only command checks the team, mailing list, draft statuses, workflow graphs, downstream audience guards, branch reconnections, delays, campaign targeting and custom email format. Loops' beta API returns HTTP 409 for reading or updating custom MJML emails, so their contents and Guardian results require browser review. Running without `--structure-only` deliberately fails when content cannot be verified; it never treats an unreadable email as a content match.

The historical upload receipt records the local export hashes reviewed in the browser. It is not live drift detection. Reconcile intentional dashboard edits into source before uploading replacements. Do not switch back to native format to bypass the API limitation: native footers reintroduce the automatic opt-in explanation. The legacy provisioner refuses `--apply` while custom MJML delivery is configured.

Local commands and read-only checks never send or enroll contacts. Preview sends require the user's sending scope; this migration's QA used only owned Cap inboxes. Production activation remains a separate cutover action.

## Adding emails and flows

1. Add `marketing/<stable-id>.ts` implementing `EmailDefinition`. Declare every variable and a suitable shared fallback.
2. Register the email in `flows.ts` or `campaigns.ts`. Preserve existing IDs and step keys because resource receipts refer to them.
3. Regenerate the catalogue. Check consent, customer and teammate exclusions, downstream guards, milestone behavior and re-entry rules.
4. Create the intended draft graph through the supported migration tooling, then upload the generated custom email and record its resource IDs. The existing provisioner is guarded against overwriting the custom programme; extending graphs needs a scoped implementation.
5. Run the local and graph checks, inspect each changed render, then commit definitions and generated catalogue together.

Resend application templates stay under `packages/database/emails/`; the inventory links to them without duplicating their content. Their sending behavior and layout are unchanged. Loops marketing guards do not control Resend, and the first-recording email needs an overlap check before lifecycle activation.

Keep credentials, contacts, suppression hashes and exports outside Git. The [migration runbook](../scripts/loops/README.md) owns imports, suppression seeding, production integration and cutover.
