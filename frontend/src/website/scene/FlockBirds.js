import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';

const BIRD_COLOR = '#1a2744';
const BIRD_COUNT = 12;

function Bird({ index, scatter, time }) {
  const groupRef = useRef();
  const leftWingRef = useRef();
  const rightWingRef = useRef();

  // V-formation positions
  const formation = useMemo(() => {
    const side = index % 2 === 0 ? 1 : -1;
    if (index === 0) return [0, 0, 0];
    const actualRow = Math.ceil(index / 2);
    return [side * actualRow * 1.2, -actualRow * 0.3, -actualRow * 1.5];
  }, [index]);

  // Scattered target positions
  const scatterTarget = useMemo(() => {
    const angle = (index / BIRD_COUNT) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 6 + Math.random() * 8;
    return [
      Math.cos(angle) * dist,
      (Math.random() - 0.5) * 6,
      Math.sin(angle) * dist,
    ];
  }, [index]);

  useFrame((state) => {
    if (!groupRef.current) return;
    const t = state.clock.elapsedTime;
    const s = scatter || 0;

    // Lerp between formation and scatter positions
    const x = formation[0] + (scatterTarget[0] - formation[0]) * s;
    const y = formation[1] + (scatterTarget[1] - formation[1]) * s;
    const z = formation[2] + (scatterTarget[2] - formation[2]) * s;

    // Bob up and down
    const bob = Math.sin(t * 1.5 + index * 0.7) * 0.15;

    groupRef.current.position.set(x, y + bob, z);

    // Wing flap
    const flapAngle = Math.sin(t * 3 + index * 0.5) * 0.25;
    if (leftWingRef.current) leftWingRef.current.rotation.z = 0.3 + flapAngle;
    if (rightWingRef.current) rightWingRef.current.rotation.z = -0.3 - flapAngle;
  });

  return (
    <group ref={groupRef}>
      {/* Body */}
      <mesh>
        <icosahedronGeometry args={[0.2, 0]} />
        <meshStandardMaterial
          color={BIRD_COLOR}
          metalness={0.8}
          roughness={0.3}
        />
      </mesh>
      {/* Left wing */}
      <group position={[0.15, 0.05, 0]} ref={leftWingRef}>
        <mesh position={[0.2, 0, 0]}>
          <planeGeometry args={[0.4, 0.12]} />
          <meshStandardMaterial
            color={BIRD_COLOR}
            metalness={0.8}
            roughness={0.3}
            side={2}
          />
        </mesh>
      </group>
      {/* Right wing */}
      <group position={[-0.15, 0.05, 0]} ref={rightWingRef}>
        <mesh position={[-0.2, 0, 0]}>
          <planeGeometry args={[0.4, 0.12]} />
          <meshStandardMaterial
            color={BIRD_COLOR}
            metalness={0.8}
            roughness={0.3}
            side={2}
          />
        </mesh>
      </group>
    </group>
  );
}

function FlockBirds({ scatter = 0 }) {
  return (
    <group>
      {Array.from({ length: BIRD_COUNT }, (_, i) => (
        <Bird key={i} index={i} scatter={scatter} />
      ))}
    </group>
  );
}

export default FlockBirds;
