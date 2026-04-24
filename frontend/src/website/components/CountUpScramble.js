import React, { useState, useEffect, useRef, useCallback } from 'react';

const SCRAMBLE_DURATION = 1000; // ms total animation time
const SCRAMBLE_PHASE = 0.6; // first 60% is random scrambling, last 40% eases to target

export default function CountUpScramble({ target, prefix = '', suffix = '' }) {
  const [display, setDisplay] = useState('0');
  const spanRef = useRef(null);
  const hasAnimated = useRef(false);

  const animate = useCallback(() => {
    if (hasAnimated.current) return;
    hasAnimated.current = true;

    const startTime = performance.now();
    const targetStr = String(target);
    const digitCount = targetStr.length;

    function step(now) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / SCRAMBLE_DURATION, 1);

      if (t < SCRAMBLE_PHASE) {
        // Scramble phase: show random digits matching target length
        let scrambled = '';
        for (let i = 0; i < digitCount; i++) {
          scrambled += Math.floor(Math.random() * 10);
        }
        setDisplay(scrambled);
      } else {
        // Ease-in phase: progressively lock in digits from left to right
        const easeT = (t - SCRAMBLE_PHASE) / (1 - SCRAMBLE_PHASE);
        // Ease out cubic for smoother landing
        const eased = 1 - Math.pow(1 - easeT, 3);
        const lockedDigits = Math.floor(eased * digitCount);

        let result = '';
        for (let i = 0; i < digitCount; i++) {
          if (i < lockedDigits) {
            result += targetStr[i];
          } else {
            result += Math.floor(Math.random() * 10);
          }
        }
        setDisplay(result);
      }

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        setDisplay(targetStr);
      }
    }

    requestAnimationFrame(step);
  }, [target]);

  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animate();
            observer.unobserve(el);
          }
        });
      },
      { threshold: 0.3 }
    );

    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, [animate]);

  return (
    <span ref={spanRef}>
      {prefix}{display}{suffix}
    </span>
  );
}
