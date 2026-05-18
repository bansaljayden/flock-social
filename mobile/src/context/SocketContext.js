import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { connectSocket, disconnectSocket, getSocket } from '../services/socket';
import { useAuth } from './AuthContext';

// Keeps the Socket.io connection alive while the user is authenticated.
// Connects when `user` becomes truthy, disconnects on logout. Children read
// the live socket via `useSocket()`.

const SocketContext = createContext({ socket: null, connected: false });

export function SocketProvider({ children }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (user) {
      (async () => {
        const s = await connectSocket();
        if (cancelled) { disconnectSocket(); return; }
        socketRef.current = s;
        if (s) {
          setConnected(s.connected);
          s.on('connect', () => setConnected(true));
          s.on('disconnect', () => setConnected(false));
        }
      })();
    } else {
      disconnectSocket();
      socketRef.current = null;
      setConnected(false);
    }
    return () => { cancelled = true; };
  }, [user]);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current || getSocket(), connected }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
