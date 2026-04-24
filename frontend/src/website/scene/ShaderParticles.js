import { useRef, useMemo, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const PARTICLE_COUNT = 3000;
const MAX_LINES = 500;
const LINE_DISTANCE = 1.5;

// Brand colors
const TEAL = new THREE.Color('#0d9488');
const AMBER = new THREE.Color('#f59e0b');
const CYAN = new THREE.Color('#06b6d4');
const CREAM = new THREE.Color('#f5f0e8');

// Shape thresholds: [startScroll, endScroll, shapeIndex]
const SHAPE_RANGES = [
  [0.0, 0.1],    // 0: sphere
  [0.1, 0.15],   // 1: explode
  [0.15, 0.35],  // 2: cityline
  [0.35, 0.5],   // 3: lock
  [0.5, 0.6],    // 4: grid
  [0.6, 0.75],   // 5: wave
  [0.75, 0.85],  // 6: bird
  [0.85, 0.95],  // 7: converge
  [0.95, 1.0],   // 8: ring
];

// ─── Shape Generators ──────────────────────────────────────────

function generateSphere(count, radius = 6) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    const r = radius + (Math.random() - 0.5) * 0.4;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  return positions;
}

function generateExplode(count, radius = 6) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    const push = radius * (2.0 + Math.random() * 3.0);
    positions[i * 3] = push * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = push * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = push * Math.cos(phi);
  }
  return positions;
}

function generateCityline(count) {
  const positions = new Float32Array(count * 3);

  // Define buildings: [x, width, height]
  const buildings = [];
  const numBuildings = 18;
  let cursor = -12;
  for (let b = 0; b < numBuildings; b++) {
    const width = 0.6 + Math.random() * 1.2;
    const height = 2 + Math.random() * 8;
    buildings.push({ x: cursor + width / 2, width, height });
    cursor += width + 0.15 + Math.random() * 0.3;
  }

  // Count particles per building proportional to surface area
  const totalArea = buildings.reduce((s, b) => s + b.width * b.height, 0);
  let assigned = 0;

  for (let b = 0; b < buildings.length; b++) {
    const bld = buildings[b];
    const share = Math.floor((bld.width * bld.height / totalArea) * (count * 0.85));
    const particlesForBuilding = b === buildings.length - 1 ? count - assigned : share;

    for (let i = 0; i < particlesForBuilding; i++) {
      const idx = (assigned + i) * 3;
      const edge = Math.random();

      if (edge < 0.3) {
        // Left or right edge
        const side = Math.random() < 0.5 ? -1 : 1;
        positions[idx] = bld.x + side * bld.width / 2;
        positions[idx + 1] = Math.random() * bld.height - 3;
        positions[idx + 2] = (Math.random() - 0.5) * 0.5;
      } else if (edge < 0.5) {
        // Top edge
        positions[idx] = bld.x + (Math.random() - 0.5) * bld.width;
        positions[idx + 1] = bld.height - 3;
        positions[idx + 2] = (Math.random() - 0.5) * 0.5;
      } else {
        // Fill
        positions[idx] = bld.x + (Math.random() - 0.5) * bld.width;
        positions[idx + 1] = Math.random() * bld.height - 3;
        positions[idx + 2] = (Math.random() - 0.5) * 0.5;
      }
    }
    assigned += particlesForBuilding;
  }

  // Add antenna spires on the tallest buildings
  const tallest = [...buildings].sort((a, b) => b.height - a.height).slice(0, 4);
  for (let t = 0; t < tallest.length && assigned < count; t++) {
    const bld = tallest[t];
    const antennaHeight = 1.5 + Math.random();
    for (let i = 0; i < 15 && assigned < count; i++) {
      const idx = assigned * 3;
      positions[idx] = bld.x + (Math.random() - 0.5) * 0.08;
      positions[idx + 1] = bld.height - 3 + Math.random() * antennaHeight;
      positions[idx + 2] = (Math.random() - 0.5) * 0.08;
      assigned++;
    }
  }

  return positions;
}

function generateLock(count) {
  const positions = new Float32Array(count * 3);
  const shackleCount = Math.floor(count * 0.35);
  const bodyCount = count - shackleCount;

  // Shackle: top half of a circle
  for (let i = 0; i < shackleCount; i++) {
    const t = Math.random();
    const angle = Math.PI * t; // 0 to PI (top half)
    const r = 2 + (Math.random() - 0.5) * 0.4;
    positions[i * 3] = Math.cos(angle) * r;
    positions[i * 3 + 1] = Math.sin(angle) * r + 1.0;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
  }

  // Body: rectangle below
  const bodyW = 3.5;
  const bodyH = 3.5;
  const bodyY = -1.5;
  for (let i = 0; i < bodyCount; i++) {
    const idx = (shackleCount + i) * 3;
    const px = (Math.random() - 0.5) * bodyW;
    const py = bodyY + Math.random() * bodyH;
    const pz = (Math.random() - 0.5) * 0.5;

    // Keyhole cutout: skip the center area
    const kx = Math.abs(px);
    const ky = py - bodyY - bodyH * 0.4;
    const inCircle = kx * kx + ky * ky < 0.3;
    const inSlot = kx < 0.15 && ky < 0 && ky > -0.8;
    if (inCircle || inSlot) {
      // Place on body edges instead
      const edge = Math.random();
      if (edge < 0.25) {
        positions[idx] = -bodyW / 2;
        positions[idx + 1] = bodyY + Math.random() * bodyH;
      } else if (edge < 0.5) {
        positions[idx] = bodyW / 2;
        positions[idx + 1] = bodyY + Math.random() * bodyH;
      } else if (edge < 0.75) {
        positions[idx] = (Math.random() - 0.5) * bodyW;
        positions[idx + 1] = bodyY;
      } else {
        positions[idx] = (Math.random() - 0.5) * bodyW;
        positions[idx + 1] = bodyY + bodyH;
      }
      positions[idx + 2] = pz;
    } else {
      positions[idx] = px;
      positions[idx + 1] = py;
      positions[idx + 2] = pz;
    }
  }

  return positions;
}

function generateGrid(count) {
  const positions = new Float32Array(count * 3);
  const cols = 3;
  const rows = 2;
  const cardW = 3;
  const cardH = 2;
  const gapX = 1;
  const gapY = 1;
  const totalW = cols * cardW + (cols - 1) * gapX;
  const totalH = rows * cardH + (rows - 1) * gapY;
  const perCard = Math.floor(count / (cols * rows));

  let idx = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = -totalW / 2 + col * (cardW + gapX) + cardW / 2;
      const cy = totalH / 2 - row * (cardH + gapY) - cardH / 2;
      const cz = (Math.random() - 0.5) * 0.6; // slight Z tilt per card
      const cardIdx = row * cols + col;
      const thisCount = cardIdx === cols * rows - 1 ? count - idx : perCard;

      for (let p = 0; p < thisCount; p++) {
        const pi = (idx + p) * 3;
        positions[pi] = cx + (Math.random() - 0.5) * cardW;
        positions[pi + 1] = cy + (Math.random() - 0.5) * cardH;
        positions[pi + 2] = cz + (Math.random() - 0.5) * 0.15;
      }
      idx += thisCount;
    }
  }

  return positions;
}

function generateWave(count) {
  const positions = new Float32Array(count * 3);
  const gridSize = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const gx = (i % gridSize) / gridSize;
    const gz = Math.floor(i / gridSize) / gridSize;
    const x = (gx - 0.5) * 20;
    const z = (gz - 0.5) * 20;
    const y = Math.sin(x * 0.5) * Math.cos(z * 0.5) * 1.5;
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }
  return positions;
}

function generateBird(count) {
  const positions = new Float32Array(count * 3);

  const wingCount = Math.floor(count * 0.7);
  const bodyCount = Math.floor(count * 0.2);
  const tailCount = count - wingCount - bodyCount;

  // Wings: parametric curves
  for (let i = 0; i < wingCount; i++) {
    const t = (i / wingCount) * 2 - 1; // -1 to 1
    const side = t < 0 ? -1 : 1;
    const absT = Math.abs(t);
    const span = absT * 5; // 0 to 5 units out
    const lift = Math.sin(absT * Math.PI) * 2.0; // wing curve
    const taper = 1.0 - absT * 0.7; // wing narrows at tip

    positions[i * 3] = side * span + (Math.random() - 0.5) * taper * 0.6;
    positions[i * 3 + 1] = lift + (Math.random() - 0.5) * 0.3;
    positions[i * 3 + 2] = (Math.random() - 0.5) * taper * 0.4;
  }

  // Body: central line from head to tail
  for (let i = 0; i < bodyCount; i++) {
    const t = i / bodyCount; // 0 (head) to 1 (tail)
    const bodyLen = 3;
    positions[(wingCount + i) * 3] = (Math.random() - 0.5) * 0.3;
    positions[(wingCount + i) * 3 + 1] = (1 - t) * 0.5 + (Math.random() - 0.5) * 0.2;
    positions[(wingCount + i) * 3 + 2] = -bodyLen / 2 + t * bodyLen + (Math.random() - 0.5) * 0.2;
  }

  // Tail feathers
  for (let i = 0; i < tailCount; i++) {
    const t = i / tailCount;
    const spread = t * 1.5;
    const angle = (Math.random() - 0.5) * Math.PI * 0.4;
    const idx = (wingCount + bodyCount + i) * 3;
    positions[idx] = Math.sin(angle) * spread + (Math.random() - 0.5) * 0.2;
    positions[idx + 1] = -0.3 - t * 0.5 + (Math.random() - 0.5) * 0.15;
    positions[idx + 2] = 1.5 + t * 1.5 + (Math.random() - 0.5) * 0.2;
  }

  return positions;
}

function generateConverge(count) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = Math.random() * 0.5;
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  return positions;
}

function generateRing(count) {
  const positions = new Float32Array(count * 3);
  const majorR = 5;
  const minorR = 0.3;
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 2;
    const r = minorR * (0.5 + Math.random() * 0.5);
    positions[i * 3] = (majorR + r * Math.cos(phi)) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi);
    positions[i * 3 + 2] = (majorR + r * Math.cos(phi)) * Math.sin(theta);
  }
  return positions;
}

// ─── Shaders ───────────────────────────────────────────────────

const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uMorph;
uniform float uMouseX;
uniform float uMouseY;
uniform float uScrollProgress;

attribute vec3 aTargetA;
attribute vec3 aTargetB;
attribute float aRandom;
attribute vec3 aColor;

varying vec3 vColor;
varying float vAlpha;
varying float vSize;

void main() {
  // Morph between shapes
  vec3 pos = mix(aTargetA, aTargetB, uMorph);

  // Add noise/turbulence based on time and random
  float noise = sin(pos.x * 2.0 + uTime) * cos(pos.y * 3.0 + uTime * 0.7) * 0.15;
  pos += noise * aRandom;

  // Mouse influence - particles repel slightly from cursor direction
  pos.x += uMouseX * aRandom * 0.5;
  pos.y += uMouseY * aRandom * 0.3;

  // Compute point size with distance attenuation
  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  float dist = -mvPos.z;
  vSize = (80.0 / dist) * (0.5 + aRandom * 0.5);
  gl_PointSize = vSize;
  gl_Position = projectionMatrix * mvPos;

  // Color - shift based on scroll position for variety
  vColor = aColor;
  vAlpha = smoothstep(0.0, 0.3, aRandom) * (0.6 + 0.4 * sin(uTime * 0.5 + aRandom * 6.28));
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vSize;

void main() {
  // Soft circular point with glow falloff
  vec2 center = gl_PointCoord - vec2(0.5);
  float dist = length(center);
  float alpha = smoothstep(0.5, 0.1, dist) * vAlpha;

  // Core glow (brighter center)
  float core = smoothstep(0.3, 0.0, dist) * 0.5;
  vec3 color = vColor + core;

  gl_FragColor = vec4(color, alpha);
}
`;

// ─── Glow Texture ──────────────────────────────────────────────

function createGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );
  gradient.addColorStop(0, 'rgba(255,255,255,0.4)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

// ─── Helper: get shape index and morph from scroll ─────────────

function getShapeBlend(scrollProgress) {
  const sp = Math.max(0, Math.min(1, scrollProgress));

  for (let i = 0; i < SHAPE_RANGES.length; i++) {
    const [start, end] = SHAPE_RANGES[i];
    if (sp >= start && sp <= end) {
      const t = (sp - start) / (end - start);
      // Use the first 20% and last 20% of each range for morphing
      const morphIn = 0.2;
      const morphOut = 0.8;

      if (i > 0 && t < morphIn) {
        // Morph in from previous shape
        const morph = t / morphIn;
        return { fromShape: i - 1, toShape: i, morph };
      } else if (i < SHAPE_RANGES.length - 1 && t > morphOut) {
        // Morph out to next shape
        const morph = (t - morphOut) / (1 - morphOut);
        return { fromShape: i, toShape: i + 1, morph };
      } else {
        // Hold current shape
        return { fromShape: i, toShape: i, morph: 0 };
      }
    }
  }

  return { fromShape: 8, toShape: 8, morph: 0 };
}

// ─── Component ─────────────────────────────────────────────────

function ShaderParticles({
  scrollProgress = 0,
  activeSection = '',
  sectionProgress = 0,
  mouseX = 0,
  mouseY = 0,
}) {
  const groupRef = useRef();
  const pointsRef = useRef();
  const linesRef = useRef();
  const spriteRef = useRef();
  const materialRef = useRef(); // eslint-disable-line no-unused-vars
  const prevBlendRef = useRef({ fromShape: 0, toShape: 0 });

  // Precompute all shapes
  const shapes = useMemo(() => [
    generateSphere(PARTICLE_COUNT, 6),
    generateExplode(PARTICLE_COUNT, 6),
    generateCityline(PARTICLE_COUNT),
    generateLock(PARTICLE_COUNT),
    generateGrid(PARTICLE_COUNT),
    generateWave(PARTICLE_COUNT),
    generateBird(PARTICLE_COUNT),
    generateConverge(PARTICLE_COUNT),
    generateRing(PARTICLE_COUNT),
  ], []);

  // Per-particle random values
  const randoms = useMemo(() => {
    const arr = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      arr[i] = Math.random();
    }
    return arr;
  }, []);

  // Per-particle colors (mix of teal, amber, cyan, some cream)
  const colors = useMemo(() => {
    const arr = new Float32Array(PARTICLE_COUNT * 3);
    const palette = [TEAL, AMBER, CYAN, CREAM];
    const weights = [0.35, 0.2, 0.35, 0.1];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      let r = Math.random();
      let colorIdx = 0;
      let cumulative = 0;
      for (let c = 0; c < weights.length; c++) {
        cumulative += weights[c];
        if (r <= cumulative) {
          colorIdx = c;
          break;
        }
      }
      const color = palette[colorIdx];
      arr[i * 3] = color.r;
      arr[i * 3 + 1] = color.g;
      arr[i * 3 + 2] = color.b;
    }
    return arr;
  }, []);

  // Geometry setup
  const { geometry, targetAAttr, targetBAttr } = useMemo(() => {
    const geo = new THREE.BufferGeometry();

    const posArr = new Float32Array(shapes[0]);
    const posAttr = new THREE.BufferAttribute(posArr, 3);
    geo.setAttribute('position', posAttr);

    const tA = new THREE.BufferAttribute(new Float32Array(shapes[0]), 3);
    tA.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTargetA', tA);

    const tB = new THREE.BufferAttribute(new Float32Array(shapes[0]), 3);
    tB.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTargetB', tB);

    geo.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    return { geometry: geo, targetAAttr: tA, targetBAttr: tB };
  }, [shapes, randoms, colors]);

  // Shader material
  const shaderMat = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uMorph: { value: 0 },
        uMouseX: { value: 0 },
        uMouseY: { value: 0 },
        uScrollProgress: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }, []);

  // Lines geometry for constellation connections
  const linesGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    // Pre-allocate for MAX_LINES * 2 vertices (each line = 2 points)
    const linePositions = new Float32Array(MAX_LINES * 2 * 3);
    const attr = new THREE.BufferAttribute(linePositions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    geo.setDrawRange(0, 0);
    return geo;
  }, []);

  const linesMaterial = useMemo(() => {
    return new THREE.LineBasicMaterial({
      color: TEAL,
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }, []);

  // Glow sprite
  const glowTexture = useMemo(() => createGlowTexture(), []);
  const glowMaterial = useMemo(() => {
    return new THREE.SpriteMaterial({
      map: glowTexture,
      color: TEAL,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }, [glowTexture]);

  // Temp vec3 for line distance checks
  const _v1 = useMemo(() => new THREE.Vector3(), []);
  const _v2 = useMemo(() => new THREE.Vector3(), []);

  // Update connection lines (throttled: every 3 frames)
  const frameCounter = useRef(0);
  const updateLines = useCallback((posAttr) => {
    const lineAttr = linesGeometry.getAttribute('position');
    const lineArr = lineAttr.array;
    const posArr = posAttr.array;
    let lineCount = 0;

    // Sample a subset for performance: check ~300 particles
    const step = Math.max(1, Math.floor(PARTICLE_COUNT / 300));
    const distSq = LINE_DISTANCE * LINE_DISTANCE;

    outer:
    for (let i = 0; i < PARTICLE_COUNT; i += step) {
      _v1.set(posArr[i * 3], posArr[i * 3 + 1], posArr[i * 3 + 2]);

      for (let j = i + step; j < PARTICLE_COUNT; j += step) {
        _v2.set(posArr[j * 3], posArr[j * 3 + 1], posArr[j * 3 + 2]);

        const dx = _v1.x - _v2.x;
        const dy = _v1.y - _v2.y;
        const dz = _v1.z - _v2.z;
        const dSq = dx * dx + dy * dy + dz * dz;

        if (dSq < distSq) {
          const base = lineCount * 6;
          lineArr[base] = _v1.x;
          lineArr[base + 1] = _v1.y;
          lineArr[base + 2] = _v1.z;
          lineArr[base + 3] = _v2.x;
          lineArr[base + 4] = _v2.y;
          lineArr[base + 5] = _v2.z;
          lineCount++;
          if (lineCount >= MAX_LINES) break outer;
        }
      }
    }

    lineAttr.needsUpdate = true;
    linesGeometry.setDrawRange(0, lineCount * 2);
  }, [linesGeometry, _v1, _v2]);

  // Animation loop
  useFrame((state, delta) => {
    const time = state.clock.elapsedTime;

    // Update uniforms
    shaderMat.uniforms.uTime.value = time;
    shaderMat.uniforms.uMouseX.value = mouseX;
    shaderMat.uniforms.uMouseY.value = mouseY;
    shaderMat.uniforms.uScrollProgress.value = scrollProgress;

    // Determine shape blend
    const blend = getShapeBlend(scrollProgress);
    const prev = prevBlendRef.current;

    // Update target buffers when shapes change
    if (blend.fromShape !== prev.fromShape || blend.toShape !== prev.toShape) {
      targetAAttr.array.set(shapes[blend.fromShape]);
      targetAAttr.needsUpdate = true;
      targetBAttr.array.set(shapes[blend.toShape]);
      targetBAttr.needsUpdate = true;
      prevBlendRef.current = { fromShape: blend.fromShape, toShape: blend.toShape };
    }

    // Smooth morph
    shaderMat.uniforms.uMorph.value = blend.morph;

    // Update actual positions for line calculation (lerp on CPU side)
    const posAttr = geometry.getAttribute('position');
    const posArr = posAttr.array;
    const aArr = targetAAttr.array;
    const bArr = targetBAttr.array;
    const morph = blend.morph;

    for (let i = 0; i < PARTICLE_COUNT * 3; i++) {
      posArr[i] = aArr[i] + (bArr[i] - aArr[i]) * morph;
    }
    posAttr.needsUpdate = true;

    // Position particles relative to camera so they're always visible
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.05;
      // Follow camera position loosely
      const cam = state.camera;
      groupRef.current.position.x = cam.position.x * 0.3;
      groupRef.current.position.y = cam.position.y * 0.5;
      groupRef.current.position.z = cam.position.z - 10;
    }

    // Update constellation lines every 3 frames
    frameCounter.current++;
    if (frameCounter.current % 3 === 0) {
      updateLines(posAttr);
    }

    // Glow sprite
    if (spriteRef.current) {
      // Color shift based on scroll
      const sp = scrollProgress;
      const glowColor = new THREE.Color();
      if (sp < 0.33) {
        glowColor.lerpColors(TEAL, AMBER, sp / 0.33);
      } else if (sp < 0.66) {
        glowColor.lerpColors(AMBER, CYAN, (sp - 0.33) / 0.33);
      } else {
        glowColor.lerpColors(CYAN, TEAL, (sp - 0.66) / 0.34);
      }
      spriteRef.current.material.color.copy(glowColor);
      // Pulse opacity
      spriteRef.current.material.opacity = 0.12 + Math.sin(time * 0.3) * 0.05;
    }
  });

  return (
    <group ref={groupRef}>
      <points ref={pointsRef} geometry={geometry} material={shaderMat} />
      <lineSegments ref={linesRef} geometry={linesGeometry} material={linesMaterial} />
      <sprite ref={spriteRef} material={glowMaterial} scale={[30, 30, 1]} />
    </group>
  );
}

export default ShaderParticles;
