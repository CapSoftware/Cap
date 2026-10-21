# Migrating from MySQL to PostgreSQL

Cap now stores its data in PostgreSQL. The schema starts from a fresh baseline
migration (`packages/database/migrations/0000_postgres_baseline.sql`), so a MySQL
database cannot be upgraded in place. Use `scripts/mysql-to-postgres.mjs` to copy
your data across.

New installs do not need any of this.

## What changes for operators

- `DATABASE_URL` must be a `postgres://` (or `postgresql://`) URL.
- The bundled compose files run `postgres:16-alpine` instead of MySQL. The password
  variable is now `POSTGRES_PASSWORD` (Coolify: `SERVICE_PASSWORD_POSTGRES`) and the
  MySQL root password is gone.
- Migrations still run automatically when `cap-web` starts.

## Migrating existing data

1. **Back up MySQL.**

   ```bash
   docker compose exec mysql mysqldump -ucap -p"$MYSQL_PASSWORD" cap > cap-mysql-backup.sql
   ```

2. **Stop writes.** Stop `cap-web` so nothing changes while you copy.

3. **Start PostgreSQL and create the schema.** Update to the new compose file, keeping
   the old MySQL service available under a temporary name so you can read from it. Start
   the new stack once so `cap-web` applies the migrations, then stop `cap-web` again.
   The target database must be empty apart from the schema.

4. **Copy the data.** The script needs `mysql2` and `pg`, which `bun install` provides
   in a repository checkout.

   ```bash
   bun install
   node scripts/mysql-to-postgres.mjs \
     --mysql mysql://cap:YOUR_MYSQL_PASSWORD@localhost:3306/cap \
     --postgres postgres://cap:YOUR_POSTGRES_PASSWORD@localhost:5432/cap \
     --dry-run
   ```

   Re-run without `--dry-run` to copy. Each table is copied in its own transaction in
   foreign-key order, and its row count is compared with MySQL before the transaction
   commits. A failure rolls back that table and stops. If the target already has rows,
   pass `--truncate` to replace them.

   The script converts `tinyint(1)` to booleans, `JSON` to `jsonb`, keeps `bigint`
   values exact, and skips the generated `videos.effectiveCreatedAt` column, which
   PostgreSQL recomputes. It also lowercases stored email addresses (users, invites,
   viewer grants and sign-in tokens), because Cap looks emails up in lowercase and
   MySQL used to match them regardless of case.

5. **Start Cap.** Start `cap-web` and check that you can sign in and open a Cap. Once
   you are happy, remove the MySQL service and its volume.

If you run the script from inside Docker, attach it to the compose network (for example
`docker run --rm --network cap_cap-network -v "$PWD":/work -w /work node:22 ...`) and use
the service names `mysql` and `postgres` as hosts.

## Behavior differences to be aware of

- **Case sensitivity.** MySQL's default collation compared strings case-insensitively;
  PostgreSQL does not. Cap lowercases email addresses before storing and looking them
  up, and the dashboard and API search use `ILIKE`, but queries you add yourself need
  the same care.
- **`updatedAt`.** MySQL refreshed `updatedAt` columns itself on every `UPDATE`.
  Cap now sets them from the application, so a hand-written `UPDATE` in `psql` will not
  bump `updatedAt` unless it sets the value.
- **Timestamps.** Timestamp columns are `timestamp(3)` without a time zone and always
  hold UTC.
- **Counts and sums.** Raw `COUNT(*)` and `SUM(...)` values are returned as numbers, as
  they were with MySQL.
