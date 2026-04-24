import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const TEAL = '#0d9488';
const BUILDING_COLOR = '#0f1a2a';
const VENUE_INDEX = 4; // Which building is "the venue"

const BUILDINGS = [
  { x: -6, z: -2, w: 1.5, d: 1.5, h: 4 },
  { x: -4, z: 1, w: 1.2, d: 1.2, h: 6 },
  { x: -2, z: -1, w: 1.8, d: 1.4, h: 3 },
  { x: 0, z: 2, w: 1.3, d: 1.3, h: 7 },
  { x: 1, z: -1, w: 1.6, d: 1.6, h: 5 }, // venue
  { x: 3, z: 1, w: 1.4, d: 1.0, h: 8 },
  { x: 4.5, z: -2, w: 1.2, d: 1.5, h: 4.5 },
  { x: 6, z: 0, w: 1.5, d: 1.3, h: 3.5 },
  { x: -1, z: 3, w: 1.0, d: 1.0, h: 2.5 },
  { x: 5, z: 3, w: 1.3, d: 1.2, h: 5.5 },
];

function FlowSphere({ index, venue, flowIntensity }) {
  const ref = useRef();

  const startPos = useMemo(() => new THREE.Vector3(
    (Math.random() - 0.5) * 16,
    Math.random() * 3 + 1,
    (Math.random() - 0.5) * 10,
  ), []);

  const target = useMemo(() => new THREE.Vector3(venue.x, venue.h / 2, venue.z), [venue]);
  const speed = useMemo(() => 0.005 + Math.random() * 0.01, []);
  const progressRef = useRef(Math.random());

  useFrame(() => {
    if (!ref.current) return;
    const intensity = flowIntensity || 0;
    if (intensity < 0.01) {
      ref.current.visible = false;
      return;
    }
    ref.current.visible = true;

    progressRef.current += speed * intensity;
    if (progressRef.current >= 1) {
      progressRef.current = 0;
      startPos.set(
        (Math.random() - 0.5) * 16,
        Math.random() * 3 + 1,
        (Math.random() - 0.5) * 10,
      );
    }

    const p = progressRef.current;
    ref.current.position.lerpVectors(startPos, target, p);
    ref.current.material.opacity = intensity * (1 - p * 0.5);
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.06, 6, 6]} />
      <meshStandardMaterial
        color={TEAL}
        emissive={TEAL}
        emissiveIntensity={0.8}
        transparent
        opacity={0.6}
      />
    </mesh>
  );
}

function WindowDots({ building, count = 6 }) {
  const dots = useMemo(() => {
    const result = [];
    const cols = Math.floor(building.w / 0.4);
    const rows = Math.floor(building.h / 0.5);
    for (let i = 0; i < Math.min(count, cols * rows); i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      result.push({
        x: -building.w / 2 + 0.3 + col * 0.4,
        y: -building.h / 2 + 0.4 + row * 0.5,
      });
    }
    return result;
  }, [building, count]);

  return (
    <group>
      {dots.map((d, i) => (
        <mesh key={i} position={[d.x, d.y, building.d / 2 + 0.01]}>
          <planeGeometry args={[0.12, 0.12]} />
          <meshStandardMaterial
            color="#f59e0b"
            emissive="#f59e0b"
            emissiveIntensity={0.4}
          />
        </mesh>
      ))}
    </group>
  );
}

function CityBlock({ flowIntensity = 0 }) {
  const venue = BUILDINGS[VENUE_INDEX];

  return (
    <group>
      {/* Ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[20, 12]} />
        <meshStandardMaterial color="#080e18" />
      </mesh>

      {/* Buildings */}
      {BUILDINGS.map((b, i) => {
        const isVenue = i === VENUE_INDEX;
        return (
          <group key={i} position={[b.x, b.h / 2, b.z]}>
            <mesh>
              <boxGeometry args={[b.w, b.h, b.d]} />
              <meshStandardMaterial
                color={isVenue ? '#0d3a35' : BUILDING_COLOR}
                emissive={isVenue ? TEAL : '#111827'}
                emissiveIntensity={isVenue ? 0.3 : 0.05}
                metalness={0.3}
                roughness={0.7}
              />
            </mesh>
            <WindowDots building={b} count={isVenue ? 10 : 6} />
          </group>
        );
      })}

      {/* Flow spheres */}
      {Array.from({ length: 20 }, (_, i) => (
        <FlowSphere
          key={i}
          index={i}
          venue={venue}
          flowIntensity={flowIntensity}
        />
      ))}

      {/* Venue spotlight */}
      <pointLight
        position={[venue.x, venue.h + 2, venue.z]}
        color={TEAL}
        intensity={1.5}
        distance={8}
        decay={2}
      />
    </group>
  );
}

export default CityBlock;
