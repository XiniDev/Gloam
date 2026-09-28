import type { InstancedInterleavedBuffer, InterleavedBufferAttribute } from "three";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

/**
 * Puts segments (6 floats each: ax, ay, az, bx, by, bz) and optional per-segment colours (6 floats: rgb at each end)
 * into a fat-line object. The same number of segments as before updates the GPU buffers in place — an edit dragging
 * a thousand walls re-uploads them each frame without allocating. A different number gets a fresh geometry: three.js
 * caches an instanced geometry's instance count the first time it's drawn, so a grown one would keep drawing only
 * its old count (the second batch of generated walls never showed).
 */
export function setSegments(line: LineSegments2, positions: Float32Array, colors?: Float32Array): void {
  const g = line.geometry as LineSegmentsGeometry;
  const start = g.getAttribute("instanceStart") as InterleavedBufferAttribute | undefined;
  const buf = start?.data as InstancedInterleavedBuffer | undefined;
  const colorStart = g.getAttribute("instanceColorStart") as InterleavedBufferAttribute | undefined;
  const cbuf = colorStart?.data as InstancedInterleavedBuffer | undefined;
  const sameSize =
    !!buf &&
    buf.array.length === positions.length &&
    (!colors || (!!cbuf && cbuf.array.length === colors.length));
  if (sameSize && buf) {
    (buf.array as Float32Array).set(positions);
    buf.needsUpdate = true;
    if (colors && cbuf) {
      (cbuf.array as Float32Array).set(colors);
      cbuf.needsUpdate = true;
    }
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return;
  }
  const next = new LineSegmentsGeometry();
  next.setPositions(positions);
  if (colors) next.setColors(colors);
  line.geometry = next;
  g.dispose();
}
