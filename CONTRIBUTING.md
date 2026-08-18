# Contributing

## The license situation, first

This repo does not have a license file yet. Until one lands, all rights are reserved and **pull requests cannot be merged**, because there is no legal basis for accepting outside code. Feel free to read, run it locally, and open issues. Once a LICENSE file exists this section will be replaced.

## Running the test suites

Backend (Node's built-in test runner, no database needed for the unit suites):

```bash
cd backend
NODE_ENV=test npm test
```

Frontend (jest via react-scripts):

```bash
cd frontend
CI=true npx react-scripts test --watchAll=false
```

Both suites are expected to pass before any change is proposed. Many tests pin repo docs and copy on purpose; if a doc test fails, read the test's comment before editing either side. The test usually says which one is the source of truth.

## Design and copy rules

`SLOP-AUDIT.md` is the standing design and copy standard, and it binds every PR that touches UI or user-visible text. The short version: no em dashes in user-visible text, no gradient-and-badge landing page patterns, no copy that claims a feature the shipping build does not have. Several tests enforce these rules mechanically, so a violation usually fails the suite anyway.

## Setup

See the "Running it" section of `README.md`. Copy `backend/.env.example` to `backend/.env` and fill it in; each variable's comment says what breaks without it.
