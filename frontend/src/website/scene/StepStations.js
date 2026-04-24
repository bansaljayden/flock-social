import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';

const TEAL = '#0d9488';
const TEAL_DIM = '#065f56';

// Spiral positions for 5 platforms
const PLATFORM_POSITIONS = [
  [0, 0, 0],
  [3, 0.5, -2],
  [5, 1.0, -5],
  [3, 1.5, -8],
  [0, 2.0, -10],
];

function StepIcon({ step, active }) {
  const ref = useRef();

  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y = state.clock.elapsedTime * 0.5;
      const s = active ? 1.3 : 0.9;
      ref.current.scale.setScalar(s);
    }
  });

  const color = active ? '#f59e0b' : '#0d9488';

  return (
    <group ref={ref} position={[0, 1.2, 0]}>
      {step === 0 && (
        <mesh>
          <sphereGeometry args={[0.25, 12, 12]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
        </mesh>
      )}
      {step === 1 && (
        <group>
          <mesh position={[-0.2, 0, 0]}>
            <sphereGeometry args={[0.15, 10, 10]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
          </mesh>
          <mesh position={[0.2, 0, 0]}>
            <sphereGeometry args={[0.15, 10, 10]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
          </mesh>
        </group>
      )}
      {step === 2 && (
        <mesh>
          <torusGeometry args={[0.22, 0.06, 8, 16]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
        </mesh>
      )}
      {step === 3 && (
        <group>
          <mesh>
            <boxGeometry args={[0.3, 0.3, 0.3]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
          </mesh>
          {/* Check mark angle */}
          <mesh position={[0, 0.25, 0]} rotation={[0, 0, 0.4]}>
            <boxGeometry args={[0.2, 0.04, 0.04]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
          </mesh>
        </group>
      )}
      {step === 4 && (
        <mesh rotation={[0, 0, -Math.PI / 2]}>
          <coneGeometry args={[0.2, 0.4, 6]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
        </mesh>
      )}
    </group>
  );
}

function HexPlatform({ position, active }) {
  const ref = useRef();

  useFrame((state) => {
    if (ref.current) {
      // Gentle hover
      ref.current.position.y = position[1] + Math.sin(state.clock.elapsedTime + position[0]) * 0.05;
    }
  });

  const emissiveColor = active ? TEAL : TEAL_DIM;
  const emissiveIntensity = active ? 0.6 : 0.15;

  return (
    <group ref={ref} position={position}>
      <mesh rotation={[0, 0, 0]}>
        <cylinderGeometry args={[1, 1, 0.15, 6]} />
        <meshStandardMaterial
          color="#0f2030"
          emissive={emissiveColor}
          emissiveIntensity={emissiveIntensity}
          metalness={0.5}
          roughness={0.4}
        />
      </mesh>
      {/* Edge ring */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1, 0.02, 4, 6]} />
        <meshStandardMaterial
          color={TEAL}
          emissive={TEAL}
          emissiveIntensity={active ? 0.8 : 0.2}
          transparent
          opacity={active ? 1 : 0.5}
        />
      </mesh>
    </group>
  );
}

function StepStations({ activeStep = 0 }) {
  return (
    <group>
      {PLATFORM_POSITIONS.map((pos, i) => (
        <group key={i}>
          <HexPlatform position={pos} active={i === activeStep} />
          <group position={pos}>
            <StepIcon step={i} active={i === activeStep} />
          </group>
        </group>
      ))}
    </group>
  );
}

export default StepStations;
