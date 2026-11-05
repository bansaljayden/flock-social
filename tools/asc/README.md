# asc

App Store Connect from the command line: the listing, the screenshots, review
submissions and builds for this app. Plain Node 18 or later (the global
`fetch`, and `node:crypto` for the ES256 token through `../asc-upload/lib.mjs`),
no packages.

## Credentials

Set `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_APP_ID`, or keep the
same four in a JSON file outside the repository:

    { "keyPath": ".../AuthKey_XXXXXXXXXX.p8", "keyId": "...", "issuerId": "...", "appId": "..." }

The file is `--config <file>`, else `ASC_CONFIG`, else
`~/OneDrive/Documents/Flock/Apple-Review/asc-config.json`. Each environment
variable beats the file's value. No line the tool prints carries the key or the
three ids: they show as `{keyId}`, `{issuerId}` and `{appId}`.

## Commands

Read only:

    node tools/asc/asc.mjs status
    node tools/asc/asc.mjs metadata get [--version 1.0.1] [--locale en-US] [--json]
    node tools/asc/asc.mjs screenshots list [--version 1.0.1]
    node tools/asc/asc.mjs screenshots backup --version 1.0.1 --out <folder>
    node tools/asc/asc.mjs builds list [--limit 10]

Writes:

    node tools/asc/asc.mjs metadata set --version 1.0.1 --whats-new-file notes.txt
    node tools/asc/asc.mjs screenshots replace --dir <folder> --version 1.0.1 [--display-type APP_IPHONE_67]
    node tools/asc/asc.mjs review cancel --version 1.0.1
    node tools/asc/asc.mjs review submit --version 1.0.1

Every write prints its exact calls first. `--dry-run` stops there. Without
`--yes` it also stops there, and exits 4; nothing is ever asked interactively.

Exit codes: 0 done, 1 an API call failed, 2 usage or configuration, 3 refused
before any write (a check failed, nothing changed), 4 not confirmed.

`metadata set` takes `--name`, `--subtitle`, `--promotional-text`,
`--description`, `--keywords`, `--whats-new`, `--support-url` and
`--marketing-url`, each also as `--<field>-file <path>`, or `--from-json` with
the output of `metadata get --json`. Name and subtitle are written to the app
info that goes with the version, the rest to the version's localization. Only
fields that change are sent, each is held to Apple's limit first, and only
promotional text may change while the version is not editable.

## screenshots replace

- The folder's numbered images (`01-name.png`, `02-name.png`, PNG or JPEG) are
  the new set, in filename order. Anything else in it, such as a contact sheet,
  is ignored. At most ten.
- Before any call, each file is checked against Apple's pixel sizes for the
  display type (`APP_IPHONE_67`: 1260x2736, 1290x2796 or 1320x2868, or the
  landscape transpose) and refused if it has an alpha channel.
- Every localization of the version is replaced unless `--locale` narrows it.
- Each file is reserved, sent, committed with its MD5 and checked until Apple
  reports COMPLETE. The old screenshots are deleted only after every new one,
  in every set, is COMPLETE; then each set is put in filename order and read
  back. A file already in the set with the same name and MD5 is kept, so a run
  that stopped part way resumes.
- Apple refuses an eleventh screenshot in a set. When the old ones leave too
  little room, the run is refused unless `--make-room` is given: then it first
  saves every old screenshot at full size to `--backup-dir` (default: a folder
  beside `--dir`), deletes only as many as the cap forces out, uploads, and
  deletes the rest after the new ones are COMPLETE. Running `screenshots
  replace` on that backup folder puts the old set back.
- The version must be editable: Prepare for Submission, Developer Rejected,
  Rejected or Metadata Rejected.

## review cancel, review submit

- `review cancel` finds the review submission that carries the version while
  it is Waiting for Review, In Review or has unresolved issues, sends
  `canceled: true`, and waits for the version to become editable. Apple's help
  says the version becomes Developer Rejected, and a resubmission starts the
  review over.
- `review submit` checks that the version can be submitted, that a VALID build
  with an export compliance answer is attached, that every screenshot is
  COMPLETE and that no other submission is open (one still CANCELING blocks a
  new one). Then it reuses a draft submission or creates one, adds the version
  and submits it. It never writes the release type.

## Tests

    node --test tools/asc/asc.test.mjs

Offline: a fake App Store Connect answers every call.
