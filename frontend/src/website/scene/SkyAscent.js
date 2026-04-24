import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

function SkyAscent({ visibility = 0 }) {
  const groupRef = useRef();
  const matRef = useRef();

  // Create a vertical gradient using a canvas texture
  const gradientTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#f59e0b');   // amber top
    grad.addColorStop(0.4, '#fbbf24'); // lighter amber
    grad.addColorStop(0.7, '#f5f0e8'); // cream
    grad.addColorStop(1, '#ffffff');    // white bottom edge
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, []);

  // Cloud-like puffs using sphere clusters
  const cloudPositions = useMemo(() => {
    const positions = [];
    for (let i = 0; i < 15; i++) {
      positions.push({
        x: (Math.random() - 0.5) * 30,
        y: 20 + Math.random() * 5,
        z: (Math.random() - 0.5) * 20,
        scale: 0.8 + Math.random() * 1.5,
      });
    }
    return positions;
  }, []);

  useFrame(() => {
    if (matRef.current) {
      matRef.current.opacity = visibility * 0.5;
    }
    if (groupRef.current) {
      groupRef.current.visible = visibility > 0.01;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Main gradient sky plane */}
      <mesh position={[0, 22, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[60, 40]} />
        <meshBasicMaterial
          ref={matRef}
          map={gradientTexture}
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Cloud puffs */}
      {cloudPositions.map((c, i) => (
        <mesh key={i} position={[c.x, c.y, c.z]}>
          <sphereGeometry args={[c.scale, 8, 8]} />
          <meshStandardMaterial
            color="#f5f0e8"
            emissive="#f59e0b"
            emissiveIntensity={0.1}
            transparent
            opacity={visibility * 0.25}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/* Warm ambient light when visible */}
      <pointLight
        position={[0, 25, 0]}
        color="#f59e0b"
        intensity={visibility * 2}
        distance={30}
        decay={2}
      />
    </group>
  );
}

export default SkyAscent;
