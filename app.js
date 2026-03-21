/**
 * Crystal Anamorphic Sculptor — Main Application
 *
 * Orchestrates the UI, 3D viewport, slicing, anamorphic transform, and export.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
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
  const { front, back } = splitGeometryByPlane(reg.originalGeo, plane);

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

    const pieces = sliceMesh(
      state.originalGeometry,
      p.numSlices,
      p.sliceMode,
      usableBounds,
      rng,
      viewerPos
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

// ─── Export STL ───────────────────────────────────────────────────────────────
function exportSTL() {
  if (!state.transformedGroup || state.transformedGroup.children.length === 0) {
    showError('No transformed model to export. Run Preview Transform first.');
    return;
  }

  setStatus('Exporting STL...');

  try {
    const exporter = new STLExporter();
    const result = exporter.parse(state.transformedGroup, { binary: true });

    const blob = new Blob([result], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'crystal_sculpture.stl';
    link.click();
    URL.revokeObjectURL(url);

    setStatus('Exported crystal_sculpture.stl');
  } catch (err) {
    showError('Export failed: ' + err.message);
  }
}

ui.btnExport.addEventListener('click', exportSTL);
