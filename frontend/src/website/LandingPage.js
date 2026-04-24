import React, { useState, useEffect, lazy, Suspense } from 'react';
import './LandingPage.css';

const LandingPageDesktop = lazy(() => import('./LandingPageDesktop'));
const LandingPageMobile = lazy(() => import('./LandingPageMobile'));

export default function LandingPage() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    document.title = 'Flock \u2014 Social Coordination Simplified';
  }, []);

  return (
    <Suspense fallback={<div className="landing" style={{ minHeight: '100vh' }} />}>
      {isMobile ? <LandingPageMobile /> : <LandingPageDesktop />}
    </Suspense>
  );
}
