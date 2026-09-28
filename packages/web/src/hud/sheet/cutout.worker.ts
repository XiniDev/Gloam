/// <reference lib="webworker" />
/**
 * The paper cutout in a worker (SPEC §8.10 Character art: "run in a Web Worker"): the photo arrives as an ImageBitmap
 * (EXIF orientation already applied by `createImageBitmap(file, { imageOrientation: "from-image" })`), is fitted
 * within the size asked (2048 px for the sticker, less for the live preview), cut out, and sent back as pixels.
 */
import { type CutoutOptions, cutout, fitWithin } from "./cutout.ts";

interface Job {
  id: number;
  bitmap: ImageBitmap;
  max: number;
  options: CutoutOptions;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, bitmap, max, options } = e.data;
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, max);
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    g.drawImage(bitmap, 0, 0, width, height);
    const img = g.getImageData(0, 0, width, height);
    const out = cutout({ data: img.data, width, height }, options);
    (self as unknown as Worker).postMessage({ id, width: out.width, height: out.height, data: out.data }, [
      out.data.buffer,
    ]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
