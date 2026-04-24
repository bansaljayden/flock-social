import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';

const TEAL = '#0d9488';

function VaultScene({ unlocked = 0 }) {
  const shackleRef = useRef();
  const lightRef = useRef();

  useFrame(() => {
    // Shackle rotates open as unlocked goes from 0 to 1
    if (shackleRef.current) {
      shackleRef.current.rotation.z = -unlocked * Math.PI * 0.35;
      shackleRef.current.position.y = 0.8 + unlocked * 0.3;
    }
    if (lightRef.current) {
      lightRef.current.intensity = unlocked * 3;
    }
  });

  return (
    <group>
      {/* Hexagonal doorframe */}
      <mesh rotation={[0, 0, Math.PI / 6]}>
        <torusGeometry args={[3, 0.08, 6, 6]} />
        <meshStandardMaterial
          color={TEAL}
          emissive={TEAL}
          emissiveIntensity={0.4}
          wireframe
          transparent
          opacity={0.7}
        />
      </mesh>

      {/* Glass lock group */}
      <group position={[0, 0, 0]}>
        {/* Lock body */}
        <mesh position={[0, -0.3, 0]}>
          <boxGeometry args={[1.2, 1, 0.5]} />
          <meshPhysicalMaterial
            color="#ffffff"
            transmission={0.6}
            roughness={0.1}
            metalness={0.1}
            transparent
            opacity={0.6}
            thickness={0.5}
          />
        </mesh>

        {/* Shackle */}
        <group ref={shackleRef} position={[0, 0.8, 0]}>
          <mesh>
            <torusGeometry args={[0.4, 0.08, 12, 24, Math.PI]} />
            <meshPhysicalMaterial
              color="#ffffff"
              transmission={0.6}
              roughness={0.1}
              metalness={0.1}
              transparent
              opacity={0.7}
              thickness={0.3}
            />
          </mesh>
        </group>

        {/* Keyhole */}
        <mesh position={[0, -0.3, 0.26]}>
          <circleGeometry args={[0.1, 16]} />
          <meshStandardMaterial
            color="#0b1a2e"
            emissive={TEAL}
            emissiveIntensity={unlocked * 0.5}
          />
        </mesh>
      </group>

      {/* Interior point light */}
      <pointLight
        ref={lightRef}
        position={[0, 0, 0.5]}
        color={TEAL}
        intensity={0}
        distance={8}
        decay={2}
      />

      {/* Ambient fill for the vault */}
      <pointLight
        position={[0, 3, 2]}
        color="#ffffff"
        intensity={0.3}
        distance={10}
        decay={2}
      />
    </group>
  );
}

export default VaultScene;
