import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

// A point light that follows the camera so the scene is always lit
export default function FollowLight() {
  const lightRef1 = useRef();
  const lightRef2 = useRef();
  const lightRef3 = useRef();
  const { camera } = useThree();

  useFrame(() => {
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;

    // Main light slightly above and ahead of camera
    if (lightRef1.current) {
      lightRef1.current.position.set(cx, cy + 8, cz - 10);
    }
    // Fill light to the left
    if (lightRef2.current) {
      lightRef2.current.position.set(cx - 10, cy + 5, cz - 5);
    }
    // Fill light to the right
    if (lightRef3.current) {
      lightRef3.current.position.set(cx + 10, cy + 5, cz - 5);
    }
  });

  return (
    <>
      <pointLight ref={lightRef1} intensity={2} color="#0d9488" distance={60} decay={1} />
      <pointLight ref={lightRef2} intensity={1.2} color="#06b6d4" distance={50} decay={1} />
      <pointLight ref={lightRef3} intensity={1.2} color="#f59e0b" distance={50} decay={1} />
    </>
  );
}
