import { useRef, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Camera stays within city bounds (z: +30 to -65) at all times
// Buildings exist from z=-80 to z=+40 so camera always has buildings around it
const PATH_POINTS = [
  // HERO: Above the city
  [0, 25, 25],
  [0, 20, 18],
  [0, 14, 10],

  // SOCIAL PROOF: Swooping down
  [0, 8, 5],
  [0, 4, 0],

  // HOW IT WORKS: Street level, flying forward
  [0, 3.5, -5],
  [-1, 3, -10],
  [1, 3.5, -16],
  [0, 3, -22],
  [-1, 3.5, -28],

  // BUDGET: Close to right side buildings
  [2, 4, -32],
  [1.5, 5, -36],

  // FEATURES: Mid height
  [0, 9, -38],
  [-1, 8, -40],

  // STATS: Gentle sweep
  [-2, 6, -42],
  [0, 5, -44],

  // VENUES: Back to street level
  [1, 3.5, -46],
  [-0.5, 3, -50],

  // PRICING: Slow cruise
  [0, 4, -52],
  [1, 5, -54],

  // BIRDIE: Rising up
  [0, 10, -56],
  [0, 15, -58],

  // CTA: Above city looking down
  [0, 22, -50],
  [0, 25, -40],
];

const LOOK_POINTS = [
  // HERO
  [0, 0, -10],
  [0, 0, -5],
  [0, 0, -5],

  // SOCIAL PROOF
  [0, 2, -10],
  [0, 2, -12],

  // HOW IT WORKS
  [0, 2, -15],
  [0, 2, -20],
  [0, 2, -26],
  [0, 2, -32],
  [0, 2, -36],

  // BUDGET
  [1, 3, -40],
  [0, 3, -42],

  // FEATURES
  [0, 2, -44],
  [0, 2, -46],

  // STATS
  [1, 3, -48],
  [0, 2, -50],

  // VENUES
  [0, 2, -52],
  [0, 2, -55],

  // PRICING
  [0, 3, -58],
  [0, 3, -60],

  // BIRDIE
  [0, 5, -62],
  [0, 5, -60],

  // CTA
  [0, 0, -55],
  [0, 0, -45],
];

function CameraRig({ progress = 0 }) {
  const { camera } = useThree();
  const currentPos = useRef(new THREE.Vector3(0, 25, 25));
  const currentLook = useRef(new THREE.Vector3(0, 0, -10));

  const pathCurve = useMemo(() => {
    const points = PATH_POINTS.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    return new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.3);
  }, []);

  const lookCurve = useMemo(() => {
    const points = LOOK_POINTS.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    return new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.3);
  }, []);

  useFrame(() => {
    const t = THREE.MathUtils.clamp(progress, 0, 0.999);
    const targetPos = pathCurve.getPoint(t);
    const targetLook = lookCurve.getPoint(t);

    currentPos.current.lerp(targetPos, 0.035);
    currentLook.current.lerp(targetLook, 0.035);

    camera.position.copy(currentPos.current);
    camera.lookAt(currentLook.current);
  });

  return null;
}

export default CameraRig;
