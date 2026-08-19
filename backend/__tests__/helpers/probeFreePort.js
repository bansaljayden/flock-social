'use strict';
// ---------------------------------------------------------------------------
// A bind-probe that runs as its own process.
//
// It exists only so the parent can ask "is this port free?" SYNCHRONOUSLY, via
// child_process.spawnSync. Binding a socket is inherently async in Node, and the
// suites that need the answer need it at module scope — before their requires of
// scripts/ml/*, which read DATABASE_URL at require time. A child process is the
// one way to block on an async answer without an await.
//
// argv: <base> <span> <start>
// Walks the half-open range [base, base+span) beginning at `start` and wrapping,
// prints the first port it can exclusively bind on 127.0.0.1, and exits 0.
// Exits 1 if every port in the range is taken.
//
// `exclusive: true` matters: without it a listen can succeed alongside another
// listener on some platforms, which would make the probe report a squatted port
// as free — exactly the failure this whole helper exists to prevent.
// ---------------------------------------------------------------------------
const net = require('node:net');

const base = Number(process.argv[2]);
const span = Number(process.argv[3]);
const start = Number(process.argv[4]);

function tryBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

(async () => {
  for (let i = 0; i < span; i += 1) {
    const port = base + (((start - base) + i) % span);
    // eslint-disable-next-line no-await-in-loop
    if (await tryBind(port)) {
      process.stdout.write(String(port));
      process.exit(0);
    }
  }
  process.exit(1);
})();
