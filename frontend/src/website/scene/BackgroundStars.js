import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Night sky stars fixed above the city skyline
// They twinkle in place like a real night sky, not moving randomly
export default function BackgroundStars() {
  const { geometry, material } = useMemo(() => {
    const count = 400;
    const pos = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // Stars form a hemisphere ABOVE the city (never below buildings)
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * 0.65; // 0=straight up, 0.65=near horizon
      const r = 55 + Math.random() * 30;

      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = 12 + r * Math.cos(phi); // always above y=12
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 25; // centered on city

      sizes[i] = 0.4 + Math.random() * 1.2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aSize;
        varying float vTwinkle;
        uniform float uTime;
        void main() {
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (180.0 / -mvPos.z);
          gl_Position = projectionMatrix * mvPos;
          vTwinkle = sin(uTime * 0.7 + position.x * 2.5 + position.z * 1.8) * 0.35 + 0.65;
        }
      `,
      fragmentShader: `
        varying float vTwinkle;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = length(c);
          float alpha = smoothstep(0.5, 0.0, d) * vTwinkle;
          gl_FragColor = vec4(0.94, 0.92, 0.87, alpha);
        }
      `,
    });

    return { geometry: geo, material: mat };
  }, []);

  useFrame(({ clock }) => {
    material.uniforms.uTime.value = clock.elapsedTime;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
