# Contributing

## License

This repo is licensed under the **PolyForm Noncommercial License 1.0.0**. The full
text is in [`LICENSE`](LICENSE) at the repo root.

What that permits: read it, run it, modify it, and share it (including your
modified versions) for any noncommercial purpose. Personal study, hobby projects,
research, teaching, and use by schools, charities, public research bodies and
government all count as noncommercial.

What it does not permit: commercial use of any kind. If you want to use Flock, or
anything derived from it, in a commercial product or service, that needs a
separate agreement. Email social@flockcorp.com.

Pull requests are welcome and are accepted under these same terms: by opening one
you agree your contribution is licensed under PolyForm Noncommercial 1.0.0, and
that the maintainer may also license the project (including your contribution)
commercially.

Anyone you hand a copy to has to get these terms, or the URL for them, along with
the `Required Notice:` line at the top of `LICENSE`. The Notices section is what
requires all of it to travel with the software.

## Running the test suites

Backend (Node's built-in test runner; several migration suites start their own
throwaway Postgres through `embedded-postgres`, so you do not have to provide
one):

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

See the "Running it" section of `README.md`. Copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env`, then fill them in; each variable's comment says what breaks without it.
