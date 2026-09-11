# Working on Cap emails

- Start with `README.md` and `CATALOG.md`. Use the catalogue to identify the email, flow, audience and actual send source before editing.
- Keep marketing content in `marketing/`, branding and sender defaults in `brand.ts`, customer-specific prose in `customer-copy.ts`, and ordering/delays in `flows.ts`. Do not add another copy of these definitions under `scripts/`.
- Keep email IDs and existing flow step keys stable. Declare variables and provide appropriate fallbacks. Preserve opt-outs, teammate exclusions, customer segmentation and imported-contact holds.
- Reconcile dashboard edits into source before updating Loops drafts. Use the current content revision for API updates. Version shared branding before changing resources used by live emails.
- Regenerate `CATALOG.md` using `bun run emails:catalog`; never edit it by hand. Run `bun run emails:check`, scoped Biome, and relevant tests. After a remote draft update, run `bun run emails:check-loops` and inspect the rendered email.
- Keep Resend application templates and sending behavior in their current locations; update `application.ts` when introducing or removing a send path. Listing a template does not establish that its handler is reachable or deployed.
- These commands do not authorize sending, publishing, activating flows, enrolling contacts or deploying production schema. Follow the user's current scope.
- Store only nonsecret resource IDs here. Keep credentials, contact exports and suppression registries outside Git.
