import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const PARTICLE_COUNT = 200;
const MAX_LINES = 300;
const LINE_DIST = 2.0;
const LERP_SPEED = 0.02;
const COLORS = ['#0d9488', '#f59e0b', '#06b6d4'];

function generateShapePositions(shape) {
  const pos = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const idx = i * 3;
    switch (shape) {
      case 'constellation': {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const r = 8 * Math.cbrt(Math.random());
        pos[idx] = r * Math.sin(phi) * Math.cos(theta);
        pos[idx + 1] = r * Math.sin(phi) * Math.sin(theta);
        pos[idx + 2] = r * Math.cos(phi);
        break;
      }
      case 'band': {
        pos[idx] = (Math.random() - 0.5) * 30;
        pos[idx + 1] = (Math.random() - 0.5) * 0.3;
        pos[idx + 2] = (Math.random() - 0.5) * 0.3;
        break;
      }
      case 'lock': {
        // Top half: circle (shackle)
        if (i < PARTICLE_COUNT * 0.4) {
          const angle = Math.PI + (i / (PARTICLE_COUNT * 0.4)) * Math.PI;
          pos[idx] = Math.cos(angle) * 2;
          pos[idx + 1] = Math.sin(angle) * 2 + 3;
          pos[idx + 2] = (Math.random() - 0.5) * 0.3;
        } else {
          // Bottom: rectangle (body)
          pos[idx] = (Math.random() - 0.5) * 4;
          pos[idx + 1] = Math.random() * 2.5;
          pos[idx + 2] = (Math.random() - 0.5) * 0.3;
        }
        break;
      }
      case 'scatter': {
        pos[idx] = (Math.random() - 0.5) * 30;
        pos[idx + 1] = (Math.random() - 0.5) * 30;
        pos[idx + 2] = (Math.random() - 0.5) * 30;
        break;
      }
      case 'barChart': {
        const barIndex = Math.floor(Math.random() * 7);
        const heights = [3, 5, 2, 7, 4, 6, 3.5];
        pos[idx] = (barIndex - 3) * 1.8 + (Math.random() - 0.5) * 0.6;
        pos[idx + 1] = Math.random() * heights[barIndex] - 3;
        pos[idx + 2] = (Math.random() - 0.5) * 0.3;
        break;
      }
      case 'bird': {
        // V shape body
        const t = (i / PARTICLE_COUNT) * 2 - 1;
        const wing = Math.abs(t);
        pos[idx] = t * 6;
        pos[idx + 1] = wing * 3 + (Math.random() - 0.5) * 0.4;
        pos[idx + 2] = (Math.random() - 0.5) * 0.3;
        break;
      }
      case 'converge':
      default: {
        pos[idx] = (Math.random() - 0.5) * 0.5;
        pos[idx + 1] = (Math.random() - 0.5) * 0.5;
        pos[idx + 2] = (Math.random() - 0.5) * 0.5;
        break;
      }
    }
  }
  return pos;
}

function ParticleSystem({ targetShape = 'constellation' }) {
  const pointsRef = useRef();
  const lineRef = useRef();
  const currentPositions = useRef(null);

  // Pre-compute all shape targets
  const shapeTargets = useMemo(() => ({
    constellation: generateShapePositions('constellation'),
    band: generateShapePositions('band'),
    lock: generateShapePositions('lock'),
    scatter: generateShapePositions('scatter'),
    barChart: generateShapePositions('barChart'),
    bird: generateShapePositions('bird'),
    converge: generateShapePositions('converge'),
  }), []);

  // Particle colors
  const colors = useMemo(() => {
    const c = new Float32Array(PARTICLE_COUNT * 3);
    const col = new THREE.Color();
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      col.set(COLORS[i % COLORS.length]);
      c[i * 3] = col.r;
      c[i * 3 + 1] = col.g;
      c[i * 3 + 2] = col.b;
    }
    return c;
  }, []);

  // Initialize positions
  const initialPositions = useMemo(() => {
    return new Float32Array(shapeTargets.constellation);
  }, [shapeTargets]);

  // Line geometry buffer
  const linePositions = useMemo(() => new Float32Array(MAX_LINES * 2 * 3), []);
  const lineGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    geo.setDrawRange(0, 0);
    return geo;
  }, [linePositions]);

  const lineMat = useMemo(() => new THREE.LineBasicMaterial({
    color: 0x0d9488,
    transparent: true,
    opacity: 0.15,
    depthWrite: false,
  }), []);

  useFrame(() => {
    if (!pointsRef.current) return;
    const posAttr = pointsRef.current.geometry.getAttribute('position');
    const target = shapeTargets[targetShape] || shapeTargets.constellation;

    if (!currentPositions.current) {
      currentPositions.current = new Float32Array(posAttr.array);
    }

    const arr = currentPositions.current;

    // Lerp toward target
    for (let i = 0; i < PARTICLE_COUNT * 3; i++) {
      arr[i] += (target[i] - arr[i]) * LERP_SPEED;
      posAttr.array[i] = arr[i];
    }
    posAttr.needsUpdate = true;

    // Update proximity lines
    let lineCount = 0;
    const lp = linePositions;
    for (let i = 0; i < PARTICLE_COUNT && lineCount < MAX_LINES; i++) {
      const ix = arr[i * 3], iy = arr[i * 3 + 1], iz = arr[i * 3 + 2];
      for (let j = i + 1; j < PARTICLE_COUNT && lineCount < MAX_LINES; j++) {
        const jx = arr[j * 3], jy = arr[j * 3 + 1], jz = arr[j * 3 + 2];
        const dx = ix - jx, dy = iy - jy, dz = iz - jz;
        const dist = dx * dx + dy * dy + dz * dz;
        if (dist < LINE_DIST * LINE_DIST) {
          const base = lineCount * 6;
          lp[base] = ix; lp[base + 1] = iy; lp[base + 2] = iz;
          lp[base + 3] = jx; lp[base + 4] = jy; lp[base + 5] = jz;
          lineCount++;
        }
      }
    }

    if (lineRef.current) {
      lineRef.current.geometry.getAttribute('position').needsUpdate = true;
      lineRef.current.geometry.setDrawRange(0, lineCount * 2);
    }
  });

  return (
    <group>
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={initialPositions}
            count={PARTICLE_COUNT}
            itemSize={3}
          />
          <bufferAttribute
            attach="attributes-color"
            array={colors}
            count={PARTICLE_COUNT}
            itemSize={3}
          />
        </bufferGeometry>
        <pointsMaterial
          size={0.08}
          vertexColors
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          sizeAttenuation
        />
      </points>
      <lineSegments ref={lineRef} geometry={lineGeo} material={lineMat} />
    </group>
  );
}

export default ParticleSystem;
