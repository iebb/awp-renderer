export type NativePassNode = {
  class: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldKey?: string;
  text?: string;
  hidden?: boolean;
  alpha?: number;
};

export type NativePassRender = {
  renderer: 'apple-passkit';
  source?: 'pass-designer' | 'passkit';
  width: number;
  height: number;
  scale: number;
  png: string;
  layout: NativePassNode[];
};

export type NativeRenderFace = 'front' | 'semantic' | 'watch';
