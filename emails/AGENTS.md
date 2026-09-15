# Working on Cap emails

- Start with `README.md`, `CATALOG.md` and `VOICE.md`. Use the catalogue to identify the email, flow, audience and actual send source before editing.
- Keep marketing content in `marketing/`, branding and sender defaults in `brand.ts`, customer-specific prose in `customer-copy.ts`, and ordering/delays in `flows.ts`. Do not add another copy of these definitions under `scripts/`.
- Keep email IDs and existing flow step keys stable. Declare variables and provide appropriate fallbacks. Preserve opt-outs, teammate exclusions, customer segmentation and imported-contact holds.
- Delivery uses custom MJML from `mjml.ts`. Generate archives with `bun run emails:export --output /absolute/path`, then upload the intended archive through Code in the Loops draft editor. The Loops API cannot read or update MJML emails; do not convert them back to native format to bypass this limitation. Reconcile intentional dashboard edits into source first.
- Regenerate `CATALOG.md` using `bun run emails:catalog`; never edit it by hand. Run `bun run emails:check`, scoped Biome, and relevant tests. After a remote draft update, run `bun run emails:check-loops --structure-only` and review every changed email in the browser, including metadata, variable fallbacks, loaded images and footer. API structure checks cannot establish MJML content parity.
- Keep the canonical Cap icon and vector wordmark together; never recreate the lettering with a font. Use `capGreeting` with `Hey,` as the complete fallback; never concatenate a space with an optional first name. Preserve the single address/unsubscribe footer without an opt-in explanation.
- Keep Resend application templates and sending behavior in their current locations; update `application.ts` when introducing or removing a send path. Listing a template does not establish that its handler is reachable or deployed.
- These commands do not authorize sending, publishing, activating flows, enrolling contacts or deploying production schema. Follow the user's current scope.
- Store only nonsecret resource IDs here. Keep credentials, contact exports and suppression registries outside Git.
