'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativePassRender } from '../core/types.js';
import {
  buildPassRenderArchive,
  passAssetsKey,
  serializePassJson,
  type PassRenderInput,
} from '../core/input.js';
import {
  passRendererAvailable,
  PassRendererError,
  renderPassArchive,
  type PassRenderOptions,
} from '../core/client.js';

export type PassRenderStatus = 'loading' | 'ready' | 'unavailable' | 'error';
export type PassRenderState = {
  status: PassRenderStatus;
  result: NativePassRender | null;
  error: string;
};
export type PassRendererOptions = Omit<PassRenderOptions, 'signal'> & {
  enabled?: boolean;
  debounceMs?: number;
  keepPreviousResult?: boolean;
};

/** Internal seam for the editor. No dependency on editor state or providers. */
export function usePassArchiveRender(
  prepareArchive: (signal: AbortSignal) => Promise<Blob>,
  options: PassRendererOptions = {},
): PassRenderState {
  const {
    endpoint = '/render',
    face = 'front',
    scale = 4,
    locale = '',
    requireExact = true,
    enabled = true,
    debounceMs = 180,
    keepPreviousResult = false,
  } = options;
  const headerKey = JSON.stringify(Object.entries(options.headers || {}).sort());
  const headers = useMemo(
    () => Object.fromEntries(JSON.parse(headerKey)) as Record<string, string>,
    [headerKey],
  );
  const request = useMemo(
    () => ({}),
    [
      prepareArchive,
      endpoint,
      face,
      scale,
      locale,
      requireExact,
      enabled,
      debounceMs,
      keepPreviousResult,
      headers,
    ],
  );
  const [state, setState] = useState<PassRenderState & { request: object }>({
    status: 'loading',
    result: null,
    error: '',
    request,
  });
  useEffect(() => {
    if (!enabled) {
      setState({ status: 'unavailable', result: null, error: '', request });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({
      status: 'loading',
      result: keepPreviousResult ? previous.result : null,
      error: '',
      request,
    }));
    const timer = setTimeout(
      async () => {
        const operation = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
        try {
          if (!(await passRendererAvailable(endpoint, headers)))
            throw new PassRendererError(
              'The macOS pass renderer is unavailable. Run awp-renderer doctor to check setup.',
              503,
            );
          operation.throwIfAborted();
          const archive = await prepareArchive(operation);
          operation.throwIfAborted();
          const result = await renderPassArchive(archive, {
            endpoint,
            face,
            scale,
            locale,
            requireExact,
            headers,
            signal: operation,
          });
          if (!controller.signal.aborted) setState({ status: 'ready', result, error: '', request });
        } catch (error) {
          if (controller.signal.aborted) return;
          setState({
            status:
              error instanceof PassRendererError && error.status === 503 ? 'unavailable' : 'error',
            result: null,
            error: error instanceof Error ? error.message : 'Could not render this pass.',
            request,
          });
        } finally {
          controller.abort();
        }
      },
      Math.max(0, debounceMs),
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    request,
    prepareArchive,
    endpoint,
    face,
    scale,
    locale,
    requireExact,
    enabled,
    debounceMs,
    keepPreviousResult,
    headers,
  ]);
  if (state.request !== request)
    return {
      status: enabled ? 'loading' : 'unavailable',
      result: keepPreviousResult ? state.result : null,
      error: '',
    };
  return { status: state.status, result: state.result, error: state.error };
}

export function usePassRenderer(
  input: PassRenderInput,
  options: PassRendererOptions = {},
): PassRenderState {
  let json = '',
    assetKey = '',
    invalid = '';
  try {
    json = serializePassJson(input.pass);
    assetKey = passAssetsKey(input.assets);
  } catch (error) {
    invalid = error instanceof Error ? error.message : 'Invalid pass input.';
  }
  const currentAssets = useRef(input.assets);
  currentAssets.current = input.assets;
  const prepareArchive = useCallback(
    async (signal: AbortSignal) => {
      if (invalid) throw new Error(invalid);
      return buildPassRenderArchive({ pass: json, assets: currentAssets.current }, signal);
      // assetKey compares file names, URL strings and immutable binary identities.
    },
    [json, assetKey, invalid],
  );
  const rendered = usePassArchiveRender(prepareArchive, {
    ...options,
    enabled: !invalid && options.enabled !== false,
  });
  const invalidState = useMemo<PassRenderState>(
    () => ({ status: 'error', result: null, error: invalid }),
    [invalid],
  );
  return invalid ? invalidState : rendered;
}
