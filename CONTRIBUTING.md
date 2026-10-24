# Contributing to streamgive-backend

Thanks for your interest in contributing! This guide covers everything you need
to get the backend running locally, run the test suite, and open a pull request.

For the full, project-wide contribution guide (code style, branch naming, PR
process, and more) see the
[StreamGive documentation site](https://github.com/streamgive/streamgive-docs).

---

## Prerequisites

- **Node.js** ≥ 20
- **Docker** and **Docker Compose** (for the Postgres container)

---

## Local setup

```bash
# 1. Copy the environment templates
cp .env.example .env

# 2. Start the Postgres container (also creates the streamgive_test database)
docker compose up -d postgres

# 3. Install dependencies
npm install

# 4. Apply Prisma migrations to the development database
npm run db:deploy

# 5. (Optional) Seed sample NGOs, donors and streams
npm run db:seed          # uses upserts, safe to run more than once

# 6. Start the dev server
npm run dev
```

To run the whole stack containerised instead:

```bash
docker compose up --build
```

---

## Running the test suite

The integration tests run against a separate `streamgive_test` database that is
created automatically by the Docker Compose `postgres` service (the same
`docker compose up -d postgres` command from the local setup above).

```bash
cp .env.test.example .env.test
npm run db:deploy:test   # apply migrations onto streamgive_test
npm test
```

---

## Before opening a pull request

```bash
npm run lint
npm run typecheck
npm test
```

All three must pass with no errors. Then open a PR against `main` and link the
relevant issue.