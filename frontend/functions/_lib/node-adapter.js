// Runs one of the (req, res) handlers in api/ unchanged and resolves with a
// Web Response, so the files Vercel ran keep running here and their own tests
// keep holding them. It implements exactly the res surface those files use:
// statusCode, setHeader, getHeader, end, and status().json() (the
// app-site-association handler).
//
// req is built by the caller and carries only what that handler reads (see
// handlers.js). Nothing from the incoming request is copied wholesale.
export function runNodeHandler(handler, req) {
  return new Promise((resolve, reject) => {
    const headers = new Headers();
    let settled = false;
    const finish = (body, status) => {
      if (settled) return;
      settled = true;
      resolve(new Response(body === undefined || body === null ? null : body, { status, headers }));
    };
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
        return this;
      },
      getHeader(name) {
        const value = headers.get(name);
        return value === null ? undefined : value;
      },
      removeHeader(name) {
        headers.delete(name);
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8');
        finish(JSON.stringify(value), this.statusCode);
        return this;
      },
      end(body) {
        finish(body, this.statusCode);
        return this;
      },
    };
    Promise.resolve()
      .then(() => handler(req, res))
      .then(() => finish(null, res.statusCode), reject);
  });
}
