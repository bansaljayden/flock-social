import { useEffect, useCallback } from 'react';

const MAX_TILT = 8;

export default function useTiltCard(cardRef) {
  const isTouchDevice = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

  const handleMouseMove = useCallback((e) => {
    const el = cardRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Normalize cursor position to -1..1 relative to card center
    const normalX = (e.clientX - centerX) / (rect.width / 2);
    const normalY = (e.clientY - centerY) / (rect.height / 2);

    // Clamp to -1..1
    const clampedX = Math.max(-1, Math.min(1, normalX));
    const clampedY = Math.max(-1, Math.min(1, normalY));

    // rotateY follows horizontal mouse, rotateX follows vertical (inverted)
    const rotateY = clampedX * MAX_TILT;
    const rotateX = -clampedY * MAX_TILT;

    el.style.transition = 'transform 0.1s ease-out';
    el.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;

    // Expose mouse position as CSS custom properties for gradient highlight
    const mouseXPercent = ((e.clientX - rect.left) / rect.width) * 100;
    const mouseYPercent = ((e.clientY - rect.top) / rect.height) * 100;
    el.style.setProperty('--mouse-x', `${mouseXPercent}%`);
    el.style.setProperty('--mouse-y', `${mouseYPercent}%`);
  }, [cardRef]);

  const handleMouseLeave = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;

    el.style.transition = 'transform 0.5s ease-out';
    el.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg)';
  }, [cardRef]);

  useEffect(() => {
    if (isTouchDevice) return;

    const el = cardRef.current;
    if (!el) return;

    el.addEventListener('mousemove', handleMouseMove);
    el.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      el.removeEventListener('mousemove', handleMouseMove);
      el.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [cardRef, isTouchDevice, handleMouseMove, handleMouseLeave]);
}
