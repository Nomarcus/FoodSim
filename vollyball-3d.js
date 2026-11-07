// 3D view for Vollyball.html. It draws the same 2D simulation: every player, limb and
// ball lives in the plane z = 0, and each limb is a capsule with exactly the collision
// radius the physics uses, so what touches on screen is what touches in the sim.
// Loaded on demand the first time someone switches to 3D.
import * as THREE from './assets/vendor/three/three.module.min.js';

const U = 100;                      // simulation pixels per 3D unit (≈ 1 m)

export function createView3D(host, api){
  const {FLOOR_Y, NET_X, NET_W, NET_TOP, NET_BOT, WALL_L, WALL_R, CEILING_Y, COLORS, COURT_Z, Z_WALL, END_DIST} = api;
  const COURT_HALF_Z = COURT_Z / U, WALL_Z = Z_WALL / U, END = END_DIST / U;
  const Z = (z)=> z / U;
  const X = (x)=> (x - NET_X) / U;
  const Y = (y)=> (FLOOR_Y - y) / U;
  const HALF_L = (WALL_R - NET_X) / U;
  const CEIL = Y(CEILING_Y);
  const NET_H = Y(NET_TOP);

  // ---------- renderer, scene, camera ----------
  const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  const cv = renderer.domElement;
  cv.className = 'court3d';
  host.appendChild(cv);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#060a1c');
  scene.fog = new THREE.Fog('#060a1c', 20, 42);
  const camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 120);

  scene.add(new THREE.HemisphereLight('#b9c8ff', '#1a1430', 1.1));
  const sun = new THREE.DirectionalLight('#ffffff', 2.6);
  sun.position.set(-3, 12, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {left: -9, right: 9, top: 9, bottom: -6, near: 1, far: 34});
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#ffd9b8', 0.7);
  fill.position.set(6, 5, -6);
  scene.add(fill);

  const canvasTex = (w, h, draw)=>{
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const matCache = new Map();
  const mat = (color, opts = {})=>{
    const key = color + JSON.stringify(opts);
    if(!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial(Object.assign({color, roughness: 0.62, metalness: 0}, opts)));
    return matCache.get(key);
  };

  // ---------- arena ----------
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), mat('#151c40', {roughness: 0.8}));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.003; outer.receiveShadow = true;
  scene.add(outer);

  const courtTex = canvasTex(2048, 1330, (g, w, h)=>{
    g.fillStyle = '#b07a46'; g.fillRect(0, 0, w, h);
    for(let y = 0, i = 0; y < h; y += 26, i++){
      g.fillStyle = `hsl(${26 + (i * 37) % 9}, ${46 + (i * 13) % 12}%, ${44 + (i * 29) % 9}%)`;
      g.fillRect(0, y, w, 25);
      for(let x = (i * 211) % 400; x < w; x += 360 + (i * 97) % 200){ g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x, y, 2, 25); }
    }
    // thin team-colour bands along the centre line
    g.fillStyle = 'rgba(57,135,229,0.55)'; g.fillRect(w / 2 - 70, 0, 64, h);
    g.fillStyle = 'rgba(217,89,38,0.55)'; g.fillRect(w / 2 + 6, 0, 64, h);
    g.strokeStyle = '#f4f6ff'; g.lineWidth = 12;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
    g.lineWidth = 8;
    const atk = 2.0 / (2 * END) * w;
    for(const x of [w / 2 - atk, w / 2 + atk]){ g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  });
  const court = new THREE.Mesh(new THREE.PlaneGeometry(2 * END, 2 * COURT_HALF_Z), new THREE.MeshStandardMaterial({map: courtTex, roughness: 0.38, metalness: 0.05}));
  // free zone between the lines and the walls
  const freeZone = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF_L, 2 * WALL_Z), mat('#2b4fa8', {roughness: 0.5}));
  freeZone.rotation.x = -Math.PI / 2; freeZone.position.y = -0.001; freeZone.receiveShadow = true;
  scene.add(freeZone);
  court.rotation.x = -Math.PI / 2; court.receiveShadow = true;
  scene.add(court);

  // Net: a column NET_W wide from the floor to the tape, exactly the physics shape.
  const netTex = canvasTex(256, 256, (g, w, h)=>{
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(235,240,255,0.95)'; g.lineWidth = 3;
    for(let i = 0; i <= 8; i++){
      g.beginPath(); g.moveTo(i * w / 8, 0); g.lineTo(i * w / 8, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * h / 8); g.lineTo(w, i * h / 8); g.stroke();
    }
  });
  netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;
  const netSpan = 2 * WALL_Z;
  const meshH = NET_H - Y(NET_BOT);
  const netTexTop = netTex.clone(); netTexTop.repeat.set(netSpan / 0.8, meshH / 0.8); netTexTop.needsUpdate = true;
  const netTexLow = netTex.clone(); netTexLow.repeat.set(netSpan / 0.8, Y(NET_BOT) / 0.8); netTexLow.needsUpdate = true;
  const netMatTop = new THREE.MeshStandardMaterial({map: netTexTop, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9});
  const netMatLow = new THREE.MeshStandardMaterial({map: netTexLow, transparent: true, opacity: 0.45, alphaTest: 0.2, side: THREE.DoubleSide, roughness: 0.9});
  for(const sx of [-1, 1]){
    const top = new THREE.Mesh(new THREE.PlaneGeometry(netSpan, meshH), netMatTop);
    top.rotation.y = Math.PI / 2; top.position.set(sx * NET_W / 2 / U, Y(NET_BOT) + meshH / 2, 0);
    scene.add(top);
    const low = new THREE.Mesh(new THREE.PlaneGeometry(netSpan, Y(NET_BOT)), netMatLow);
    low.rotation.y = Math.PI / 2; low.position.set(sx * NET_W / 2 / U, Y(NET_BOT) / 2, 0);
    scene.add(low);
  }
  const tape = new THREE.Mesh(new THREE.BoxGeometry(NET_W / U, 0.07, netSpan), mat('#f5f7ff', {roughness: 0.4}));
  tape.position.set(0, NET_H - 0.035, 0); tape.castShadow = true; scene.add(tape);
  // antennas: the ball must cross between them (they stand on the side lines)
  const antTex = canvasTex(8, 64, (g, w, h)=>{ for(let i = 0; i < 8; i++){ g.fillStyle = i % 2 ? '#ffffff' : '#e0263c'; g.fillRect(0, i * h / 8, w, h / 8); } });
  for(const sz of [-1, 1]){
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8), new THREE.MeshStandardMaterial({map: antTex, roughness: 0.5}));
    ant.position.set(0, NET_H + 0.38, sz * COURT_HALF_Z); scene.add(ant);
  }
  const tape2 = new THREE.Mesh(new THREE.BoxGeometry(NET_W / U, 0.05, netSpan), mat('#e3e8f8'));
  tape2.position.set(0, Y(NET_BOT) + 0.025, 0); scene.add(tape2);
  for(const sz of [-1, 1]){
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, NET_H + 0.12, 16), mat('#c9d1ea', {metalness: 0.6, roughness: 0.3}));
    post.position.set(0, (NET_H + 0.12) / 2, sz * (netSpan / 2 + 0.06)); post.castShadow = true; scene.add(post);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.7, 16), mat('#2d43a0'));
    pad.position.set(0, 0.85, sz * (netSpan / 2 + 0.06)); pad.castShadow = true; scene.add(pad);
    for(let k = 0; k < 4; k++){
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.113, 0.113, 0.05, 16), mat('#ffffff'));
      ring.position.set(0, 0.3 + k * 0.4, sz * (netSpan / 2 + 0.06)); scene.add(ring);
    }
  }

  // Glass end walls and ceiling truss: the sim's walls and ceiling, made visible.
  const glass = new THREE.MeshStandardMaterial({color: '#9fb6ff', transparent: true, opacity: 0.06, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false});
  const frameMat = new THREE.LineBasicMaterial({color: '#7e93d6', transparent: true, opacity: 0.35});
  for(const sx of [-1, 1]){
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(2 * WALL_Z, CEIL), glass);
    pane.rotation.y = Math.PI / 2; pane.position.set(sx * HALF_L, CEIL / 2, 0);
    scene.add(pane);
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(2 * WALL_Z, CEIL)), frameMat);
    frame.rotation.y = Math.PI / 2; frame.position.copy(pane.position);
    scene.add(frame);
  }
  // side walls: only the far one is glass you can see; the near one is just a faint frame
  const far = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF_L, CEIL), glass);
  far.position.set(0, CEIL / 2, -WALL_Z); scene.add(far);
  for(const sz of [-1, 1]){
    const fr = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(2 * HALF_L, CEIL)), frameMat);
    fr.position.set(0, CEIL / 2, sz * WALL_Z); scene.add(fr);
  }
  const trussMat = mat('#2a3366', {metalness: 0.5, roughness: 0.4});
  for(const z of [-3, 0, 3]){
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2 * HALF_L + 1, 0.12, 0.12), trussMat);
    beam.position.set(0, CEIL + 0.06, z); scene.add(beam);
  }
  for(const x of [-4.5, -1.5, 1.5, 4.5]){
    for(const z of [-3, 3]){
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.3), new THREE.MeshStandardMaterial({color: '#ffffff', emissive: '#f4f7ff', emissiveIntensity: 2.2}));
      lamp.position.set(x, CEIL - 0.02, z); scene.add(lamp);
    }
  }

  // Stands and LED boards
  const standMat = mat('#141b40', {roughness: 0.9});
  const fans = [];
  const SIDE_ROWS = 8, END_ROWS = 6;
  const rng = mulberry(11);
  for(let r = 0; r < SIDE_ROWS; r++){
    const z = -(WALL_Z + 0.9 + r * 0.75), y = 0.2 + r * 0.42;
    const tier = new THREE.Mesh(new THREE.BoxGeometry(2 * HALF_L + 4, 0.42, 0.75), standMat);
    tier.position.set(0, y - 0.21, z); tier.receiveShadow = true; scene.add(tier);
    for(let x = -HALF_L - 1.7; x < HALF_L + 1.7; x += 0.32 + rng() * 0.06){
      if(rng() < 0.08) continue;
      fans.push({x, y, z, rot: 0, side: x < 0 ? 'left' : 'right'});
    }
  }
  for(const sx of [-1, 1]){
    for(let r = 0; r < END_ROWS; r++){
      const x = sx * (HALF_L + 1.6 + r * 0.75), y = 0.2 + r * 0.42;
      const tier = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.42, 2 * WALL_Z + 1), standMat);
      tier.position.set(x, y - 0.21, 0); tier.receiveShadow = true; scene.add(tier);
      for(let z = -WALL_Z; z < WALL_Z; z += 0.34 + rng() * 0.06){
        if(rng() < 0.08) continue;
        fans.push({x, y, z, rot: -sx * Math.PI / 2, side: sx < 0 ? 'left' : 'right'});
      }
    }
  }
  const neutral = ['#cfd6ea', '#6d7795', '#2b3150', '#e8e2d0', '#8d5fd3', '#3c9f8a'];
  const skins = ['#f2cfae', '#d9a277', '#a8704a', '#6f4630'];
  const bodyGeo = new THREE.BoxGeometry(0.26, 0.4, 0.18);
  const headGeo = new THREE.SphereGeometry(0.1, 10, 8);
  const armGeo = new THREE.BoxGeometry(0.06, 0.3, 0.06);
  const fanMat = new THREE.MeshStandardMaterial({roughness: 0.8});
  const bodies = new THREE.InstancedMesh(bodyGeo, fanMat, fans.length);
  const heads = new THREE.InstancedMesh(headGeo, fanMat, fans.length);
  const arms = new THREE.InstancedMesh(armGeo, fanMat, fans.length * 2);
  const col = new THREE.Color();
  fans.forEach((f, i)=>{
    const fanOf = rng() < 0.62 ? f.side : (rng() < 0.5 ? 'none' : (f.side === 'left' ? 'right' : 'left'));
    const shirt = fanOf === 'none' ? neutral[Math.floor(rng() * neutral.length)] : (rng() < 0.7 ? COLORS[fanOf].main : COLORS[fanOf].light);
    const skin = skins[Math.floor(rng() * skins.length)];
    f.phase = rng() * 6.28;
    bodies.setColorAt(i, col.set(shirt).multiplyScalar(0.8));
    heads.setColorAt(i, col.set(skin));
    arms.setColorAt(i * 2, col.set(skin)); arms.setColorAt(i * 2 + 1, col.set(skin));
  });
  for(const m of [bodies, heads, arms]){ m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }

  const ledMsg = (text, color)=> canvasTex(2048, 64, (g, w, h)=>{
    g.fillStyle = '#05081a'; g.fillRect(0, 0, w, h);
    g.font = '800 40px ui-monospace, Menlo, Consolas, monospace'; g.textBaseline = 'middle';
    g.fillStyle = color;
    // stretch slightly so a whole number of repeats fills the texture: no seam when it scrolls
    const tw = g.measureText(text).width, n = Math.max(1, Math.round(w / tw));
    g.scale(w / (n * tw), 1);
    for(let i = 0; i < n; i++) g.fillText(text, i * tw, h / 2 + 2);
  });
  const ledTex = {
    idle: ledMsg('NEAT LEAGUE  ·  VOLLYBALL LAB  ·  EVOLVED, NOT PROGRAMMED  ·  FOODSIM ARENA  ·  ', '#ffcf6b'),
    left: ledMsg('POINT BLUE!   POINT BLUE!   ', '#7fb6ff'),
    right: ledMsg('POINT ORANGE!   POINT ORANGE!   ', '#ffa47a')
  };
  for(const t of Object.values(ledTex)){ t.wrapS = THREE.RepeatWrapping; t.repeat.set(2, 1); }
  const ledMat = new THREE.MeshStandardMaterial({map: ledTex.idle, emissiveMap: ledTex.idle, emissive: '#ffffff', emissiveIntensity: 1.1, roughness: 0.5});
  const ledBack = new THREE.Mesh(new THREE.BoxGeometry(2 * HALF_L + 2, 0.34, 0.06), ledMat);
  ledBack.position.set(0, 0.17, -(WALL_Z + 0.35)); scene.add(ledBack);
  for(const sx of [-1, 1]){
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 2 * WALL_Z), ledMat);
    b.position.set(sx * (HALF_L + 1.0), 0.17, 0); scene.add(b);
  }

  // ---------- players and balls ----------
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
  const sphGeo = new THREE.SphereGeometry(1, 18, 12);
  const hairGeo = new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52);
  const eyeGeo = new THREE.SphereGeometry(1, 8, 6);
  const KIND_MAT = {
    arm: new THREE.MeshStandardMaterial({color: '#50f0aa', transparent: true, opacity: 0.75}),
    leg: new THREE.MeshStandardMaterial({color: '#ffd45a', transparent: true, opacity: 0.75}),
    body: new THREE.MeshStandardMaterial({color: '#ff648c', transparent: true, opacity: 0.6})
  };

  function segColor(p, i){
    const team = COLORS[p.team], app = p.app, part = p.segs[i].part;
    const back = i < 3 || (i >= 6 && i < 9);
    const sk = back ? app.skinDark : app.skin;
    switch(part){
      case 'upper': return back ? team.dark : team.main;
      case 'fore': case 'hand': case 'shin': case 'neck': case 'head': return sk;
      case 'thigh': return team.dark;
      case 'foot': return '#f4f6ff';
      default: return team.main;
    }
  }

  function buildRig(p){
    const group = new THREE.Group();
    const parts = p.segs.map((s, i)=>{
      const m = mat(segColor(p, i));
      const cyl = new THREE.Mesh(cylGeo, m), a = new THREE.Mesh(sphGeo, m), b = new THREE.Mesh(sphGeo, m);
      for(const o of [cyl, a, b]){ o.castShadow = true; group.add(o); }
      return {cyl, a, b, base: m};
    });
    const headGroup = new THREE.Group();
    const hair = new THREE.Mesh(hairGeo, mat(p.app.hair, {roughness: 0.85}));
    hair.castShadow = true;
    headGroup.add(hair);
    const eyes = [];
    for(const z of [-1, 1]){
      const white = new THREE.Mesh(eyeGeo, mat('#f7f8ff', {roughness: 0.3}));
      const pupil = new THREE.Mesh(eyeGeo, mat('#14182c', {roughness: 0.3}));
      headGroup.add(white, pupil); eyes.push({white, pupil, z});
    }
    const band = p.app.band ? new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 6, 24), mat(COLORS[p.team].main)) : null;
    if(band) headGroup.add(band);
    group.add(headGroup);
    const pads = [0, 1].map(()=>{ const k = new THREE.Mesh(sphGeo, mat('#20263f')); group.add(k); return k; });
    scene.add(group);
    return {group, parts, headGroup, hair, eyes, band, pads, extras: [hair, ...pads, ...(band ? [band] : []), ...eyes.flatMap((e)=> [e.white, e.pupil])]};
  }

  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(), tmp = new THREE.Vector3();
  function placeCapsule(part, s){
    const x1 = X(s.ax), y1 = Y(s.ay), z1 = Z(s.az), x2 = X(s.bx), y2 = Y(s.by), z2 = Z(s.bz), rr = s.r / U;
    part.a.position.set(x1, y1, z1); part.a.scale.setScalar(rr);
    part.b.position.set(x2, y2, z2); part.b.scale.setScalar(rr);
    dir.set(x2 - x1, y2 - y1, z2 - z1);
    const len = dir.length();
    if(len < 1e-5){ part.cyl.visible = false; part.b.visible = false; return; }
    part.cyl.visible = true; part.b.visible = true;
    part.cyl.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    part.cyl.quaternion.setFromUnitVectors(up, dir.multiplyScalar(1 / len));
    part.cyl.scale.set(rr, len, rr);
  }

  function updateRig(rig, p, hitboxes){
    const segs = p.segs;
    for(let i = 0; i < segs.length; i++){
      const s = segs[i], part = rig.parts[i];
      placeCapsule(part, s);
      const m = hitboxes ? KIND_MAT[s.kind] : part.base;
      if(part.cyl.material !== m){ part.cyl.material = m; part.a.material = m; part.b.material = m; }
    }
    for(const e of rig.extras) e.visible = !hitboxes;
    const hd = segs[14], rh = hd.r / U, f = p.facing;
    rig.headGroup.position.set(X(hd.ax), Y(hd.ay), Z(hd.az));
    rig.headGroup.rotation.set(0, 0, -p.rot);
    rig.hair.scale.set(rh * 1.015, rh * 1.015, rh * 1.015);
    rig.hair.rotation.set(0, 0, f * (p.app.style === 2 ? 0.7 : 0.35));
    if(rig.band){ rig.band.rotation.set(Math.PI / 2, 0, 0); rig.band.position.set(0, rh * 0.38, 0); rig.band.scale.setScalar(rh * 0.9); }
    let lx = 0, ly = 0;
    if(p.focus){
      tmp.set(X(p.focus.x) - X(hd.ax), Y(p.focus.y) - Y(hd.ay), 0).normalize();
      const c = Math.cos(p.rot), sn = Math.sin(p.rot);   // back into the head's frame
      lx = tmp.x * c - tmp.y * sn; ly = tmp.x * sn + tmp.y * c;
    }
    for(const e of rig.eyes){
      e.white.position.set(f * rh * 0.72, rh * 0.12, e.z * rh * 0.42);
      e.white.scale.setScalar(rh * 0.2);
      e.pupil.position.set(f * rh * 0.84 + lx * rh * 0.04, rh * 0.12 + ly * rh * 0.05, e.z * rh * 0.45);
      e.pupil.scale.setScalar(rh * 0.1);
    }
    for(let k = 0; k < 2; k++){
      const th = segs[6 + k * 3];
      rig.pads[k].position.set(X(th.bx), Y(th.by), Z(th.bz));
      rig.pads[k].scale.setScalar(th.r / U * 1.0);
    }
  }

  const ballTex = canvasTex(512, 256, (g, w, h)=>{
    g.fillStyle = '#f7ecbd'; g.fillRect(0, 0, w, h);
    const stripes = ['#3987e5', '#f7ecbd', '#ffd36b', '#f7ecbd', '#3987e5', '#f7ecbd'];
    for(let i = 0; i < 6; i++){
      g.fillStyle = stripes[i];
      g.beginPath();
      for(let x = 0; x <= w; x += 8){ const y = (i + 0.5) * h / 6 + Math.sin(x / w * Math.PI * 6) * 10; x === 0 ? g.moveTo(x, y - 14) : g.lineTo(x, y - 14); }
      for(let x = w; x >= 0; x -= 8){ const y = (i + 0.5) * h / 6 + Math.sin(x / w * Math.PI * 6) * 10; g.lineTo(x, y + 14); }
      g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(60,40,10,0.35)'; g.lineWidth = 2;
    for(let i = 1; i < 6; i++){ g.beginPath(); g.moveTo(0, i * h / 6); g.lineTo(w, i * h / 6); g.stroke(); }
  });
  const ballMat = new THREE.MeshStandardMaterial({map: ballTex, roughness: 0.45});
  const ballHit = new THREE.MeshStandardMaterial({color: '#ffffff', transparent: true, opacity: 0.55, roughness: 0.3});
  const ballMeshes = [];
  function ballMesh(i){
    while(ballMeshes.length <= i){
      const m = new THREE.Mesh(sphGeo, ballMat);
      m.castShadow = true;
      scene.add(m);
      ballMeshes.push(m);
    }
    return ballMeshes[i];
  }

  // ---------- camera control ----------
  const target = new THREE.Vector3(0, 1.7, 0);
  const presets = {
    broadcast: {az: 0.3, el: 0.26, dist: 13},
    low: {az: -0.38, el: 0.06, dist: 8.5},
    end: {az: -1.2, el: 0.24, dist: 12},
    orbit: {az: 0, el: 0.28, dist: 14}
  };
  const camState = Object.assign({mode: 'broadcast'}, presets.broadcast);
  const camGoal = Object.assign({}, presets.broadcast);
  function setCamera(name){
    camState.mode = name;
    Object.assign(camGoal, presets[name] || presets.broadcast);
  }
  let drag = null;
  host.addEventListener('pointerdown', (e)=>{
    if(!active) return;
    drag = {x: e.clientX, y: e.clientY};
    host.setPointerCapture?.(e.pointerId);
  });
  host.addEventListener('pointermove', (e)=>{
    if(!active || !drag) return;
    camGoal.az -= (e.clientX - drag.x) * 0.006;
    camGoal.el = Math.max(0.02, Math.min(1.2, camGoal.el + (e.clientY - drag.y) * 0.004));
    drag = {x: e.clientX, y: e.clientY};
    if(camState.mode === 'orbit') camState.mode = 'free';
  });
  const endDrag = ()=>{ drag = null; };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);
  host.addEventListener('wheel', (e)=>{
    if(!active) return;
    e.preventDefault();
    camGoal.dist = Math.max(5, Math.min(24, camGoal.dist * (1 + Math.sign(e.deltaY) * 0.08)));
  }, {passive: false});

  // ---------- frame ----------
  const rigs = new Map();
  let active = false;
  let lastT = performance.now();
  let ledState = 'idle';

  function resize(){
    const r = host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3(), e3 = new THREE.Euler();
  function updateCrowd(match, now){
    const t = now / 1000;
    const hype = match ? match.hype : 0.15;
    const waveX = match && match.rallyCrossings >= 6 ? ((t * 0.32) % 1.5 - 0.25) * 2 * (HALF_L + 2) - (HALF_L + 2) : -999;
    for(let i = 0; i < fans.length; i++){
      const f = fans[i];
      const cheer = match && match.cheer && match.cheer.team === f.side ? Math.min(1, match.cheer.life) : 0;
      const wd = (f.x - waveX) / 1.2, w = Math.exp(-wd * wd);
      const energy = Math.min(1, hype * 0.8 + cheer + w);
      const phase = Math.sin(t * (6 + energy * 6) + f.phase);
      const lift = Math.max(0, phase) * (0.01 + energy * 0.09) + w * 0.12 + cheer * 0.05;
      const standing = w > 0.45 || cheer > 0.2 || (energy > 0.6 && phase > 0.4);
      const by = f.y + 0.2 + lift + (standing ? 0.08 : 0);
      e3.set(0, f.rot, 0); q.setFromEuler(e3);
      m4.compose(p3.set(f.x, by, f.z), q, s3.set(1, 1, 1));
      bodies.setMatrixAt(i, m4);
      m4.compose(p3.set(f.x, by + 0.3, f.z), q, s3.set(1, 1, 1));
      heads.setMatrixAt(i, m4);
      for(let k = 0; k < 2; k++){
        const side = k ? 1 : -1;
        // local x offset rotated with the fan's facing
        const ox = Math.cos(f.rot) * side * 0.16, oz = -Math.sin(f.rot) * side * 0.16;
        if(standing){
          e3.set(0, f.rot, side * -0.25); q.setFromEuler(e3);
          m4.compose(p3.set(f.x + ox, by + 0.35, f.z + oz), q, s3.set(1, 1, 1));
        } else {
          e3.set(0, f.rot, 0); q.setFromEuler(e3);
          m4.compose(p3.set(f.x + ox * 0.9, by - 0.02, f.z + oz * 0.9), q, s3.set(1, 0.85, 1));
        }
        arms.setMatrixAt(i * 2 + k, m4);
      }
    }
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    arms.instanceMatrix.needsUpdate = true;
  }

  function render(match, now, opts = {}){
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    // camera easing
    if(camState.mode === 'orbit') camGoal.az += dt * 0.12;
    const k = 1 - Math.exp(-dt * 4);
    camState.az += (camGoal.az - camState.az) * k;
    camState.el += (camGoal.el - camState.el) * k;
    camState.dist += (camGoal.dist - camState.dist) * k;
    camera.position.set(
      target.x + Math.sin(camState.az) * Math.cos(camState.el) * camState.dist,
      target.y + Math.sin(camState.el) * camState.dist,
      target.z + Math.cos(camState.az) * Math.cos(camState.el) * camState.dist
    );
    camera.lookAt(target);

    // players: rebuild rigs when the match (and so its Player objects) changes
    const seen = new Set();
    if(match){
      for(const p of match.players){
        let rig = rigs.get(p);
        if(!rig){ rig = buildRig(p); rigs.set(p, rig); }
        updateRig(rig, p, !!opts.hitboxes);
        seen.add(p);
      }
    }
    for(const [p, rig] of rigs){
      if(!seen.has(p)){ scene.remove(rig.group); rigs.delete(p); }
    }
    const balls = match ? match.balls : [];
    for(let i = 0; i < ballMeshes.length; i++) ballMeshes[i].visible = i < balls.length;
    balls.forEach((b, i)=>{
      const m = ballMesh(i);
      m.position.set(X(b.x), Y(b.y), Z(b.z));
      m.scale.setScalar(api.getBallR() / U);
      m.rotation.set(0.4, 0, -b.angle);
      m.material = opts.hitboxes ? ballHit : ballMat;
    });

    updateCrowd(match, now);
    const want = match && match.cheer ? match.cheer.team : 'idle';
    if(want !== ledState){
      ledState = want;
      ledMat.map = ledTex[want]; ledMat.emissiveMap = ledTex[want]; ledMat.needsUpdate = true;
    }
    ledTex[ledState].offset.x = (now / 1000 * 0.05) % 1;

    renderer.render(scene, camera);
  }

  // Simulation point -> CSS pixels inside the host (for text and sparks drawn on the 2D overlay).
  function project(x, y, z = 0){
    p3.set(X(x), Y(y), Z(z)).project(camera);
    const r = host.getBoundingClientRect();
    return {x: (p3.x + 1) / 2 * r.width, y: (1 - p3.y) / 2 * r.height, visible: p3.z < 1};
  }

  return {
    render, project, setCamera, resize,
    setActive(on){ active = on; cv.style.display = on ? 'block' : 'none'; if(on){ resize(); lastT = performance.now(); } },
    get camera(){ return camState.mode; }
  };
}

function mulberry(seed){
  let a = seed >>> 0;
  return ()=>{
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
