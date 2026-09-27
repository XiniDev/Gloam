// Local typings for draco3dgltf 1.5.7 (CommonJS, local WASM; R3 note 28). The decoder module is handed to
// gltf-transform as an opaque dependency, so only the factory signatures matter here.
declare module "draco3dgltf" {
  const draco3d: {
    createDecoderModule(): Promise<unknown>;
    createEncoderModule(): Promise<unknown>;
  };
  export default draco3d;
}
