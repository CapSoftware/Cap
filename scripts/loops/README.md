# Loops profile sync

This folder holds the tests and manual runners for the Loops profile sync in [`packages/database/loops/`](../../packages/database/loops/), which the web app runs from `/api/cron/sync-loops`.

- `bun scripts/loops/seed.ts` reports how many completed signups would be queued; `--apply` queues them.
- `bun scripts/loops/sync.ts --apply` processes a bounded batch with the same worker as the cron route.

Marketing and lifecycle email content, Loops journeys and campaigns, the email catalogue, the provisioning and verification tooling, and the delivery watchdog live in the private repo [CapSoftware/cap-marketing](https://github.com/CapSoftware/cap-marketing). View and edit them there.
