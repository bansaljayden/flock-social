import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));

// Landing page at "/" — everything else renders the app
if (window.location.pathname === '/') {
  const LandingPage = React.lazy(() => import('./landing/LandingPage'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <LandingPage />
      </React.Suspense>
    </React.StrictMode>
  );
} else {
  const App = React.lazy(() => import('./App'));
  const { ThemeProvider } = require('./context/ThemeContext');
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </React.Suspense>
    </React.StrictMode>
  );
}

reportWebVitals();
