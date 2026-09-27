// Local typings for gltf-validator 2.0.0-dev.3.10 (CommonJS, ships none; R3 note 26). Only what Gloam uses.
declare module "gltf-validator" {
  export interface ValidationMessage {
    code: string;
    message: string;
    severity: number;
    pointer?: string;
    offset?: number;
  }
  export interface ValidationReport {
    mimeType: string;
    validatorVersion: string;
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: ValidationMessage[];
      truncated: boolean;
    };
    info?: {
      resources?: { pointer: string; mimeType?: string; storage: string; uri?: string }[];
      extensionsUsed?: string[];
      totalTriangleCount?: number;
    };
  }
  export function validateBytes(
    data: Uint8Array,
    options?: { format?: "glb" | "gltf"; maxIssues?: number; writeTimestamp?: boolean; uri?: string },
  ): Promise<ValidationReport>;
  export const version: string;
}
