import { useState, useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const SECTION_IDS = [
  'hero', 'proof', 'how', 'budget', 'features',
  'stats', 'venues', 'pricing', 'birdie', 'cta', 'footer'
];

export default function useScrollProgress() {
  const containerRef = useRef(null);
  const [progress, setProgress] = useState(0);
  const [activeSection, setActiveSection] = useState('hero');
  const [sectionProgress, setSectionProgress] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Master scroll trigger — tracks overall progress through the page
    const trigger = ScrollTrigger.create({
      trigger: container,
      start: 'top top',
      end: 'bottom bottom',
      scrub: 0.5,
      onUpdate: (self) => {
        setProgress(self.progress);
      },
    });

    // Per-section triggers for activeSection + sectionProgress
    const sectionTriggers = [];
    SECTION_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const st = ScrollTrigger.create({
        trigger: el,
        start: 'top 80%',
        end: 'bottom 20%',
        onUpdate: (self) => {
          if (self.isActive) {
            setActiveSection(id);
            setSectionProgress(self.progress);
          }
        },
      });
      sectionTriggers.push(st);
    });

    return () => {
      trigger.kill();
      sectionTriggers.forEach(st => st.kill());
    };
  }, []);

  return { containerRef, progress, activeSection, sectionProgress };
}
