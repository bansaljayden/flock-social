import React from 'react';

const marqueeStyles = {
  wrapper: {
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    width: '100%',
    position: 'relative',
  },
  track: (speed) => ({
    display: 'inline-flex',
    whiteSpace: 'nowrap',
    animation: `marquee-scroll ${speed}s linear infinite`,
  }),
  copy: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
};

// Inject keyframes once
const KEYFRAMES_ID = 'marquee-keyframes';
function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;

  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent = `
    @keyframes marquee-scroll {
      0% { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }
  `;
  document.head.appendChild(style);
}

export default function Marquee({ children, speed = 30, className = '', style = {} }) {
  ensureKeyframes();

  return (
    <div
      className={className}
      style={{ ...marqueeStyles.wrapper, ...style }}
      onMouseEnter={(e) => {
        const track = e.currentTarget.firstChild;
        if (track) track.style.animationPlayState = 'paused';
      }}
      onMouseLeave={(e) => {
        const track = e.currentTarget.firstChild;
        if (track) track.style.animationPlayState = 'running';
      }}
    >
      <div style={marqueeStyles.track(speed)}>
        <div style={marqueeStyles.copy}>{children}</div>
        <div style={marqueeStyles.copy} aria-hidden="true">{children}</div>
      </div>
    </div>
  );
}
