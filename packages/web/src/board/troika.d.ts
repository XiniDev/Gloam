// Local typings for troika-three-text 0.52.5 (ships none). Only the calls Gloam makes.
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
  /** Loads a font (and lays out `characters`), calling back when it's ready. */
  export function preloadFont(
    options: { font?: string; characters?: string | string[]; sdfGlyphSize?: number },
    callback: () => void,
  ): void;
}
