// The 3D half of the /flux viewer. FluxViewer.js imports this file only when
// the viewer comes near the screen on a device that can draw it, so three.js
// (r137, from npm: the site's CSP allows no script from a CDN) is its own
// chunk and never part of the page's first load.
//
// The scene is the repo viewer's (flock-sensor/enclosure/viewer/index.html):
// the same materials, lights, shadow and camera framing, so the stop at each
// end of the slider matches the renders the sensor work publishes. What
// differs is that one number, the slider position, places every part
// (fluxData.js), and nothing is drawn unless something changed.
import {
  ACESFilmicToneMapping, Box3, Color, DirectionalLight, HemisphereLight, MathUtils, Matrix3, Matrix4, Mesh,
  MeshPhysicalMaterial, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Raycaster, Scene,
  ShadowMaterial, Sphere, Vector2, Vector3, WebGLRenderer, sRGBEncoding,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment';
import { BOX, LOOK, cableLook, isCable, labelFor, markAt, partAt, poseAt, viewAt } from './fluxData';

// The site's --steel-lift, the colour a part takes on while its step plays.
const MARK = new Color(0x6d9ac3).convertSRGBToLinear();
// The shape of the frame the stills were rendered in; a wider stage crops it.
const FRAME_ASPECT = 1.5;

// The loader rewrites node names (spaces to underscores, some punctuation
// dropped) and keeps the original in userData.name; match on either.
const plain = (s) => String(s || '').replace(/[[\].:/]/g, '').replace(/\s/g, '_');

export function createFluxScene(canvas, { onPick, onTurn } = {}) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputEncoding = sRGBEncoding;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = envMap;

  const camera = new PerspectiveCamera(26, 1.5, 0.001, 50);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  // Turning only. The wheel and a pinch stay the page's, and a vertical
  // swipe on a phone still scrolls past the viewer.
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = 1.48;
  canvas.style.touchAction = 'pan-y';

  const key = new DirectionalLight(0xffffff, 1.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key, key.target);
  scene.add(new HemisphereLight(0xffffff, 0x99958f, 0.55));
  const rim = new DirectionalLight(0xffffff, 0.9);
  scene.add(rim);

  const ground = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.18 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const parts = {};          // name -> { obj, base, materials }
  const byObject = new Map(); // object -> part name, for taps
  let model = null;
  let scale = 0.001;
  let yUp = true;
  let position = 0;
  let turned = false;        // the visitor has turned the box: keep their angle
  let visible = true;
  let raf = 0;
  let last = 0;
  const center = new Vector3();
  let radius = 0;
  const goalTarget = new Vector3();
  const goalPosition = new Vector3();

  // Model millimetres to scene units and axes.
  const m2t = (v) => (yUp
    ? new Vector3(v[0], v[2], -v[1]).multiplyScalar(scale)
    : new Vector3(v[0], v[1], v[2]).multiplyScalar(scale));

  // An offset in the box's frame, brought into the frame of the part's
  // parent, which the file may have turned (Z up to Y up). The box's own
  // pose on the stand is not part of the offset.
  const inverse = new Matrix4();
  const toParent = (obj, v) => {
    if (!obj.parent || !model) return v;
    inverse.copy(model.matrixWorld).invert().multiply(obj.parent.matrixWorld);
    return v.applyMatrix3(new Matrix3().setFromMatrix4(inverse).invert());
  };

  function material(name, fallback) {
    const L = LOOK[name] || (isCable(name) ? cableLook(name) : {});
    // Colours are written in sRGB; the renderer works in linear light.
    const m = new MeshPhysicalMaterial({
      color: new Color(L.color !== undefined ? L.color : fallback).convertSRGBToLinear(),
      roughness: L.rough !== undefined ? L.rough : 0.5,
      metalness: L.metal || 0,
      clearcoat: L.coat || 0,
      clearcoatRoughness: 0.05,
    });
    if (L.coat) m.envMapIntensity = 0.55;
    m.userData.glow = L.glow ? new Color(L.glow).convertSRGBToLinear() : null;
    if (m.userData.glow) { m.emissive.copy(m.userData.glow); m.emissiveIntensity = 0.9; }
    return m;
  }

  // Everything one slider position decides: the pose, where each part sits,
  // which parts show, which are marked, and where the camera wants to be.
  function place() {
    if (!model) return;
    const { tilt, lift } = poseAt(position);
    model.rotation.x = MathUtils.degToRad(-tilt);
    model.position.y = lift * scale;
    model.updateMatrixWorld(true);
    for (const [name, p] of Object.entries(parts)) {
      const { visible: shown, offset } = partAt(name, position);
      p.obj.visible = shown;
      p.obj.position.copy(p.base).add(toParent(p.obj, m2t(offset)));
      const mark = markAt(name, position);
      for (const m of p.materials) {
        if (m.userData.glow) continue;
        m.emissive.copy(MARK);
        m.emissiveIntensity = 0.3 * mark;
      }
    }
    model.updateMatrixWorld(true);

    const box = new Box3();
    for (const p of Object.values(parts)) if (p.obj.visible) box.expandByObject(p.obj);
    if (box.isEmpty()) return;
    box.getCenter(center);
    radius = box.getBoundingSphere(new Sphere()).radius;

    const view = viewAt(position);
    const half = MathUtils.degToRad(view.fov) / 2;
    const fit = Math.max(Math.hypot(BOX.w, BOX.h, BOX.d) * scale * 0.62, radius * 0.92);
    const distance = fit / Math.sin(half) * (camera.aspect < 1 ? 1.35 : 1) * view.zoom;
    const dir = turned
      ? camera.position.clone().sub(controls.target).normalize()
      : m2t(view.dir).normalize();
    goalTarget.copy(center);
    goalPosition.copy(center).addScaledVector(dir, distance);

    // The framing is worked out for the 3:2 frame the stills were rendered in.
    // A stage wider than that (FluxPage.css, 2026-10-21: the empty bands above
    // and below had to go) keeps the 3:2 frame's distance and side-to-side
    // view and narrows only the vertical one, the same picture cropped top and
    // bottom, but never closer than the model's own height allows: as the
    // parts come together the box stands taller, so each step crops only as
    // far as leaves it a margin, measured on every part's box from where the
    // camera is going.
    const crop = camera.aspect > FRAME_ASPECT ? FRAME_ASPECT / camera.aspect : 1;
    const forward = new Vector3().subVectors(center, goalPosition).normalize();
    const side = new Vector3().crossVectors(forward, camera.up).normalize();
    const upward = new Vector3().crossVectors(side, forward);
    const partBox = new Box3();
    const corner = new Vector3();
    let tall = 0;
    for (const p of Object.values(parts)) {
      if (!p.obj.visible) continue;
      partBox.setFromObject(p.obj);
      if (partBox.isEmpty()) continue;
      for (let i = 0; i < 8; i += 1) {
        corner.set(
          i & 1 ? partBox.max.x : partBox.min.x,
          i & 2 ? partBox.max.y : partBox.min.y,
          i & 4 ? partBox.max.z : partBox.min.z,
        ).sub(goalPosition);
        const depth = corner.dot(forward);
        if (depth > 0) tall = Math.max(tall, Math.atan(Math.abs(corner.dot(upward)) / depth));
      }
    }
    const cropped = Math.atan(Math.tan(half) * crop);
    camera.fov = MathUtils.radToDeg(2 * Math.min(half, Math.max(cropped, tall * 1.08)));
    camera.updateProjectionMatrix();

    // The light and its shadow follow what is on show.
    key.position.copy(center).add(m2t([60, -140, 220]).multiplyScalar(4));
    rim.position.copy(center).add(m2t([-220, 160, 120]).multiplyScalar(4));
    key.target.position.copy(center);
    key.target.updateMatrixWorld();
    const s = key.shadow.camera;
    const e = Math.max(radius * 1.25, BOX.w * scale);
    s.left = -e; s.right = e; s.top = e; s.bottom = -e;
    s.near = scale; s.far = e * 12;
    s.updateProjectionMatrix();
  }

  // Ease the camera toward where the slider wants it. Returns whether it is
  // still on its way.
  function follow(dt) {
    const k = 1 - Math.exp(-dt * 9);
    const before = camera.position.distanceToSquared(goalPosition) + controls.target.distanceToSquared(goalTarget);
    if (turned) {
      // Keep the visitor's direction; only the distance and the centre move.
      const dir = camera.position.clone().sub(controls.target).normalize();
      const want = goalPosition.distanceTo(goalTarget);
      const now = camera.position.distanceTo(controls.target);
      controls.target.lerp(goalTarget, k);
      camera.position.copy(controls.target).addScaledVector(dir, now + (want - now) * k);
    } else {
      controls.target.lerp(goalTarget, k);
      camera.position.lerp(goalPosition, k);
    }
    return before > (scale * 0.05) ** 2;
  }

  function frame(now) {
    raf = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    const moving = follow(dt);
    const damping = controls.update();
    renderer.render(scene, camera);
    if (moving || damping) schedule();
    else last = 0;
  }
  function schedule() {
    if (!raf && visible && model) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    place();
    schedule();
  }

  const onStart = () => {
    if (!turned && onTurn) onTurn(true);
    turned = true;
  };
  const onChange = () => schedule();
  controls.addEventListener('start', onStart);
  controls.addEventListener('change', onChange);

  // A tap (not a drag) names the part under it.
  const ray = new Raycaster();
  const pointer = new Vector2();
  let down = null;
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  const onUp = (e) => {
    if (!down || !onPick) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 500;
    down = null;
    if (moved > 6 || !quick) return;
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const shown = Object.values(parts).filter((p) => p.obj.visible).map((p) => p.obj);
    const hit = ray.intersectObjects(shown, true)[0];
    let o = hit ? hit.object : null;
    while (o && !byObject.has(o)) o = o.parent;
    onPick(o ? labelFor(byObject.get(o)) : null);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  const sizer = new ResizeObserver(resize);
  sizer.observe(canvas);
  const seen = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) schedule();
    else if (raf) { cancelAnimationFrame(raf); raf = 0; last = 0; }
  });
  seen.observe(canvas);

  function load(buffer) {
    return new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer, '', (gltf) => {
        const root = gltf.scene;
        const size = new Box3().setFromObject(root).getSize(new Vector3());
        yUp = size.y > size.z;
        model = root;
        scene.add(root);
        const byPlain = {};
        root.traverse((o) => {
          const original = (o.userData && o.userData.name) || '';
          if (isCable(original)) byPlain[plain(original)] = original;
        });
        Object.keys(LOOK).forEach((k) => { byPlain[plain(k)] = k; });
        root.traverse((o) => {
          const original = o.userData && o.userData.name;
          const name = (original && (LOOK[original] || isCable(original))) ? original : byPlain[plain(o.name)];
          if (!name || parts[name]) return;
          const materials = [];
          o.traverse((m) => {
            if (!m.isMesh) return;
            const base = m.material && m.material.color ? m.material.color.getHex() : 0x888888;
            if (m.material) m.material.dispose();
            m.material = material(name, base);
            m.castShadow = true;
            m.receiveShadow = true;
            materials.push(m.material);
          });
          parts[name] = { obj: o, base: o.position.clone(), materials };
          byObject.set(o, name);
        });
        // Millimetres to the file's units, measured on the body.
        const body = parts['Body (printed, navy)'];
        scale = (body ? new Box3().setFromObject(body.obj).getSize(new Vector3()).x : size.x) / BOX.w;
        camera.near = scale * 2;
        camera.far = scale * 20000;
        ground.scale.setScalar(scale * 4000);
        resize();
        // Start where the camera wants to be, not on its way there.
        controls.target.copy(goalTarget);
        camera.position.copy(goalPosition);
        controls.update();
        renderer.render(scene, camera);
        resolve(Object.keys(parts).length);
      }, reject);
    });
  }

  return {
    load,
    setPosition(u) {
      position = u;
      place();
      schedule();
    },
    resetView() {
      turned = false;
      if (onTurn) onTurn(false);
      place();
      schedule();
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      sizer.disconnect();
      seen.disconnect();
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('change', onChange);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      controls.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach((m) => m.dispose());
      });
      envMap.dispose();
      renderer.dispose();
    },
  };
}
