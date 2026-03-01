Create a PostgreSQL migration for: $ARGUMENTS

Rules:
- Write as idempotent SQL (CREATE TABLE IF NOT EXISTS, DO $ blocks for conditional adds)
- Add the migration to the startup sequence in server.js where other migrations run
- Reference existing tables from the schema in CLAUDE.md — check foreign keys are valid
- Use UUID with gen_random_uuid() for primary keys on core entities
- Use SERIAL for junction tables, log tables, and simple auto-increment cases
- Use TIMESTAMPTZ (not TIMESTAMP) for all timestamp columns
- Include DEFAULT NOW() on created_at columns
- Add UNIQUE constraints where noted in the schema spec
- Add ON DELETE CASCADE or ON DELETE SET NULL on foreign keys (match existing patterns)
- Add indexes on foreign key columns and any column used in WHERE clauses frequently
- Add appropriate CHECK constraints for enum-like VARCHAR columns
- Test that the migration is safe to run multiple times without error
