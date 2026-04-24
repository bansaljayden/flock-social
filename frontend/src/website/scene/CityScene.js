import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const sr = (s) => ((Math.sin(s * 127.1 + 311.7) * 43758.5453) % 1 + 1) % 1;
const pick = (a, s) => a[Math.floor(sr(s) * a.length)];
const W_GEO = new THREE.PlaneGeometry(0.4, 0.32);
const LP_GEO = new THREE.CylinderGeometry(0.04, 0.06, 5, 5);
const LB_GEO = new THREE.SphereGeometry(0.22, 6, 6);
const WCOLS = ['#f59e0b', '#e8e4d8', '#06b6d4', '#ff8c42'];
const BCOLS = ['#0f1d35', '#122240', '#15284a', '#0e1a32', '#0b1528'];

function Windows({ buildings }) {
  const ref = useRef();
  const data = useMemo(() => {
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(),
      q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), e = new THREE.Euler();
    const mats = [], cols = [];
    buildings.forEach((b, bi) => {
      const rows = Math.max(2, Math.floor(b.h * 1.1)), sp = b.h / rows;
      const faces = [
        { ax: 'z', sg: 1, sp: b.w, cr: b.d, ry: 0 }, { ax: 'z', sg: -1, sp: b.w, cr: b.d, ry: Math.PI },
        { ax: 'x', sg: 1, sp: b.d, cr: b.w, ry: Math.PI / 2 }, { ax: 'x', sg: -1, sp: b.d, cr: b.w, ry: -Math.PI / 2 },
      ];
      const ws = 0.85 + sr(bi * 7) * 0.3;
      faces.forEach((f, fi) => {
        const cpf = Math.max(1, Math.floor(f.sp / (0.55 * ws)));
        for (let r = 1; r < rows; r++) for (let c = 0; c < cpf; c++) {
          const sd = bi * 1000 + fi * 100 + r * 20 + c;
          if (sr(sd) < 0.3) continue;
          const frac = (c + 0.5) / cpf, y = b.pos[1] + (r + 0.5) * sp;
          const hF = y / (b.pos[1] + b.h), t = b.taper ? 1 - hF * b.taperAmt : 1;
          const eW = b.w * t, eD = b.d * t;
          const span = f.ax === 'z' ? eW : eD, half = f.ax === 'z' ? eD / 2 : eW / 2;
          let wx, wz;
          if (f.ax === 'z') { wx = b.pos[0] - span / 2 + frac * span; wz = b.pos[2] + f.sg * (half + 0.03); }
          else { wz = b.pos[2] - span / 2 + frac * span; wx = b.pos[0] + f.sg * (half + 0.03); }
          p.set(wx, y, wz); e.set(0, f.ry, 0); q.setFromEuler(e); s.set(ws, 1, 1);
          m4.compose(p, q, s); mats.push(m4.clone());
          const col = new THREE.Color(pick(WCOLS, sd + 0.5)).multiplyScalar(0.6 + sr(sd + 3) * 0.5);
          cols.push(col);
        }
      });
    });
    return { matrices: mats, colors: cols, count: mats.length };
  }, [buildings]);
  useEffect(() => {
    if (!ref.current || data.count === 0) return;
    const ca = new Float32Array(data.count * 3);
    for (let i = 0; i < data.count; i++) {
      ref.current.setMatrixAt(i, data.matrices[i]);
      ca[i * 3] = data.colors[i].r; ca[i * 3 + 1] = data.colors[i].g; ca[i * 3 + 2] = data.colors[i].b;
    }
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.geometry.setAttribute('color', new THREE.InstancedBufferAttribute(ca, 3));
  }, [data]);
  if (data.count === 0) return null;
  return (<instancedMesh ref={ref} args={[W_GEO, null, data.count]} frustumCulled={false}>
    <meshBasicMaterial vertexColors transparent opacity={0.85} side={THREE.DoubleSide} />
  </instancedMesh>);
}

function StreetLamps({ lamps }) {
  const pRef = useRef(), bRef = useRef();
  useEffect(() => {
    if (!pRef.current || !bRef.current) return;
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    q.identity();
    lamps.forEach((l, i) => {
      p.set(l.x, 2.5, l.z); m4.compose(p, q, s); pRef.current.setMatrixAt(i, m4);
      p.set(l.x, 5.1, l.z); m4.compose(p, q, s); bRef.current.setMatrixAt(i, m4);
    });
    pRef.current.instanceMatrix.needsUpdate = true;
    bRef.current.instanceMatrix.needsUpdate = true;
  }, [lamps]);
  return (<>
    <instancedMesh ref={pRef} args={[LP_GEO, null, lamps.length]} frustumCulled={false}>
      <meshBasicMaterial color="#223548" metalness={0.8} roughness={0.3} /></instancedMesh>
    <instancedMesh ref={bRef} args={[LB_GEO, null, lamps.length]} frustumCulled={false}>
      <meshBasicMaterial color="#f5deb3" /></instancedMesh>
  </>);
}

function CarHeadlights() {
  const cars = useRef([]); const grp = useRef();
  useMemo(() => { cars.current = Array.from({ length: 8 }, (_, i) => ({
    z: -80 + sr(i * 99) * 120, speed: 6 + sr(i * 37) * 14,
    x: i < 4 ? -1.2 - (i % 2) * 1.4 : 1.2 + (i % 2) * 1.4, dir: i < 4 ? 1 : -1,
  })); }, []);
  useFrame((_, dt) => { if (!grp.current) return;
    cars.current.forEach((c, i) => {
      c.z += c.speed * c.dir * dt;
      if (c.z > 50) c.z = -80; if (c.z < -80) c.z = 50;
      const h = grp.current.children[i * 2], t = grp.current.children[i * 2 + 1];
      if (h) h.position.set(c.x, 0.4, c.z);
      if (t) t.position.set(c.x, 0.4, c.z - c.dir * 1.8);
    });
  });
  return (<group ref={grp}>
    {Array.from({ length: 8 }, (_, i) => [
      <mesh key={`h${i}`}><sphereGeometry args={[0.12, 5, 5]} /><meshBasicMaterial color="#fffde0" /></mesh>,
      <mesh key={`t${i}`}><sphereGeometry args={[0.08, 5, 5]} /><meshBasicMaterial color="#ff2020" /></mesh>,
    ]).flat()}
  </group>);
}

function SteamVents() {
  const grp = useRef(), vents = useRef([]);
  const pos = useMemo(() => [[-3, 0, -12], [2, 0, -35], [-1.5, 0, -55], [3, 0, 8]], []);
  useMemo(() => { vents.current = pos.map(() => ({
    p: Array.from({ length: 4 }, () => ({ y: Math.random() * 3.5, o: Math.random() })),
  })); }, [pos]);
  useFrame((_, dt) => { if (!grp.current) return;
    vents.current.forEach((v, vi) => v.p.forEach((pt, pi) => {
      pt.y += dt * (0.8 + pi * 0.3); pt.o = Math.max(0, 1 - pt.y / 3.5);
      if (pt.y > 3.5) { pt.y = 0; pt.o = 1; }
      const ch = grp.current.children[vi * 4 + pi];
      if (ch) { ch.position.set(pos[vi][0], pt.y + 0.1, pos[vi][2]); ch.material.opacity = pt.o * 0.25; ch.scale.setScalar(0.5 + pt.y * 0.3); }
    }));
  });
  return (<group ref={grp}>
    {pos.flatMap((_, vi) => [0, 1, 2, 3].map(pi => (
      <mesh key={`${vi}-${pi}`} rotation={[-Math.PI / 2, 0, 0]} frustumCulled>
        <planeGeometry args={[0.7, 0.7]} />
        <meshBasicMaterial color="#8899bb" transparent opacity={0.15} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>)))}
  </group>);
}

export default function CityScene({ scrollProgress = 0 }) {
  const groupRef = useRef();
  const buildings = useMemo(() => {
    const b = [];
    const add = (cnt, zMin, zMax, xBase, xVar, hMin, hMax, wMin, wMax, dMin, dMax, side) => {
      for (let i = 0; i < cnt; i++) {
        const sd = side * 1000 + i;
        const z = zMin + (i / (cnt - 1 || 1)) * (zMax - zMin) + (sr(sd) - 0.5) * 4;
        const h = hMin + sr(sd + 2) * (hMax - hMin), tp = h > 15 ? 'sky' : h > 8 ? 'mid' : 'low';
        b.push({ pos: [xBase + sr(sd + 1) * xVar, 0, z], w: wMin + sr(sd + 3) * (wMax - wMin),
          d: dMin + sr(sd + 4) * (dMax - dMin), h, type: tp, seed: sd,
          taper: tp === 'sky' && sr(sd + 5) > 0.4, taperAmt: 0.15 + sr(sd + 6) * 0.2,
          setbacks: tp === 'sky' ? Math.floor(1 + sr(sd + 7) * 3) : 0,
          roofGarden: tp === 'mid' && sr(sd + 8) > 0.55, roofAC: tp === 'low' && sr(sd + 9) > 0.4,
          waterTank: sr(sd + 10) > 0.88, fireEscape: sr(sd + 11) > 0.6 && tp !== 'low',
          color: pick(BCOLS, sd + 12) });
      }
    };
    add(14, -80, 40, -7, 3, 8, 28, 2.5, 4, 2.5, 4, 0); add(12, -75, 35, -14, 4, 5, 18, 3, 5, 3, 4, 1);
    add(10, -70, 30, -22, 5, 3, 12, 3, 6, 3, 5, 2); add(14, -80, 40, 7, 3, 8, 28, 2.5, 4, 2.5, 4, 3);
    add(12, -75, 35, 14, 4, 5, 18, 3, 5, 3, 4, 4); add(10, -70, 30, 22, 5, 3, 12, 3, 6, 3, 5, 5);
    return b.slice(0, 60);
  }, []);

  const neons = useMemo(() => [
    { p: [-7.2, 9, -18], c: '#06b6d4', s: [1.8, 0.5] }, { p: [8, 14, -30], c: '#ff1493', s: [1.6, 0.45] },
    { p: [-8.5, 7, -48], c: '#f59e0b', s: [1.3, 0.5] }, { p: [7.5, 11, -8], c: '#00bfff', s: [1.5, 0.45] },
    { p: [-9, 16, 5], c: '#ff1493', s: [2, 0.5] }, { p: [9, 8, -60], c: '#06b6d4', s: [1.4, 0.5] },
    { p: [-7, 12, -65], c: '#f59e0b', s: [1.6, 0.4] }, { p: [8.5, 18, -20], c: '#06b6d4', s: [3, 0.8] },
  ], []);
  const lamps = useMemo(() => Array.from({ length: 20 }, (_, i) => ({
    x: i % 2 === 0 ? -5.2 : 5.2, z: -80 + Math.floor(i / 2) * 13 })), []);
  const cwZ = useMemo(() => Array.from({ length: 6 }, (_, i) => -60 + i * 20), []);

  useFrame(() => { if (!groupRef.current) return;
    groupRef.current.rotation.y = scrollProgress * 0.05; // very subtle rotation
    groupRef.current.position.y = -2;
  });

  return (
    <group ref={groupRef}>
      {/* Sky dome - massive sphere so camera NEVER sees black */}
      <mesh>
        <sphereGeometry args={[100, 16, 16]} />
        <meshBasicMaterial color="#0b1a2e" side={THREE.BackSide} />
      </mesh>
      {/* Ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, -20]} frustumCulled>
        <planeGeometry args={[200, 200]} /><meshBasicMaterial color="#060e1a" /></mesh>
      {/* Road */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -20]} frustumCulled>
        <planeGeometry args={[9, 160]} /><meshBasicMaterial color="#111c2e" roughness={0.8} /></mesh>
      {/* Sidewalks */}
      {[-5.3, 5.3].map(x => <mesh key={`sw${x}`} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.06, -20]} frustumCulled>
        <planeGeometry args={[1.2, 160]} /><meshBasicMaterial color="#111822" roughness={0.9} /></mesh>)}
      {/* Center lane dashes */}
      {Array.from({ length: 40 }, (_, i) => <mesh key={`lm${i}`} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, -80 + i * 4]} frustumCulled>
        <planeGeometry args={[0.08, 1.5]} /><meshBasicMaterial color="#1e3040" /></mesh>)}
      {/* Lane dividers */}
      {[-2.2, 2.2].flatMap(x => Array.from({ length: 40 }, (_, i) => <mesh key={`ld${x}${i}`} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.02, -80 + i * 4]} frustumCulled>
        <planeGeometry args={[0.05, 1]} /><meshBasicMaterial color="#162535" /></mesh>))}
      {/* Crosswalks */}
      {cwZ.flatMap(z => Array.from({ length: 6 }, (_, s) => <mesh key={`cw${z}${s}`} rotation={[-Math.PI / 2, 0, 0]} position={[-3 + s * 1.2, 0.03, z]} frustumCulled>
        <planeGeometry args={[0.6, 0.15]} /><meshBasicMaterial color="#2a3a4a" /></mesh>))}
      {/* Traffic lights */}
      {cwZ.filter((_, i) => i % 2 === 0).map(z => <group key={`tf${z}`} position={[4.8, 0, z]}>
        <mesh position={[0, 3, 0]} frustumCulled><cylinderGeometry args={[0.03, 0.03, 6, 4]} /><meshBasicMaterial color="#223548" /></mesh>
        {[[5.8, '#ff2020'], [5.5, '#f59e0b'], [5.2, '#22cc44']].map(([y, c]) =>
          <mesh key={c} position={[0, y, 0]} frustumCulled><sphereGeometry args={[0.08, 5, 5]} /><meshBasicMaterial color={c} /></mesh>)}
      </group>)}

      {/* Buildings */}
      {buildings.map((b, i) => <group key={i} position={b.pos}>
        <mesh position={[0, b.h / 2, 0]} frustumCulled>
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshBasicMaterial color={b.color} /></mesh>
        {/* Setbacks */}
        {b.type === 'sky' && Array.from({ length: b.setbacks }, (_, si) => {
          const sc = 1 - (si + 1) * 0.15, sbH = b.h * 0.12;
          return <mesh key={`sb${si}`} position={[0, b.h * (0.65 + si * 0.12) + sbH / 2, 0]} frustumCulled>
            <boxGeometry args={[b.w * sc, sbH, b.d * sc]} /><meshBasicMaterial color="#122440" metalness={0.9} roughness={0.1} /></mesh>;
        })}
        {/* Tapered crown */}
        {b.taper && <mesh position={[0, b.h + 1.5, 0]} frustumCulled>
          <boxGeometry args={[b.w * 0.4, 3, b.d * 0.4]} /><meshBasicMaterial color="#152a48" metalness={0.9} roughness={0.1} /></mesh>}
        {/* Angled top */}
        {b.type === 'sky' && !b.taper && sr(b.seed + 20) > 0.5 && <mesh position={[0, b.h + 1, 0]} rotation={[0, 0, 0.3]} frustumCulled>
          <boxGeometry args={[b.w * 0.6, 2, b.d * 0.5]} /><meshBasicMaterial color="#142842" metalness={0.9} roughness={0.1} /></mesh>}
        {/* Floor lines */}
        {b.type === 'mid' && Array.from({ length: Math.floor(b.h / 2) }, (_, fi) =>
          <mesh key={`fl${fi}`} position={[0, (fi + 1) * 2, b.d / 2 + 0.01]} frustumCulled>
            <planeGeometry args={[b.w, 0.03]} /><meshBasicMaterial color="#060a12" /></mesh>)}
        {/* Roof garden */}
        {b.roofGarden && <mesh position={[0, b.h + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} frustumCulled>
          <planeGeometry args={[b.w * 0.7, b.d * 0.7]} /><meshBasicMaterial color="#0a3020" transparent opacity={0.8} /></mesh>}
        {/* AC units */}
        {b.roofAC && [0, 1].map(ai => <mesh key={`ac${ai}`} position={[(ai - 0.5) * b.w * 0.4, b.h + 0.3, 0]} frustumCulled>
          <boxGeometry args={[0.5, 0.6, 0.5]} /><meshBasicMaterial color="#152030" metalness={0.7} roughness={0.4} /></mesh>)}
        {/* Water tank */}
        {b.waterTank && <group position={[b.w * 0.2, b.h + 1.2, b.d * 0.15]}>
          <mesh frustumCulled><cylinderGeometry args={[0.4, 0.4, 1.6, 6]} /><meshBasicMaterial color="#1a2535" metalness={0.5} roughness={0.6} /></mesh>
          <mesh position={[0, 1, 0]} frustumCulled><coneGeometry args={[0.45, 0.6, 6]} /><meshBasicMaterial color="#1a2535" metalness={0.5} roughness={0.5} /></mesh>
        </group>}
        {/* Fire escape */}
        {b.fireEscape && Array.from({ length: Math.min(6, Math.floor(b.h / 2.5)) }, (_, fi) =>
          <mesh key={`fe${fi}`} position={[-b.w / 2 - 0.08, 2 + fi * 2.5, 0]} frustumCulled>
            <boxGeometry args={[0.04, 2.2, 0.6]} /><meshBasicMaterial color="#223548" metalness={0.8} roughness={0.3} /></mesh>)}
      </group>)}

      <Windows buildings={buildings} />
      <StreetLamps lamps={lamps} />
      <CarHeadlights />
      <SteamVents />

      {/* Neon signs with glow */}
      {neons.map((n, i) => <group key={`n${i}`} position={n.p}>
        <mesh position={[0, 0, -0.05]} frustumCulled><planeGeometry args={[n.s[0] + 0.5, n.s[1] + 0.35]} />
          <meshBasicMaterial color={n.c} transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} /></mesh>
        <mesh frustumCulled><planeGeometry args={n.s} />
          <meshBasicMaterial color={n.c} transparent opacity={0.92} side={THREE.DoubleSide} /></mesh>
      </group>)}
      {/* Billboard */}
      <mesh position={[-15, 16, -40]} frustumCulled>
        <planeGeometry args={[4, 2.5]} /><meshBasicMaterial color="#0a1e3a" transparent opacity={0.7} side={THREE.DoubleSide} /></mesh>
      {/* Ground haze */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3, -20]} frustumCulled>
        <planeGeometry args={[60, 140]} /><meshBasicMaterial color="#0a1828" transparent opacity={0.15} depthWrite={false} side={THREE.DoubleSide} /></mesh>

      {/* Lights — 13 total */}
      {Array.from({ length: 5 }, (_, i) => <group key={`sl${i}`}>
        <pointLight position={[-5, 6, -70 + i * 25]} intensity={0.5} color="#0d9488" distance={22} decay={2} />
        <pointLight position={[5, 6, -60 + i * 25]} intensity={0.5} color="#f59e0b" distance={22} decay={2} />
      </group>)}
      <pointLight position={[0, 35, -25]} intensity={1.2} color="#06b6d4" distance={70} decay={2} />
      <pointLight position={[0, 28, -55]} intensity={0.9} color="#0d9488" distance={55} decay={2} />
      <pointLight position={[8.5, 19, -20]} intensity={0.6} color="#06b6d4" distance={15} decay={2} />
    </group>
  );
}
