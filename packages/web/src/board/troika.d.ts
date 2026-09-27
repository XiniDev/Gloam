// Local typings for troika-three-text 0.52.5 (ships none). Only the configuration call Gloam makes.
declare module "troika-three-text" {
  export function configureTextBuilder(config: {
    useWorker?: boolean;
    defaultFontURL?: string;
    unicodeFontsURL?: string;
    sdfGlyphSize?: number;
    sdfExponent?: number;
    sdfMargin?: number;
    textureWidth?: number;
  }): void;
}
