# Contributing

## License

This repo is licensed under the **MIT License**. The full text is in
[`LICENSE`](LICENSE) at the repo root.

You may use, copy, modify, merge, publish, distribute, sublicense and sell copies
of it, for any purpose, commercial included. The one condition is that the
copyright notice and the permission notice in `LICENSE` travel with every copy or
substantial portion of the software. The software comes without warranty.

Pull requests are welcome and are accepted under the same terms: by opening one
you agree your contribution is licensed under the MIT License.

The repo was published under PolyForm Noncommercial 1.0.0 from 2026-08-18 to
2026-09-23. Copies taken in that window carry those terms; everything from this
commit on is MIT.

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

Both suites are expected to pass before any change is proposed, and since 2026-08-26 that is enforced rather than trusted: `.github/workflows/tests.yml` runs both on every push. Read its header before assuming a green local run means a green CI run. It pins Node 20 on purpose, and the first time it ran it failed 52 backend checks on a commit that was green on the developer machine, none of them a regression: Node 21 and later keep a referenced handle alive for the duration of a running test, so a test awaiting a promise that only an `unref()`d timer can settle completes, while Node 20 drains the loop and cancels the rest of the file. `npm audit` runs in the same workflow and reports rather than gates; the reason is written out there.

Many tests pin repo docs and copy on purpose; if a doc test fails, read the test's comment before editing either side. The test usually says which one is the source of truth.

## Design and copy rules

`DESIGN-STANDARD.md` is the standing design and copy standard, and it binds every PR that touches UI or user-visible text. The short version: no em dashes in user-visible text, no gradient-and-badge landing page patterns, no copy that claims a feature the shipping build does not have. Several tests enforce these rules mechanically, so a violation usually fails the suite anyway.

## Setup

See the "Running it" section of `README.md`. Copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env`, then fill them in; each variable's comment says what breaks without it.
