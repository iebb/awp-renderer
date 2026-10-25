'use client';

import type { CSSProperties } from 'react';
import type { NativePassRender } from '../core/types.js';

/** The same pixel presentation is used by standalone and editable previews. */
export function PassRenderImage({
  result,
  alt = 'Apple Wallet pass preview',
  className,
  style,
}: {
  result: NativePassRender;
  alt?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    // A native PNG must not pass through an image optimizer or canvas conversion.
    <img
      src={`data:image/png;base64,${result.png}`}
      width={result.width}
      height={result.height}
      alt={alt}
      className={className}
      style={style}
      draggable={false}
    />
  );
}
