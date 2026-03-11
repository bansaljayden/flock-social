import React, { Suspense, useRef, useEffect, memo } from 'react';
import { Application } from '@splinetool/runtime';

const SplineCanvas = memo(function SplineCanvas({ scene, style }) {
  const canvasRef = useRef(null);
  const appRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || appRef.current) return;
    const app = new Application(canvasRef.current);
    appRef.current = app;
    app.load(scene);
    return () => {
      if (appRef.current) {
        appRef.current.dispose();
        appRef.current = null;
      }
    };
  }, [scene]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', ...style }} />;
});

export const SplineScene = memo(function SplineScene({ scene, className, style }) {
  return (
    <Suspense fallback={
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '24px', height: '24px', border: '3px solid rgba(124,58,237,0.3)', borderTopColor: '#7C3AED', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    }>
      <SplineCanvas scene={scene} style={style} />
    </Suspense>
  );
});
