// Field speed measurement. web-vitals 6 (the pin was ^2.1.4, which predates
// INP): the getX callbacks became onX in v3 and FID was retired for INP in
// v4, so the old import silently resolved to undefined functions under the
// new package. The five reported here are the ones services/api.js accepts.
const reportWebVitals = onPerfEntry => {
  if (onPerfEntry && onPerfEntry instanceof Function) {
    import('web-vitals').then(({ onCLS, onINP, onFCP, onLCP, onTTFB }) => {
      onCLS(onPerfEntry);
      onINP(onPerfEntry);
      onFCP(onPerfEntry);
      onLCP(onPerfEntry);
      onTTFB(onPerfEntry);
    });
  }
};

export default reportWebVitals;
