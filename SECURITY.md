# Security

## Reporting a vulnerability

Email **social@flockcorp.com** with the subject line "Security". Include what you found, where it is (a route, a file, a URL), and steps to reproduce it. A proof-of-concept helps; exploiting real user data does not, so please stop at the point where the problem is demonstrated.

Please do not open a public GitHub issue for a security problem. That publishes the bug before it is fixed.

## What to expect

Flock is run by one person. You will get a human reply, usually within a few days, and a fix as fast as one person can ship one. Serious issues (auth bypass, another user's data readable, anything touching minors' data) go to the front of the line.

There is no bug bounty. There is no budget for one. Credit in the fix commit is yours if you want it.

## Scope

- The code in this repo: the backend API, the web app, the marketing site.
- The deployed app at flockcorp.com and its API.

Out of scope: denial of service by volume, reports from automated scanners with no working reproduction, and anything that requires physical access to someone's phone.
