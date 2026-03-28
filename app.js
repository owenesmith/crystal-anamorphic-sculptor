/**
 * Crystal Anamorphic Sculptor — Main Application
 *
 * Orchestrates the UI, 3D viewport, slicing, anamorphic transform, and export.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { sliceMesh, splitGeometryByPlane } from './slicer.js';
import { applyAnamorphicTransform, transformSinglePiece, computeCentroid } from './anamorphic.js';
import { SeededRandom } from './random.js';

// ─── Color palette for sliced pieces ──────────────────────────────────────────
const PIECE_COLORS = [
  0xff6b6b, 0x4ecdc4, 0xffe66d, 0xa29bfe, 0xfd79a8,
  0x00cec9, 0xfab1a0, 0x74b9ff, 0x55efc4, 0xdfe6e9,
  0xe17055, 0x0984e3, 0x6c5ce7, 0xfdcb6e, 0xe84393,
  0x00b894, 0xf8a5c2, 0x778beb, 0xf3a683, 0x63cdda
];

// ─── App State ────────────────────────────────────────────────────────────────
const state = {
  rawGeometry: null,          // THREE.BufferGeometry before rotation (preserved for re-rotation)
  originalGeometry: null,     // THREE.BufferGeometry after rotation, ready for slicing
  originalMesh: null,         // THREE.Mesh displayed as transparent reference
  crystalBox: null,           // Wireframe for crystal bounds
  innerBox: null,             // Wireframe for usable volume
  viewerIndicator: null,      // Cone showing viewer position
  transformedGroup: null,     // THREE.Group holding transformed pieces
  fileName: null,
  // Piece selection state
  selectedPieceIndex: null,
  pieceRegistry: [],          // Per-piece metadata: { originalGeo, centroid, zSlot, colorIndex }
  lastBounds: null,           // Usable bounds from last transform
  lastViewerPos: null,        // Viewer position from last transform
  lastRefractiveIndex: 1.0,   // Refractive index from last transform
  lastCapFaces: true,          // Whether to cap sliced faces
};

// ─── Three.js Setup ───────────────────────────────────────────────────────────
const container = document.getElementById('viewport-container');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x111122);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(80, 60, 120);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.1;

// Lighting
const ambientLight = new THREE.AmbientLight(0x404060, 1.5);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(50, 80, 60);
scene.add(dirLight);

// Grid helper for reference
const gridHelper = new THREE.GridHelper(200, 20, 0x333355, 0x222244);
scene.add(gridHelper);

// Axis helper — RGB = XYZ, positioned at corner away from crystal
const axesGroup = new THREE.Group();
axesGroup.position.set(-60, -40, -30);
const axesHelper = new THREE.AxesHelper(15);
axesGroup.add(axesHelper);

function makeAxisLabel(text, color, position) {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 48px sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(position);
  sprite.scale.set(5, 5, 1);
  return sprite;
}
axesGroup.add(makeAxisLabel('X', '#ff4444', new THREE.Vector3(18, 0, 0)));
axesGroup.add(makeAxisLabel('Y', '#44ff44', new THREE.Vector3(0, 18, 0)));
axesGroup.add(makeAxisLabel('Z', '#4444ff', new THREE.Vector3(0, 0, 18)));
scene.add(axesGroup);

// ─── Resize Handling ──────────────────────────────────────────────────────────
function onResize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);
onResize();

// ─── Animation Loop ───────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ─── UI Element References ────────────────────────────────────────────────────
const ui = {
  fileInput:    document.getElementById('file-input'),
  fileName:     document.getElementById('file-name'),
  rotX:         document.getElementById('rot-x'),
  rotY:         document.getElementById('rot-y'),
  rotZ:         document.getElementById('rot-z'),
  crystalX:     document.getElementById('crystal-x'),
  crystalY:     document.getElementById('crystal-y'),
  crystalZ:     document.getElementById('crystal-z'),
  inset:        document.getElementById('inset'),
  viewDist:     document.getElementById('view-dist'),
  refractIdx:   document.getElementById('refract-idx'),
  slicesRange:  document.getElementById('slices-range'),
  slicesNum:    document.getElementById('slices-num'),
  sliceMode:    document.getElementById('slice-mode'),
  spreadToggle: document.getElementById('spread-toggle'),
  jitterAmount: document.getElementById('jitter-amount'),
  seed:         document.getElementById('seed'),
  btnPreview:   document.getElementById('btn-preview'),
  btnReset:     document.getElementById('btn-reset'),
  capFacesToggle: document.getElementById('cap-faces-toggle'),
  exportFormat: document.getElementById('export-format'),
  btnExport:    document.getElementById('btn-export'),
  errorMsg:     document.getElementById('error-msg'),
  warningMsg:   document.getElementById('warning-msg'),
  statusBar:    document.getElementById('status-bar'),
  // Piece selection controls
  pieceControls: document.getElementById('piece-controls'),
  pieceLabel:    document.getElementById('piece-label'),
  pieceZSlider:  document.getElementById('piece-z-slider'),
  pieceZValue:   document.getElementById('piece-z-value'),
  btnSplitPiece: document.getElementById('btn-split-piece'),
  btnDeselect:   document.getElementById('btn-deselect'),
  // New controls
  btnUndo:       document.getElementById('btn-undo'),
  btnRedo:       document.getElementById('btn-redo'),
  btnViewEye:    document.getElementById('btn-view-eye'),
  btnTurntable:  document.getElementById('btn-turntable'),
  btnSaveProject:  document.getElementById('btn-save-project'),
  btnLoadProject:  document.getElementById('btn-load-project'),
  projectFileInput: document.getElementById('project-file-input'),
};

// Sync sliders
ui.slicesRange.addEventListener('input', () => { ui.slicesNum.value = ui.slicesRange.value; });
ui.slicesNum.addEventListener('input', () => { ui.slicesRange.value = ui.slicesNum.value; });

// Randomize seed button
document.getElementById('btn-randomize-seed').addEventListener('click', () => {
  ui.seed.value = Math.floor(Math.random() * 999999);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showError(msg) {
  ui.errorMsg.textContent = msg;
  ui.errorMsg.style.display = 'block';
  setTimeout(() => { ui.errorMsg.style.display = 'none'; }, 6000);
}

function showWarning(msg) {
  ui.warningMsg.textContent = msg;
  ui.warningMsg.style.display = 'block';
  setTimeout(() => { ui.warningMsg.style.display = 'none'; }, 8000);
}

function clearMessages() {
  ui.errorMsg.style.display = 'none';
  ui.warningMsg.style.display = 'none';
}

function setStatus(msg) {
  ui.statusBar.textContent = msg;
}

function getParams() {
  return {
    crystalSize: new THREE.Vector3(
      parseFloat(ui.crystalX.value),
      parseFloat(ui.crystalY.value),
      parseFloat(ui.crystalZ.value)
    ),
    inset: parseFloat(ui.inset.value),
    viewDist: parseFloat(ui.viewDist.value),
    numSlices: parseInt(ui.slicesNum.value),
    sliceMode: ui.sliceMode.value,
    spreadEnabled: ui.spreadToggle.checked,
    jitterAmount: parseFloat(ui.jitterAmount.value),
    seed: parseInt(ui.seed.value),
    refractiveIndex: parseFloat(ui.refractIdx.value),
    capFaces: ui.capFacesToggle.checked,
  };
}

function getUsableBounds() {
  const p = getParams();
  const ins = p.inset;
  const usableX = p.crystalSize.x - 2 * ins;
  const usableY = p.crystalSize.y - 2 * ins;
  const usableZ = p.crystalSize.z - 2 * ins;
  return {
    minX: -usableX / 2, maxX: usableX / 2,
    minY: -usableY / 2, maxY: usableY / 2,
    minZ: ins, maxZ: p.crystalSize.z - ins,
  };
}

// ─── Crystal Bounds Visualization ─────────────────────────────────────────────
function updateCrystalBounds() {
  const p = getParams();
  const cx = p.crystalSize.x, cy = p.crystalSize.y, cz = p.crystalSize.z;

  // Remove old boxes
  if (state.crystalBox) scene.remove(state.crystalBox);
  if (state.innerBox) scene.remove(state.innerBox);
  if (state.viewerIndicator) scene.remove(state.viewerIndicator);

  // Outer crystal wireframe — centered at origin with front face at Z=0, back face at Z=cz
  const outerGeo = new THREE.BoxGeometry(cx, cy, cz);
  const outerEdges = new THREE.EdgesGeometry(outerGeo);
  state.crystalBox = new THREE.LineSegments(outerEdges, new THREE.LineBasicMaterial({ color: 0x888899 }));
  state.crystalBox.position.set(0, 0, cz / 2); // center of box at (0, 0, cz/2)
  scene.add(state.crystalBox);

  // Inner usable volume wireframe
  const ins = p.inset;
  const ix = cx - 2 * ins, iy = cy - 2 * ins, iz = cz - 2 * ins;
  if (ix > 0 && iy > 0 && iz > 0) {
    const innerGeo = new THREE.BoxGeometry(ix, iy, iz);
    const innerEdges = new THREE.EdgesGeometry(innerGeo);
    state.innerBox = new THREE.LineSegments(innerEdges, new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.5 }));
    state.innerBox.position.set(0, 0, cz / 2);
    scene.add(state.innerBox);
  }

  // Viewer position indicator (a small cone pointing toward the crystal)
  const coneGeo = new THREE.ConeGeometry(3, 10, 8);
  const coneMat = new THREE.MeshBasicMaterial({ color: 0xffaa33 });
  state.viewerIndicator = new THREE.Mesh(coneGeo, coneMat);
  state.viewerIndicator.position.set(0, 0, -p.viewDist);
  state.viewerIndicator.rotation.x = Math.PI / 2;
  scene.add(state.viewerIndicator);
}

// Update bounds whenever parameters change
['crystal-x', 'crystal-y', 'crystal-z', 'inset', 'view-dist'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateCrystalBounds);
});
updateCrystalBounds();

// ─── Load STL ─────────────────────────────────────────────────────────────────
function loadSTL(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const loader = new STLLoader();
      const geometry = loader.parse(e.target.result);

      // Center the mesh at the origin (no scaling — scaling happens after rotation)
      geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      geometry.boundingBox.getCenter(center);
      geometry.translate(-center.x, -center.y, -center.z);

      geometry.computeBoundingBox();
      geometry.computeVertexNormals();

      // Store raw geometry (centered at origin, unscaled, unrotated)
      state.rawGeometry = geometry;
      state.fileName = file.name;

      // Apply rotation + scale to fit (also sets state.originalGeometry and updates mesh)
      applyModelRotation();

      // Auto-fit camera
      fitCameraToScene();

      ui.fileName.textContent = file.name;
      setStatus(`Loaded: ${file.name} (${(geometry.attributes.position.count / 3)|0} triangles)`);
    } catch (err) {
      showError('Failed to parse STL file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ─── Model Rotation ───────────────────────────────────────────────────────────
function applyModelRotation() {
  if (!state.rawGeometry) return;

  const rx = THREE.MathUtils.degToRad(parseFloat(ui.rotX.value) || 0);
  const ry = THREE.MathUtils.degToRad(parseFloat(ui.rotY.value) || 0);
  const rz = THREE.MathUtils.degToRad(parseFloat(ui.rotZ.value) || 0);

  const p = getParams();
  const ins = p.inset;

  // Clone raw geometry (centered at origin) and apply rotation
  const geo = state.rawGeometry.clone();
  geo.rotateX(rx);
  geo.rotateY(ry);
  geo.rotateZ(rz);

  // Now scale to fit the usable volume (post-rotation bounding box)
  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);

  const usable = new THREE.Vector3(
    p.crystalSize.x - 2 * ins,
    p.crystalSize.y - 2 * ins,
    p.crystalSize.z - 2 * ins
  );

  const scaleFactor = Math.min(
    usable.x / size.x,
    usable.y / size.y,
    usable.z / size.z
  );

  geo.scale(scaleFactor, scaleFactor, scaleFactor);

  // Position so model center is at (0, 0, crystalZ/2)
  geo.translate(0, 0, p.crystalSize.z / 2);

  geo.computeBoundingBox();
  geo.computeVertexNormals();

  state.originalGeometry = geo;

  // Update reference mesh
  if (state.originalMesh) scene.remove(state.originalMesh);
  const mat = new THREE.MeshPhongMaterial({
    color: 0x888888,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  state.originalMesh = new THREE.Mesh(geo.clone(), mat);
  scene.add(state.originalMesh);
}

// Listen for rotation changes
['rot-x', 'rot-y', 'rot-z'].forEach(id => {
  document.getElementById(id).addEventListener('change', applyModelRotation);
});

ui.fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) loadSTL(e.target.files[0]);
});

// ─── Camera Fitting ───────────────────────────────────────────────────────────
function fitCameraToScene() {
  const p = getParams();
  const maxDim = Math.max(p.crystalSize.x, p.crystalSize.y, p.crystalSize.z);
  const dist = maxDim * 2.5;
  camera.position.set(dist * 0.6, dist * 0.5, dist * 0.8);
  controls.target.set(0, 0, p.crystalSize.z / 2);
  controls.update();
}

// ─── Piece Selection ──────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let pointerDownPos = null;
let pointerDownTime = 0;

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
  pointerDownTime = performance.now();
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const elapsed = performance.now() - pointerDownTime;
  pointerDownPos = null;

  // Only treat as click if minimal movement and short duration
  if (dist < 5 && elapsed < 300) {
    handlePieceClick(e);
  }
});

function handlePieceClick(event) {
  if (!state.transformedGroup || state.transformedGroup.children.length === 0) return;

  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(state.transformedGroup.children);

  if (intersects.length > 0) {
    const index = state.transformedGroup.children.indexOf(intersects[0].object);
    if (index !== -1) selectPiece(index);
  } else {
    deselectPiece();
  }
}

function selectPiece(index) {
  state.selectedPieceIndex = index;
  const reg = state.pieceRegistry[index];

  // Highlight selected, dim others
  state.transformedGroup.children.forEach((child, i) => {
    if (i === index) {
      child.material.opacity = 1.0;
      child.material.emissive.setHex(0x224488);
    } else {
      child.material.opacity = 0.25;
      child.material.emissive.setHex(0x000000);
    }
  });

  // Show piece controls
  ui.pieceControls.style.display = '';
  ui.pieceLabel.textContent = `#${index + 1} / ${state.pieceRegistry.length}`;

  // Configure slider
  const bounds = state.lastBounds;
  ui.pieceZSlider.min = bounds.minZ;
  ui.pieceZSlider.max = bounds.maxZ;
  ui.pieceZSlider.value = reg.zSlot;
  ui.pieceZValue.textContent = reg.zSlot.toFixed(1) + ' mm';

  setStatus(`Selected piece ${index + 1}`);
}

function deselectPiece() {
  state.selectedPieceIndex = null;

  if (state.transformedGroup) {
    state.transformedGroup.children.forEach(child => {
      child.material.opacity = 0.75;
      child.material.emissive.setHex(0x000000);
    });
  }

  ui.pieceControls.style.display = 'none';
}

// Z-depth slider — real-time adjustment
ui.pieceZSlider.addEventListener('input', () => {
  if (state.selectedPieceIndex === null) return;

  const idx = state.selectedPieceIndex;
  const reg = state.pieceRegistry[idx];
  const newZ = parseFloat(ui.pieceZSlider.value);

  reg.zSlot = newZ;

  const result = transformSinglePiece(
    reg.originalGeo, reg.centroid, newZ,
    state.lastViewerPos, state.lastBounds, state.lastRefractiveIndex
  );

  const mesh = state.transformedGroup.children[idx];
  mesh.geometry.dispose();
  mesh.geometry = result.geometry;

  ui.pieceZValue.textContent = newZ.toFixed(1) + ' mm';
});

// Deselect button
ui.btnDeselect.addEventListener('click', deselectPiece);

// ─── Split Selected Piece ─────────────────────────────────────────────────────
ui.btnSplitPiece.addEventListener('click', () => {
  if (state.selectedPieceIndex === null) return;

  const idx = state.selectedPieceIndex;
  const reg = state.pieceRegistry[idx];
  const bounds = state.lastBounds;
  const viewerPos = state.lastViewerPos;

  // Generate cutting plane through piece centroid, fanning from viewer
  const dir = new THREE.Vector3().subVectors(reg.centroid, viewerPos).normalize();
  const rng = new SeededRandom(Date.now() & 0xFFFF);
  const arbitrary = new THREE.Vector3(
    rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)
  );
  const normal = arbitrary.addScaledVector(dir, -arbitrary.dot(dir)).normalize();
  const d = -normal.dot(reg.centroid);
  const plane = new THREE.Plane(normal, d);

  // Split the original (pre-transform) geometry
  const { front, back } = splitGeometryByPlane(reg.originalGeo, plane, state.lastCapFaces);

  if (!front || !back) {
    showWarning('Split produced only one piece — the cutting plane missed the geometry.');
    return;
  }

  // Assign Z-slots: offset from original position
  const usableZ = bounds.maxZ - bounds.minZ;
  const delta = usableZ / (state.pieceRegistry.length + 1);
  const zSlotA = Math.max(bounds.minZ, Math.min(bounds.maxZ, reg.zSlot - delta / 2));
  const zSlotB = Math.max(bounds.minZ, Math.min(bounds.maxZ, reg.zSlot + delta / 2));

  const centroidA = computeCentroid(front);
  const centroidB = computeCentroid(back);

  const resultA = transformSinglePiece(front, centroidA, zSlotA, viewerPos, bounds, state.lastRefractiveIndex);
  const resultB = transformSinglePiece(back, centroidB, zSlotB, viewerPos, bounds, state.lastRefractiveIndex);

  // Save references to all existing meshes before modifying
  const existingMeshes = [...state.transformedGroup.children];

  // Create two new meshes
  const colorA = reg.colorIndex;
  const colorB = state.pieceRegistry.length % PIECE_COLORS.length;

  const meshA = new THREE.Mesh(resultA.geometry, new THREE.MeshPhongMaterial({
    color: PIECE_COLORS[colorA], transparent: true, opacity: 0.75, side: THREE.DoubleSide,
  }));
  const meshB = new THREE.Mesh(resultB.geometry, new THREE.MeshPhongMaterial({
    color: PIECE_COLORS[colorB], transparent: true, opacity: 0.75, side: THREE.DoubleSide,
  }));

  // Dispose old mesh
  existingMeshes[idx].geometry.dispose();
  existingMeshes[idx].material.dispose();

  // Build new ordered list: replace old mesh at idx with meshA and meshB
  const newMeshList = [
    ...existingMeshes.slice(0, idx),
    meshA, meshB,
    ...existingMeshes.slice(idx + 1),
  ];

  // Clear group and re-add in order
  while (state.transformedGroup.children.length > 0) {
    state.transformedGroup.remove(state.transformedGroup.children[0]);
  }
  for (const m of newMeshList) {
    state.transformedGroup.add(m);
  }

  // Update registry: remove old entry, add two new ones
  state.pieceRegistry.splice(idx, 1,
    { originalGeo: front, centroid: centroidA, zSlot: zSlotA, colorIndex: colorA },
    { originalGeo: back, centroid: centroidB, zSlot: zSlotB, colorIndex: colorB }
  );

  deselectPiece();
  setStatus(`Split piece — now ${state.pieceRegistry.length} pieces total`);
});

// ─── Preview Transform ────────────────────────────────────────────────────────
function previewTransform() {
  clearMessages();
  deselectPiece();

  if (!state.originalGeometry) {
    showError('No STL file loaded. Please load a file first.');
    return;
  }

  const p = getParams();
  const ins = p.inset;

  // Validate usable volume
  const usableX = p.crystalSize.x - 2 * ins;
  const usableY = p.crystalSize.y - 2 * ins;
  const usableZ = p.crystalSize.z - 2 * ins;

  if (usableX <= 0 || usableY <= 0 || usableZ <= 0) {
    showError('Inset is too large — usable volume is zero or negative.');
    return;
  }

  setStatus('Slicing mesh...');

  // Hide reference mesh so it doesn't interfere with the transformed view
  if (state.originalMesh) state.originalMesh.visible = false;

  // Remove old transformed pieces
  if (state.transformedGroup) {
    scene.remove(state.transformedGroup);
    state.transformedGroup.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const rng = new SeededRandom(p.seed);

  try {
    const usableBounds = getUsableBounds();
    const viewerPos = new THREE.Vector3(0, 0, -p.viewDist);

    // Store for piece selection/adjustment
    state.lastBounds = usableBounds;
    state.lastViewerPos = viewerPos;
    state.lastRefractiveIndex = p.refractiveIndex;
    state.lastCapFaces = p.capFaces;

    const pieces = sliceMesh(
      state.originalGeometry,
      p.numSlices,
      p.sliceMode,
      usableBounds,
      rng,
      viewerPos,
      p.capFaces
    );

    if (pieces.length === 0) {
      showError('Slicing produced no pieces. Check your model and parameters.');
      return;
    }

    setStatus(`Applying anamorphic transform to ${pieces.length} pieces...`);

    const transformResult = applyAnamorphicTransform(
      pieces,
      viewerPos,
      p.viewDist,
      usableBounds,
      p.spreadEnabled,
      p.jitterAmount,
      rng,
      p.sliceMode,
      p.refractiveIndex
    );

    // Build visual representation and piece registry
    state.transformedGroup = new THREE.Group();
    state.pieceRegistry = [];

    transformResult.pieces.forEach((geo, i) => {
      const colorIndex = i % PIECE_COLORS.length;
      const color = PIECE_COLORS[colorIndex];
      const mat = new THREE.MeshPhongMaterial({
        color,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      state.transformedGroup.add(mesh);

      // Store piece metadata for selection/adjustment
      state.pieceRegistry.push({
        ...transformResult.pieceData[i],
        colorIndex,
      });
    });

    scene.add(state.transformedGroup);

    if (transformResult.clampedCount > 0) {
      showWarning(
        `${transformResult.clampedCount} pieces were clamped to fit within crystal bounds — ` +
        `consider reducing slice count or increasing inset.`
      );
    }

    setStatus(`Transform complete: ${pieces.length} pieces — click a piece to adjust`);
  } catch (err) {
    showError('Transform failed: ' + err.message);
    console.error(err);
  }
}

ui.btnPreview.addEventListener('click', previewTransform);

// ─── Reset View ───────────────────────────────────────────────────────────────
ui.btnReset.addEventListener('click', () => {
  fitCameraToScene();
});

// ─── Export (Multi-Format) ────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportModel() {
  if (!state.transformedGroup || state.transformedGroup.children.length === 0) {
    showError('No transformed model to export. Run Preview Transform first.');
    return;
  }

  const format = ui.exportFormat.value;
  const baseName = 'crystal_sculpture';

  setStatus(`Exporting ${format.toUpperCase()}...`);

  try {
    switch (format) {
      case 'stl': {
        const exporter = new STLExporter();
        const result = exporter.parse(state.transformedGroup, { binary: true });
        downloadBlob(new Blob([result], { type: 'application/octet-stream' }), `${baseName}.stl`);
        break;
      }
      case 'obj': {
        const exporter = new OBJExporter();
        const result = exporter.parse(state.transformedGroup);
        downloadBlob(new Blob([result], { type: 'text/plain' }), `${baseName}.obj`);
        break;
      }
      case 'amf': {
        const xml = exportAMF(state.transformedGroup);
        downloadBlob(new Blob([xml], { type: 'application/xml' }), `${baseName}.amf`);
        break;
      }
      case 'step': {
        const stepData = exportSTEP(state.transformedGroup);
        downloadBlob(new Blob([stepData], { type: 'application/step' }), `${baseName}.step`);
        break;
      }
    }
    setStatus(`Exported ${baseName}.${format}`);
  } catch (err) {
    showError('Export failed: ' + err.message);
    console.error(err);
  }
}

/**
 * Export group as AMF (Additive Manufacturing File Format).
 * AMF is an XML-based format that supports multiple objects with materials.
 */
function exportAMF(group) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<amf unit="millimeter" version="1.1">\n';
  xml += '  <metadata type="name">Crystal Anamorphic Sculpture</metadata>\n';
  xml += '  <metadata type="author">Crystal Anamorphic Sculptor</metadata>\n';

  group.children.forEach((mesh, objIdx) => {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;

    xml += `  <object id="${objIdx}">\n`;
    xml += '    <mesh>\n';
    xml += '      <vertices>\n';

    // Write all vertices
    for (let i = 0; i < pos.count; i++) {
      xml += `        <vertex><coordinates><x>${pos.getX(i)}</x><y>${pos.getY(i)}</y><z>${pos.getZ(i)}</z></coordinates></vertex>\n`;
    }
    xml += '      </vertices>\n';
    xml += '      <volume>\n';

    // Write triangles
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        xml += `        <triangle><v1>${idx.getX(i)}</v1><v2>${idx.getX(i + 1)}</v2><v3>${idx.getX(i + 2)}</v3></triangle>\n`;
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        xml += `        <triangle><v1>${i}</v1><v2>${i + 1}</v2><v3>${i + 2}</v3></triangle>\n`;
      }
    }

    xml += '      </volume>\n';
    xml += '    </mesh>\n';
    xml += '  </object>\n';
  });

  xml += '</amf>\n';
  return xml;
}

/**
 * Export group as STEP (ISO 10303-21 AP214).
 * Produces a minimal but valid STEP file with tessellated geometry.
 */
function exportSTEP(group) {
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  let entityId = 1;
  const e = () => `#${entityId++}`;

  // Collect all triangles from all meshes
  const allTriangles = [];
  group.children.forEach(mesh => {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        allTriangles.push([
          [pos.getX(idx.getX(i)), pos.getY(idx.getX(i)), pos.getZ(idx.getX(i))],
          [pos.getX(idx.getX(i+1)), pos.getY(idx.getX(i+1)), pos.getZ(idx.getX(i+1))],
          [pos.getX(idx.getX(i+2)), pos.getY(idx.getX(i+2)), pos.getZ(idx.getX(i+2))],
        ]);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        allTriangles.push([
          [pos.getX(i), pos.getY(i), pos.getZ(i)],
          [pos.getX(i+1), pos.getY(i+1), pos.getZ(i+1)],
          [pos.getX(i+2), pos.getY(i+2), pos.getZ(i+2)],
        ]);
      }
    }
  });

  // Build STEP data section entities
  const dataLines = [];
  const addEntity = (content) => {
    const id = e();
    dataLines.push(`${id} = ${content};`);
    return id;
  };

  // Shared direction/axis entities
  const dirZ = addEntity("DIRECTION('',( 0.0, 0.0, 1.0))");
  const dirX = addEntity("DIRECTION('',( 1.0, 0.0, 0.0))");
  const origin = addEntity("CARTESIAN_POINT('Origin',( 0.0, 0.0, 0.0))");
  const axis2 = addEntity(`AXIS2_PLACEMENT_3D('',${origin},${dirZ},${dirX})`);

  // Build unique vertex map and face entities
  const vertexMap = new Map();
  const getVertexId = (v) => {
    const key = `${v[0].toFixed(6)},${v[1].toFixed(6)},${v[2].toFixed(6)}`;
    if (!vertexMap.has(key)) {
      const cpId = addEntity(`CARTESIAN_POINT('',(${v[0]},${v[1]},${v[2]}))`);
      vertexMap.set(key, cpId);
    }
    return vertexMap.get(key);
  };

  const faceIds = [];

  for (const tri of allTriangles) {
    const cp0 = getVertexId(tri[0]);
    const cp1 = getVertexId(tri[1]);
    const cp2 = getVertexId(tri[2]);

    const vp0 = addEntity(`VERTEX_POINT('',${cp0})`);
    const vp1 = addEntity(`VERTEX_POINT('',${cp1})`);
    const vp2 = addEntity(`VERTEX_POINT('',${cp2})`);

    // Edges
    const edge01 = addEntity(`EDGE_CURVE('',${vp0},${vp1},${addEntity(`LINE('',${cp0},${addEntity(`VECTOR('',${dirZ},1.0)`)})`)},.T.)`);
    const edge12 = addEntity(`EDGE_CURVE('',${vp1},${vp2},${addEntity(`LINE('',${cp1},${addEntity(`VECTOR('',${dirZ},1.0)`)})`)},.T.)`);
    const edge20 = addEntity(`EDGE_CURVE('',${vp2},${vp0},${addEntity(`LINE('',${cp2},${addEntity(`VECTOR('',${dirZ},1.0)`)})`)},.T.)`);

    const oe01 = addEntity(`ORIENTED_EDGE('',*,*,${edge01},.T.)`);
    const oe12 = addEntity(`ORIENTED_EDGE('',*,*,${edge12},.T.)`);
    const oe20 = addEntity(`ORIENTED_EDGE('',*,*,${edge20},.T.)`);

    const edgeLoop = addEntity(`EDGE_LOOP('',(${oe01},${oe12},${oe20}))`);
    const faceBound = addEntity(`FACE_BOUND('',${edgeLoop},.T.)`);

    // Compute face normal for the plane
    const v0 = tri[0], v1 = tri[1], v2 = tri[2];
    const ax = v1[0]-v0[0], ay = v1[1]-v0[1], az = v1[2]-v0[2];
    const bx = v2[0]-v0[0], by = v2[1]-v0[1], bz = v2[2]-v0[2];
    let nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    nx /= len; ny /= len; nz /= len;

    const faceNorm = addEntity(`DIRECTION('',(${nx},${ny},${nz}))`);
    const facePlane = addEntity(`PLANE('',${addEntity(`AXIS2_PLACEMENT_3D('',${getVertexId(v0)},${faceNorm},${dirX})`)})`);
    const face = addEntity(`ADVANCED_FACE('',(${faceBound}),${facePlane},.T.)`);
    faceIds.push(face);
  }

  const closedShell = addEntity(`CLOSED_SHELL('',(${faceIds.join(',')}))`);
  const manifold = addEntity(`MANIFOLD_SOLID_BREP('Crystal Sculpture',${closedShell})`);

  // Product structure
  const prodCtx = addEntity("APPLICATION_CONTEXT('crystal sculpture')");
  const prodDef = addEntity(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${prodCtx})`);
  const prod = addEntity(`PRODUCT('Crystal Sculpture','Crystal Sculpture','',(${addEntity(`PRODUCT_CONTEXT('',${prodCtx},'mechanical')`)}))`);
  const prodDefForm = addEntity(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
  const prodDefCtx = addEntity(`PRODUCT_DEFINITION_CONTEXT('part definition',${prodCtx},'design')`);
  const productDef = addEntity(`PRODUCT_DEFINITION('design','',${prodDefForm},${prodDefCtx})`);
  const prodDefShape = addEntity(`PRODUCT_DEFINITION_SHAPE('','',${productDef})`);

  // Geometric context (units and uncertainty)
  const lengthUnit = addEntity("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))");
  const angleUnit = addEntity("(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))");
  const solidAngleUnit = addEntity("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())");
  const lengthUnit2 = addEntity("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))");
  const uncertainty = addEntity(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${lengthUnit2},'')`);
  const repCtx = addEntity(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3) ` +
    `GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) ` +
    `GLOBAL_UNIT_ASSIGNED_CONTEXT((${lengthUnit},${angleUnit},${solidAngleUnit})) ` +
    `REPRESENTATION_CONTEXT('Context3D','3D Context'))`
  );
  const shapeRep = addEntity(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${manifold},${axis2}),${repCtx})`);

  addEntity(`SHAPE_DEFINITION_REPRESENTATION(${prodDefShape},${shapeRep})`);

  // Assemble the full file
  let step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Crystal Anamorphic Sculpture'),'2;1');
FILE_NAME('crystal_sculpture.step','${now}',('Crystal Anamorphic Sculptor'),(''),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
${dataLines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;

  return step;
}

ui.btnExport.addEventListener('click', exportModel);

// ─── Undo / Redo ──────────────────────────────────────────────────────────────

const undoStack = [];
const redoStack = [];
const MAX_UNDO = 30;

function captureSnapshot() {
  if (!state.transformedGroup || state.pieceRegistry.length === 0) return null;
  return {
    registry: state.pieceRegistry.map(r => ({
      originalGeoData: serializeGeo(r.originalGeo),
      centroid: { x: r.centroid.x, y: r.centroid.y, z: r.centroid.z },
      zSlot: r.zSlot,
      colorIndex: r.colorIndex,
    })),
    bounds: { ...state.lastBounds },
    viewerPos: { x: state.lastViewerPos.x, y: state.lastViewerPos.y, z: state.lastViewerPos.z },
    refractiveIndex: state.lastRefractiveIndex,
    capFaces: state.lastCapFaces,
  };
}

function serializeGeo(geo) {
  const pos = geo.attributes.position;
  return Array.from(pos.array);
}

function deserializeGeo(data) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data), 3));
  geo.computeVertexNormals();
  return geo;
}

function pushUndo() {
  const snap = captureSnapshot();
  if (!snap) return;
  undoStack.push(snap);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  updateUndoRedoButtons();
}

function restoreSnapshot(snap) {
  deselectPiece();

  // Remove old group
  if (state.transformedGroup) {
    scene.remove(state.transformedGroup);
    state.transformedGroup.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  state.lastBounds = snap.bounds;
  state.lastViewerPos = new THREE.Vector3(snap.viewerPos.x, snap.viewerPos.y, snap.viewerPos.z);
  state.lastRefractiveIndex = snap.refractiveIndex;
  state.lastCapFaces = snap.capFaces;

  state.transformedGroup = new THREE.Group();
  state.pieceRegistry = [];

  for (const r of snap.registry) {
    const originalGeo = deserializeGeo(r.originalGeoData);
    const centroid = new THREE.Vector3(r.centroid.x, r.centroid.y, r.centroid.z);
    const result = transformSinglePiece(originalGeo, centroid, r.zSlot, state.lastViewerPos, state.lastBounds, state.lastRefractiveIndex);
    const mesh = new THREE.Mesh(result.geometry, new THREE.MeshPhongMaterial({
      color: PIECE_COLORS[r.colorIndex], transparent: true, opacity: 0.75, side: THREE.DoubleSide,
    }));
    state.transformedGroup.add(mesh);
    state.pieceRegistry.push({
      originalGeo, centroid, zSlot: r.zSlot, colorIndex: r.colorIndex,
    });
  }

  scene.add(state.transformedGroup);
  setStatus(`${state.pieceRegistry.length} pieces`);
}

function undo() {
  if (undoStack.length === 0) return;
  const current = captureSnapshot();
  if (current) redoStack.push(current);
  restoreSnapshot(undoStack.pop());
  updateUndoRedoButtons();
}

function redo() {
  if (redoStack.length === 0) return;
  const current = captureSnapshot();
  if (current) undoStack.push(current);
  restoreSnapshot(redoStack.pop());
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  ui.btnUndo.disabled = undoStack.length === 0;
  ui.btnRedo.disabled = redoStack.length === 0;
}

ui.btnUndo.addEventListener('click', undo);
ui.btnRedo.addEventListener('click', redo);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
  }
});

// Hook into actions that modify pieces — push undo before they execute

// Wrap the preview button to push undo before transform
const origPreviewHandler = previewTransform;
function previewWithUndo() {
  pushUndo();
  origPreviewHandler();
  updateUndoRedoButtons();
}
ui.btnPreview.removeEventListener('click', previewTransform);
ui.btnPreview.addEventListener('click', previewWithUndo);

// Wrap split piece to push undo
const origSplitHandler = ui.btnSplitPiece.onclick;
ui.btnSplitPiece.addEventListener('click', () => { pushUndo(); }, true);

// Push undo on z-slider change (debounced — only on pointerup/change)
ui.pieceZSlider.addEventListener('pointerdown', () => { pushUndo(); });

// ─── View From Eye ────────────────────────────────────────────────────────────

function viewFromEye() {
  const p = getParams();
  // The viewer looks straight along +Z through the front face origin (0,0,0).
  // The anamorphic projection math uses viewerPos = (0, 0, -viewDist) with rays
  // cast through the crystal. The camera target must be directly ahead on the Z axis
  // so the camera looks straight into the crystal, not at an angle.
  const eyePos = new THREE.Vector3(0, 0, -p.viewDist);
  const lookTarget = new THREE.Vector3(0, 0, 0); // front face center

  // Animate smoothly from current to eye position
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const duration = 600;
  const startTime = performance.now();

  function animateToEye() {
    const elapsed = performance.now() - startTime;
    const t = Math.min(1, elapsed / duration);
    const ease = t * (2 - t); // ease-out quadratic

    camera.position.lerpVectors(startPos, eyePos, ease);
    controls.target.lerpVectors(startTarget, lookTarget, ease);
    camera.up.set(0, 1, 0);
    controls.update();

    if (t < 1) requestAnimationFrame(animateToEye);
  }
  animateToEye();
  setStatus('Viewing from eye position');
}

ui.btnViewEye.addEventListener('click', viewFromEye);

// ─── Turntable Animation ──────────────────────────────────────────────────────

let turntableRunning = false;

function turntable() {
  if (turntableRunning) return;
  turntableRunning = true;
  ui.btnTurntable.disabled = true;

  const p = getParams();
  const lookTarget = new THREE.Vector3(0, 0, 0); // front face center — same as viewFromEye
  const eyePos = new THREE.Vector3(0, 0, -p.viewDist);

  // Orbit radius = distance from front face origin to eye position
  const radius = eyePos.distanceTo(lookTarget);

  // Orbit around the front face origin on the Y=0 plane.
  // End angle: eye is at (0, 0, -viewDist), target at (0,0,0) → angle = 0
  const endAngle = 0;
  const startAngle = Math.PI / 2; // 90 degrees (side view from +X)
  const duration = 2000;
  const startTime = performance.now();

  function animateTurntable() {
    const elapsed = performance.now() - startTime;
    const t = Math.min(1, elapsed / duration);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease in-out

    const angle = startAngle + (endAngle - startAngle) * ease;

    // Orbit on Y=0 plane around front face origin
    camera.position.set(
      Math.sin(angle) * radius,
      0,
      -Math.cos(angle) * radius
    );
    controls.target.copy(lookTarget);
    camera.up.set(0, 1, 0);
    controls.update();

    if (t < 1) {
      requestAnimationFrame(animateTurntable);
    } else {
      // Snap to exact eye position at the end
      camera.position.copy(eyePos);
      controls.target.copy(lookTarget);
      controls.update();
      turntableRunning = false;
      ui.btnTurntable.disabled = false;
      setStatus('Viewing from eye position');
    }
  }
  animateTurntable();
  setStatus('Turntable...');
}

ui.btnTurntable.addEventListener('click', turntable);

// ─── Save / Load Project ──────────────────────────────────────────────────────

function saveProject() {
  const p = getParams();

  const project = {
    version: 1,
    params: {
      crystalX: p.crystalSize.x, crystalY: p.crystalSize.y, crystalZ: p.crystalSize.z,
      inset: p.inset,
      viewDist: p.viewDist,
      refractiveIndex: p.refractiveIndex,
      numSlices: p.numSlices,
      sliceMode: p.sliceMode,
      capFaces: p.capFaces,
      spreadEnabled: p.spreadEnabled,
      jitterAmount: p.jitterAmount,
      seed: p.seed,
      rotX: parseFloat(ui.rotX.value) || 0,
      rotY: parseFloat(ui.rotY.value) || 0,
      rotZ: parseFloat(ui.rotZ.value) || 0,
    },
    fileName: state.fileName,
  };

  // Include raw geometry if loaded
  if (state.rawGeometry) {
    project.rawGeometry = Array.from(state.rawGeometry.attributes.position.array);
  }

  // Include piece state if transformed
  if (state.pieceRegistry.length > 0 && state.lastBounds) {
    project.pieceState = captureSnapshot();
  }

  const json = JSON.stringify(project);
  const blob = new Blob([json], { type: 'application/json' });
  downloadBlob(blob, `crystal_project_${Date.now()}.json`);
  setStatus('Project saved');
}

function loadProject(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const project = JSON.parse(e.target.result);

      if (!project.version || !project.params) {
        showError('Invalid project file.');
        return;
      }

      // Restore params to UI
      const pp = project.params;
      ui.crystalX.value = pp.crystalX;
      ui.crystalY.value = pp.crystalY;
      ui.crystalZ.value = pp.crystalZ;
      ui.inset.value = pp.inset;
      ui.viewDist.value = pp.viewDist;
      ui.refractIdx.value = pp.refractiveIndex;
      ui.slicesNum.value = pp.numSlices;
      ui.slicesRange.value = pp.numSlices;
      ui.sliceMode.value = pp.sliceMode;
      ui.capFacesToggle.checked = pp.capFaces;
      ui.spreadToggle.checked = pp.spreadEnabled;
      ui.jitterAmount.value = pp.jitterAmount;
      ui.seed.value = pp.seed;
      ui.rotX.value = pp.rotX;
      ui.rotY.value = pp.rotY;
      ui.rotZ.value = pp.rotZ;

      state.fileName = project.fileName;
      ui.fileName.textContent = project.fileName || 'Loaded from project';

      // Restore raw geometry
      if (project.rawGeometry) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(project.rawGeometry), 3));
        geo.computeBoundingBox();
        geo.computeVertexNormals();
        state.rawGeometry = geo;
        applyModelRotation();
      }

      updateCrystalBounds();

      // Restore piece state
      if (project.pieceState) {
        restoreSnapshot(project.pieceState);
      }

      fitCameraToScene();
      setStatus('Project loaded');
    } catch (err) {
      showError('Failed to load project: ' + err.message);
      console.error(err);
    }
  };
  reader.readAsText(file);
}

ui.btnSaveProject.addEventListener('click', saveProject);
ui.btnLoadProject.addEventListener('click', () => ui.projectFileInput.click());
ui.projectFileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) loadProject(e.target.files[0]);
  e.target.value = ''; // reset so same file can be reloaded
});
