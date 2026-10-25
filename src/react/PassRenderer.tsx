'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { PassAssets, PassJson } from '../core/input.js';
import { PassRenderImage } from './PassRenderImage.js';
import {
  usePassRenderer,
  type PassRendererOptions,
  type PassRenderState,
} from './usePassRenderer.js';

export type PassRendererProps = PassRendererOptions & {
  pass: PassJson;
  assets?: PassAssets;
  alt?: string;
  width?: CSSProperties['width'];
  className?: string;
  style?: CSSProperties;
  loading?: ReactNode;
  renderError?: (message: string) => ReactNode;
  onRender?: (state: PassRenderState) => void;
};

/** Standalone JSON → Apple-rendered pixels. No store, i18n, or editor provider. */
export function PassRenderer({
  pass,
  assets,
  alt,
  width,
  className,
  style,
  loading,
  renderError,
  onRender,
  ...options
}: PassRendererProps) {
  const state = usePassRenderer({ pass, assets }, options);
  const { status, result, error } = state;
  const callback = useRef(onRender);
  callback.current = onRender;
  useEffect(() => {
    callback.current?.({ status, result, error });
  }, [status, result, error]);
  return (
    <div
      className={className}
      data-pass-renderer
      data-render-status={state.status}
      data-render-source={state.result?.source}
      aria-busy={state.status === 'loading'}
      style={{
        display: 'inline-block',
        verticalAlign: 'top',
        maxWidth: '100%',
        width: width ?? state.result?.width ?? 343,
        ...style,
      }}
    >
      {state.result ? (
        <PassRenderImage
          result={state.result}
          alt={alt}
          style={{ display: 'block', width: '100%', height: 'auto' }}
        />
      ) : state.error ? (
        <div role="alert">{renderError ? renderError(state.error) : state.error}</div>
      ) : (
        <div role="status">
          {options.enabled === false ? 'Pass preview is disabled.' : (loading ?? 'Rendering pass…')}
        </div>
      )}
    </div>
  );
}
