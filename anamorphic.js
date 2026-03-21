/**
 * Anamorphic Transform — the core mathematical illusion.
 *
 * The illusion works by displacing each piece of the model to a new depth within
 * the crystal, then scaling and repositioning it so that from the designated
 * viewing position, the piece subtends the same angular size and direction as
 * the original.
 *
 * Scaling equation (with refractive index correction):
 *   scale_factor = (D + Z_new/n) / (D + Z_orig/n)
 *
 * Where:
 *   D       = viewer distance from the front face (mm)
 *   Z_orig  = original depth of the piece centroid from the front face (Z=0)
 *   Z_new   = new depth the piece is assigned to
 *   n       = refractive index of the crystal material (1.0 = air, ~1.5 = glass)
 *
 * X/Y repositioning:
 *   The piece centroid is moved along the projection ray from the viewer's eye
 *   through the original centroid, to the new depth Z_new.
 *
 *   ray_dir = normalize(original_centroid - viewer_pos)
 *   t = (Z_new - viewer_pos.z) / ray_dir.z
 *   new_centroid = viewer_pos + ray_dir * t
 *
 * Each piece is then:
 *   1. Translated so its centroid moves to new_centroid
 *   2. Uniformly scaled by scale_factor around new_centroid
 */

import * as THREE from 'three';

const EPS = 1e-6;

/**
 * Compute the centroid of a BufferGeometry.
 */
export function computeCentroid(geometry) {
  const pos = geometry.attributes.position;
  const centroid = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    centroid.x += pos.getX(i);
    centroid.y += pos.getY(i);
    centroid.z += pos.getZ(i);
  }
  centroid.divideScalar(pos.count);
  return centroid;
}

/**
 * Apply the anamorphic transform to a single piece at a given Z-slot.
 * @param {THREE.BufferGeometry} geo - Original (pre-transform) geometry
 * @param {THREE.Vector3} centroid - Centroid of the original geometry
 * @param {number} zNew - Target Z depth
 * @param {THREE.Vector3} viewerPos - Viewer eye position
 * @param {Object} bounds - Usable volume bounds
 * @returns {{ geometry: THREE.BufferGeometry, wasClamped: boolean }}
 */
export function transformSinglePiece(geo, centroid, zNew, viewerPos, bounds, refractiveIndex = 1.0) {
  const n = refractiveIndex;
  const zOrig = centroid.z;

  // Use apparent z-depths (z/n) for scaling and projection to correct for refraction
  // at the crystal's front face. Apparent depth = physical depth / n (Snell's law, paraxial).
  const dPlusZorig = zOrig / n - viewerPos.z;   // D + zOrig/n
  const dPlusZnew = zNew / n - viewerPos.z;     // D + zNew/n
  const scaleFactor = dPlusZorig > EPS ? dPlusZnew / dPlusZorig : 1.0;

  // Ray from viewer through the apparent centroid position (z compressed by 1/n)
  const apparentCentroid = new THREE.Vector3(centroid.x, centroid.y, centroid.z / n);
  const rayDir = new THREE.Vector3().subVectors(apparentCentroid, viewerPos).normalize();

  let newCentroid;
  if (Math.abs(rayDir.z) > EPS) {
    const t = (zNew / n - viewerPos.z) / rayDir.z;
    const projected = viewerPos.clone().addScaledVector(rayDir, t);
    // X/Y from apparent-space projection, Z is physical placement depth
    newCentroid = new THREE.Vector3(projected.x, projected.y, zNew);
  } else {
    newCentroid = centroid.clone();
    newCentroid.z = zNew;
  }

  const transformedGeo = geo.clone();

  const offset = new THREE.Vector3().subVectors(newCentroid, centroid);
  transformedGeo.translate(offset.x, offset.y, offset.z);

  transformedGeo.translate(-newCentroid.x, -newCentroid.y, -newCentroid.z);
  transformedGeo.scale(scaleFactor, scaleFactor, scaleFactor);
  transformedGeo.translate(newCentroid.x, newCentroid.y, newCentroid.z);

  transformedGeo.computeBoundingBox();
  const bb = transformedGeo.boundingBox;
  let wasClamped = false;

  if (bb.min.x < bounds.minX || bb.max.x > bounds.maxX ||
      bb.min.y < bounds.minY || bb.max.y > bounds.maxY ||
      bb.min.z < bounds.minZ || bb.max.z > bounds.maxZ) {
    const clampOffset = new THREE.Vector3();
    if (bb.min.x < bounds.minX) clampOffset.x = bounds.minX - bb.min.x;
    else if (bb.max.x > bounds.maxX) clampOffset.x = bounds.maxX - bb.max.x;
    if (bb.min.y < bounds.minY) clampOffset.y = bounds.minY - bb.min.y;
    else if (bb.max.y > bounds.maxY) clampOffset.y = bounds.maxY - bb.max.y;
    if (bb.min.z < bounds.minZ) clampOffset.z = bounds.minZ - bb.min.z;
    else if (bb.max.z > bounds.maxZ) clampOffset.z = bounds.maxZ - bb.max.z;
    transformedGeo.translate(clampOffset.x, clampOffset.y, clampOffset.z);
    wasClamped = true;
  }

  transformedGeo.computeVertexNormals();
  return { geometry: transformedGeo, wasClamped };
}

/**
 * Apply the anamorphic transform to an array of geometry pieces.
 *
 * @param {THREE.BufferGeometry[]} pieces - Sliced geometry pieces
 * @param {THREE.Vector3} viewerPos - Viewer eye position (typically (0, 0, -D))
 * @param {number} viewerDist - D, distance from front face to viewer
 * @param {Object} bounds - Usable volume { minX, maxX, minY, maxY, minZ, maxZ }
 * @param {boolean} spreadEnabled - Whether to add random depth jitter
 * @param {number} jitterAmount - Max depth jitter in mm
 * @param {SeededRandom} rng - Seeded random generator
 * @param {string} sliceMode - "parallel" | "horizontal" | "random"
 * @returns {{ pieces: THREE.BufferGeometry[], clampedCount: number, pieceData: Object[] }}
 */
export function applyAnamorphicTransform(
  pieces, viewerPos, viewerDist, bounds, spreadEnabled, jitterAmount, rng, sliceMode, refractiveIndex = 1.0
) {
  const numPieces = pieces.length;
  let clampedCount = 0;

  // Assign each piece a new Z depth, evenly distributed across the usable Z range.
  const zSlots = [];
  for (let i = 0; i < numPieces; i++) {
    const t = numPieces === 1 ? 0.5 : i / (numPieces - 1);
    zSlots.push(bounds.minZ + t * (bounds.maxZ - bounds.minZ));
  }

  // Sort pieces by centroid, then interleave so neighbors get distant Z-slots.
  const piecesWithCentroids = pieces.map((geo, idx) => ({
    geo,
    centroid: computeCentroid(geo),
    index: idx,
  }));
  if (sliceMode === 'horizontal') {
    piecesWithCentroids.sort((a, b) => a.centroid.y - b.centroid.y);
  } else {
    piecesWithCentroids.sort((a, b) => a.centroid.z - b.centroid.z);
  }

  // Interleave: split sorted list into two halves and alternate between them.
  const interleaved = new Array(numPieces);
  const half = Math.ceil(numPieces / 2);
  for (let i = 0; i < numPieces; i++) {
    const slotIdx = i < half
      ? i * 2
      : (i - half) * 2 + 1;
    interleaved[slotIdx] = piecesWithCentroids[i];
  }

  const resultPieces = [];
  const pieceData = [];

  for (let i = 0; i < interleaved.length; i++) {
    const { geo, centroid } = interleaved[i];
    let zNew = zSlots[i];

    // Apply depth jitter (Z-only)
    if (spreadEnabled && jitterAmount > 0) {
      zNew += rng.range(-jitterAmount, jitterAmount);
    }

    const result = transformSinglePiece(geo, centroid, zNew, viewerPos, bounds, refractiveIndex);
    if (result.wasClamped) clampedCount++;

    resultPieces.push(result.geometry);
    pieceData.push({
      originalGeo: geo,
      centroid: centroid.clone(),
      zSlot: zNew,
    });
  }

  return { pieces: resultPieces, clampedCount, pieceData };
}
