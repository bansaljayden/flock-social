Add a new Socket.io event handler for: $ARGUMENTS

Rules:
- Add server-side handler to backend/socket/handlers.js following existing patterns
- Use snake_case for event names (e.g., budget_submitted, not budgetSubmitted)
- Emit responses to appropriate rooms:
  - Flock-wide events → io.to(`flock:${flockId}`).emit(...)
  - User-specific events → io.to(`user:${userId}`).emit(...)
  - Sender confirmation → socket.emit(...)
- Include error handling inside the handler (try/catch, emit error event on failure)
- Validate incoming payload data before processing
- If the event persists data, use parameterized pool.query() calls
- Add the corresponding client-side event listener in frontend/src/services/socket.js
- Add the corresponding client-side emit function in frontend/src/services/socket.js
- Document at the top of the handler: event name, expected payload shape, response event name, response payload shape
