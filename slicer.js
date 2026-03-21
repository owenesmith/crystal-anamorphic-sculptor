/**
 * Mesh Slicer — splits a BufferGeometry into N pieces using cutting planes.
 *
 * Supports three modes:
 *   - "parallel": evenly spaced planes along Z axis
 *   - "horizontal": evenly spaced planes along Y axis
 *   - "random": randomly oriented planes through the usable volume
 *
 * Each cut:
 *   1. Classifies each triangle relative to the cutting plane
 *   2. Splits straddling triangles into sub-triangles
 *   3. Caps the open cross-section with new faces
 */

import * as THREE from 'three';

const EPS = 1e-6;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Slice a BufferGeometry into numSlices pieces.
 * @param {THREE.BufferGeometry} geometry - Source geometry
 * @param {number} numSlices - Number of desired pieces (2–50)
 * @param {string} mode - "parallel" | "horizontal" | "random"
 * @param {Object} bounds - { minX, maxX, minY, maxY, minZ, maxZ }
 * @param {SeededRandom} rng - Seeded random generator
 * @param {THREE.Vector3} viewerPos - Viewer position (for random mode fan planes)
 * @returns {THREE.BufferGeometry[]} Array of piece geometries
 */
/**
 * Split a single BufferGeometry into two pieces along a plane.
 * @param {THREE.BufferGeometry} geometry - Geometry to split
 * @param {THREE.Plane} plane - Cutting plane
 * @returns {{ front: THREE.BufferGeometry|null, back: THREE.BufferGeometry|null }}
 */
export function splitGeometryByPlane(geometry, plane, capFaces = true) {
  const triangles = extractTriangles(geometry);
  if (triangles.length === 0) return { front: null, back: null };

  const { front, back } = splitTrianglesByPlane(triangles, plane, capFaces);
  return {
    front: front.length > 0 ? trianglesToGeometry(front) : null,
    back: back.length > 0 ? trianglesToGeometry(back) : null,
  };
}

export function sliceMesh(geometry, numSlices, mode, bounds, rng, viewerPos, capFaces = true) {
  // Extract triangles from the BufferGeometry into a workable format
  const triangles = extractTriangles(geometry);

  if (triangles.length === 0) return [];

  // Generate cutting planes based on mode
  const planes = generatePlanes(numSlices, mode, bounds, rng, viewerPos);

  // Iteratively cut: start with one piece (all triangles), apply each plane.
  // For parallel/horizontal modes, each plane splits ALL existing pieces (clean slabs).
  // For random mode, each plane only splits the LARGEST piece (produces exactly N pieces).
  let pieces = [triangles];

  for (const plane of planes) {
    if (mode === 'random') {
      // Find the largest piece by triangle count and split only that one
      let largestIdx = 0;
      for (let i = 1; i < pieces.length; i++) {
        if (pieces[i].length > pieces[largestIdx].length) largestIdx = i;
      }
      const target = pieces[largestIdx];
      const { front, back } = splitTrianglesByPlane(target, plane, capFaces);
      const newPieces = pieces.filter((_, i) => i !== largestIdx);
      if (front.length > 0) newPieces.push(front);
      if (back.length > 0) newPieces.push(back);
      pieces = newPieces;
    } else {
      const newPieces = [];
      for (const piece of pieces) {
        const { front, back } = splitTrianglesByPlane(piece, plane, capFaces);
        if (front.length > 0) newPieces.push(front);
        if (back.length > 0) newPieces.push(back);
      }
      pieces = newPieces;
    }
  }

  // Convert triangle arrays back to BufferGeometry
  return pieces
    .map(trianglesToGeometry)
    .filter(g => g.attributes.position.count > 0);
}

// ─── Triangle Representation ──────────────────────────────────────────────────

/**
 * Extract triangles as arrays of { a, b, c } (THREE.Vector3 triplets)
 */
function extractTriangles(geometry) {
  const pos = geometry.attributes.position;
  const idx = geometry.index;
  const tris = [];

  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      tris.push({
        a: new THREE.Vector3().fromBufferAttribute(pos, idx.getX(i)),
        b: new THREE.Vector3().fromBufferAttribute(pos, idx.getX(i + 1)),
        c: new THREE.Vector3().fromBufferAttribute(pos, idx.getX(i + 2)),
      });
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      tris.push({
        a: new THREE.Vector3().fromBufferAttribute(pos, i),
        b: new THREE.Vector3().fromBufferAttribute(pos, i + 1),
        c: new THREE.Vector3().fromBufferAttribute(pos, i + 2),
      });
    }
  }

  return tris;
}

/**
 * Convert an array of triangle objects back to a BufferGeometry.
 */
function trianglesToGeometry(triangles) {
  const verts = new Float32Array(triangles.length * 9);
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const base = i * 9;
    verts[base]     = t.a.x; verts[base + 1] = t.a.y; verts[base + 2] = t.a.z;
    verts[base + 3] = t.b.x; verts[base + 4] = t.b.y; verts[base + 5] = t.b.z;
    verts[base + 6] = t.c.x; verts[base + 7] = t.c.y; verts[base + 8] = t.c.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  return geo;
}

// ─── Plane Generation ─────────────────────────────────────────────────────────

/**
 * Generate N-1 cutting planes to produce N pieces.
 * Returns array of THREE.Plane objects.
 */
function generatePlanes(numSlices, mode, bounds, rng, viewerPos) {
  const numCuts = numSlices - 1;
  const planes = [];

  if (mode === 'parallel') {
    // Evenly spaced planes perpendicular to Z axis
    const zMin = bounds.minZ;
    const zMax = bounds.maxZ;
    const step = (zMax - zMin) / numSlices;
    for (let i = 1; i <= numCuts; i++) {
      const z = zMin + step * i;
      const normal = new THREE.Vector3(0, 0, 1);
      const plane = new THREE.Plane(normal, -z);
      planes.push(plane);
    }
  } else if (mode === 'horizontal') {
    // Evenly spaced planes perpendicular to Y axis
    const yMin = bounds.minY;
    const yMax = bounds.maxY;
    const step = (yMax - yMin) / numSlices;
    for (let i = 1; i <= numCuts; i++) {
      const y = yMin + step * i;
      const normal = new THREE.Vector3(0, 1, 0);
      const plane = new THREE.Plane(normal, -y);
      planes.push(plane);
    }
  } else if (mode === 'random') {
    // Each cutting plane passes through both a random point inside the crystal
    // AND the viewer position. This guarantees:
    //   1. The plane intersects the crystal (it passes through an interior point)
    //   2. The seam is edge-on from the viewer (the viewer lies on the plane)
    // The plane normal is perpendicular to the viewer-to-point ray.
    //
    // Spacing enforcement: anchor points must be at least minSpacing apart.
    const crystalDiag = Math.sqrt(
      (bounds.maxX - bounds.minX) ** 2 +
      (bounds.maxY - bounds.minY) ** 2 +
      (bounds.maxZ - bounds.minZ) ** 2
    );
    const minSpacing = crystalDiag / (numSlices * 2.5);
    const anchorPoints = [];
    const MAX_ATTEMPTS = 50;

    for (let i = 0; i < numCuts; i++) {
      let bestP = null;
      let bestDist = 0;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // Random point inside the crystal volume (shrunk 20% from edges)
        const P = new THREE.Vector3(
          rng.range(bounds.minX * 0.8, bounds.maxX * 0.8),
          rng.range(bounds.minY * 0.8, bounds.maxY * 0.8),
          rng.range(bounds.minZ, bounds.maxZ)
        );

        // Check minimum distance to all existing anchor points
        let closestDist = Infinity;
        for (const existing of anchorPoints) {
          const d = P.distanceTo(existing);
          if (d < closestDist) closestDist = d;
        }

        // First plane has no constraints
        if (anchorPoints.length === 0) {
          bestP = P;
          break;
        }

        // Accept if meets minimum spacing
        if (closestDist >= minSpacing) {
          bestP = P;
          break;
        }

        // Track the best attempt (furthest from existing points) as fallback
        if (closestDist > bestDist) {
          bestDist = closestDist;
          bestP = P;
        }
      }

      anchorPoints.push(bestP);

      // Direction from viewer to this point
      const dir = new THREE.Vector3().subVectors(bestP, viewerPos).normalize();

      // Random normal perpendicular to dir (Gram-Schmidt orthogonalization)
      const arbitrary = new THREE.Vector3(
        rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)
      );
      const normal = arbitrary.addScaledVector(dir, -arbitrary.dot(dir)).normalize();

      // Plane through P with this normal (also contains viewerPos since normal ⊥ dir)
      const d = -normal.dot(bestP);
      const plane = new THREE.Plane(normal, d);
      planes.push(plane);
    }
  }

  return planes;
}

// ─── Triangle-Plane Splitting ─────────────────────────────────────────────────

/**
 * Classify and split all triangles against a plane.
 * "front" = on the side the normal points to (positive half-space)
 * "back" = opposite side
 */
function splitTrianglesByPlane(triangles, plane, capFaces = true) {
  const front = [];
  const back = [];
  const crossSectionEdges = []; // for capping

  for (const tri of triangles) {
    const dA = plane.distanceToPoint(tri.a);
    const dB = plane.distanceToPoint(tri.b);
    const dC = plane.distanceToPoint(tri.c);

    const sA = Math.abs(dA) < EPS ? 0 : (dA > 0 ? 1 : -1);
    const sB = Math.abs(dB) < EPS ? 0 : (dB > 0 ? 1 : -1);
    const sC = Math.abs(dC) < EPS ? 0 : (dC > 0 ? 1 : -1);

    // All on front side
    if (sA >= 0 && sB >= 0 && sC >= 0) {
      front.push(tri);
      continue;
    }
    // All on back side
    if (sA <= 0 && sB <= 0 && sC <= 0) {
      back.push(tri);
      continue;
    }

    // Triangle straddles the plane — split it
    const verts = [tri.a, tri.b, tri.c];
    const dists = [dA, dB, dC];
    const signs = [sA, sB, sC];

    const frontVerts = [];
    const backVerts = [];

    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const vi = verts[i], vj = verts[j];
      const si = signs[i], sj = signs[j];
      const di = dists[i], dj = dists[j];

      if (si >= 0) frontVerts.push(vi.clone());
      if (si <= 0) backVerts.push(vi.clone());

      // If this edge crosses the plane, compute intersection
      if ((si > 0 && sj < 0) || (si < 0 && sj > 0)) {
        const t = di / (di - dj);
        const intersection = vi.clone().lerp(vj, t);
        frontVerts.push(intersection.clone());
        backVerts.push(intersection.clone());
        crossSectionEdges.push(intersection.clone()); // track cross-section points
      }
    }

    // Triangulate the front polygon (3 or 4 vertices)
    triangulatePoly(frontVerts, front);
    triangulatePoly(backVerts, back);
  }

  // Cap the cross-sections (create faces to close the open cuts)
  if (capFaces && crossSectionEdges.length >= 3) {
    const capTris = createCap(crossSectionEdges, plane);
    // Add cap triangles to both sides (with flipped normals for back)
    for (const t of capTris) {
      front.push(t);
      back.push({ a: t.a.clone(), c: t.b.clone(), b: t.c.clone() }); // reversed winding
    }
  }

  return { front, back };
}

/**
 * Triangulate a convex polygon (3 or 4 vertices) into triangles using fan method.
 */
function triangulatePoly(vertices, output) {
  if (vertices.length < 3) return;
  for (let i = 1; i < vertices.length - 1; i++) {
    output.push({
      a: vertices[0].clone(),
      b: vertices[i].clone(),
      c: vertices[i + 1].clone(),
    });
  }
}

// ─── Cross-Section Capping ────────────────────────────────────────────────────

/**
 * Create cap triangles from the cross-section intersection points.
 * Uses a simple centroid-fan approach for the cap polygon.
 */
function createCap(points, plane) {
  if (points.length < 3) return [];

  // Compute centroid of the cross-section points
  const centroid = new THREE.Vector3();
  for (const p of points) centroid.add(p);
  centroid.divideScalar(points.length);

  // Project points onto a 2D coordinate system on the plane for sorting
  const normal = plane.normal.clone().normalize();

  // Build a local 2D basis on the plane
  let up = new THREE.Vector3(0, 1, 0);
  if (Math.abs(normal.dot(up)) > 0.9) up = new THREE.Vector3(1, 0, 0);
  const uAxis = new THREE.Vector3().crossVectors(normal, up).normalize();
  const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();

  // Sort points by angle around centroid in the plane's local 2D space
  const sorted = points.map(p => {
    const rel = p.clone().sub(centroid);
    const u = rel.dot(uAxis);
    const v = rel.dot(vAxis);
    return { point: p, angle: Math.atan2(v, u) };
  });
  sorted.sort((a, b) => a.angle - b.angle);

  // Remove near-duplicate points
  const filtered = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].point.distanceTo(sorted[i - 1].point) > EPS) {
      filtered.push(sorted[i]);
    }
  }

  if (filtered.length < 3) return [];

  // Fan triangulation from centroid
  const tris = [];
  for (let i = 0; i < filtered.length; i++) {
    const j = (i + 1) % filtered.length;
    tris.push({
      a: centroid.clone(),
      b: filtered[i].point.clone(),
      c: filtered[j].point.clone(),
    });
  }

  return tris;
}
