// Local typings for n8ao 2.0.1 (ships none). Only what Gloam's post chain uses (postChain.ts).
declare module "n8ao" {
  import type { Pass } from "postprocessing";
  import type { Camera, Scene } from "three";
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    /** Settings read on every render (a Proxy: assigning a key applies it). */
    configuration: Record<string, unknown>;
    setQualityMode(mode: "Performance" | "Low" | "Medium" | "High" | "Ultra"): void;
  }
}
