# Organization-only sharing walkthrough

The recipe uses an isolated development database, synthetic accounts, and a local read-only media fixture. The fixture server serves generated demonstration media only. No production storage, email, billing, or processing services are configured.

Acceptance criteria:

- Owners and admins can enable organization-only access from organization preferences; members cannot change it.
- An existing public recording becomes inaccessible to signed-out viewers.
- An existing private recording becomes inaccessible to an invited outsider.
- Organization members can view and play existing private recordings.
- Recordings created through the recording API while the lock is enabled are also organization-only.
- Playback, thumbnails, animated previews, public collections, and rich-link metadata do not expose locked recordings to outsiders.
- Public and private settings are preserved and restored when the lock is disabled.
- Individual sharing controls explain the enforced organization policy.

The browser walkthrough asserts the main flow and playback. Focused policy tests also cover passwords, external organization and space memberships, former owners, role restrictions, and invalid action inputs. The seed verifies the SQL access predicate against the isolated database.

Apply the generated additive organization column before deploying application code. Existing organizations default to unrestricted sharing. Downloaded copies and already-issued temporary media URLs cannot be recalled.
