# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: go to the **Security** tab of <https://github.com/bansaljayden/flock-social>, click **Report a vulnerability**, and write it up there. The report is visible only to you and to the maintainer, and it keeps the whole conversation, including the fix, in one thread. If you would rather not use GitHub, email **social@flockcorp.com** with the subject line "Security" instead.

Either way, include what you found, where it is (a route, a file, a URL), and steps to reproduce it. A proof-of-concept helps; exploiting real user data does not, so please stop at the point where the problem is demonstrated.

Please do not open a public GitHub issue for a security problem. That publishes the bug before it is fixed, which is the one thing private reporting exists to avoid.

## What to expect

Flock is run by one person. You will get a human reply, usually within a few days, and a fix as fast as one person can ship one. Serious issues (auth bypass, another user's data readable, anything touching minors' data) go to the front of the line.

There is no bug bounty. There is no budget for one. Credit in the fix commit is yours if you want it.

## Scope

- The code in this repo: the backend API, the web app, the marketing site.
- The deployed app at flockcorp.com and its API.
- The iOS build, which is that same web bundle inside a Capacitor shell.

Out of scope: denial of service by volume, reports from automated scanners with no working reproduction, and anything that requires physical access to someone's phone.
