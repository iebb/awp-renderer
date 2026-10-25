# Component and JavaScript API

## Exports

- `awp-renderer`: `renderPass`, `renderPassArchive`, `passRendererAvailable`, `buildPassRenderArchive`, `passRenderInputFromArchive`, `serializePassJson`, `passAssetsKey`, `isPassAssetName`, `PASS_RENDER_LIMITS`, input/options/result types, and `PassRendererError`.
- `awp-renderer/react`: `PassRenderer`, `PassRenderImage`, `usePassRenderer`, props/state/input/result types. Preserves the `use client` boundary for React Server Component consumers.
- `awp-renderer/server`: `renderNativePass`, `createRendererServer`, `rendererDiagnostics`, `nativeRendererAvailable`, `NativeRenderError`, `MAX_NATIVE_PASS_BYTES`.

ES modules and TypeScript declarations ship in the release. CommonJS and a standalone browser script global are not supplied. Browser/React imports do not load Node modules or native source.

## PassRenderer props

| Prop                 | Default                   | Behavior                                                                        |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `pass`               | Required                  | JSON object or original JSON source string.                                     |
| `assets`             | `{}`                      | Resource name → URL/data URL, Blob/File, Uint8Array, or ArrayBuffer.            |
| `endpoint`           | `/render`                 | HTTP rendering URL; use an application proxy for remote Macs.                   |
| `face`               | `front`                   | `front`, `semantic`, or `watch`. JSON controls the actual style.                |
| `width`              | Native point width        | CSS display width, not raster size.                                             |
| `requireExact`       | `true`                    | Reject source other than `pass-designer`.                                       |
| `scale`              | `4`                       | Raster scale 1–4; exact requires 4.                                             |
| `locale`             | System                    | Override requires explicit approximate opt-in.                                  |
| `headers`            | None                      | Extra HTTP headers; never ship a private service token in public frontend code. |
| `debounceMs`         | `180`                     | Delay after input changes.                                                      |
| `enabled`            | `true`                    | Pause all rendering.                                                            |
| `keepPreviousResult` | `false`                   | Keep old output while new input loads if explicitly requested.                  |
| `onRender`           | None                      | Receives `{status, result, error}` on state transitions.                        |
| `loading`            | Accessible status         | Custom loading ReactNode.                                                       |
| `renderError`        | Accessible error          | `(message) => ReactNode`.                                                       |
| `alt`                | Apple Wallet pass preview | Image alternative text.                                                         |
| `className`, `style` | None                      | Container appearance; no required stylesheet.                                   |

Status is `loading`, `ready`, `unavailable`, or `error`. `result` is null until ready. Errors never contain native framework stderr or uploaded JSON. The hook has the same options except presentation props and `onRender`. The promise APIs accept an `AbortSignal`.

## Resource rules

Use standard names such as `icon.png`, `logo@2x.png`, `thumbnail@3x.png`, `primaryLogo.png`, and `zh-CN.lproj/pass.strings`. Localized PNGs are supported. PNG files must contain a PNG signature and bounded dimensions; JPEG conversion is intentionally outside the renderer.

```ts
const assets = {
  'logo@2x.png': fileOrBytes,
  'zh-CN.lproj/pass.strings': new Blob(['"MEMBER" = "會員";']),
};
```

Binary inputs are immutable: replace a byte array, ArrayBuffer, or Blob object after changing its contents. A changed URL's contents need a versioned URL. Assets are downloaded before upload with a four-request concurrency bound, operation timeout, and cancellation. A filename allowlist excludes traversal, signatures, arbitrary metadata, and executable resources.

`passRenderInputFromArchive()` reads JSON and supported resources from an archive without editor defaults. It validates the ZIP central directory before bounded inflation. `buildPassRenderArchive()` creates an unsigned resource ZIP, sorted with stable timestamps and without synthetic directory entries. This preserves semantic input and makes identical inputs cacheable. It does not create Wallet signatures or manifests.

## Limits

| Input                           | Limit                                                                   |
| ------------------------------- | ----------------------------------------------------------------------- |
| JSON                            | 256 KiB                                                                 |
| Compressed/uploaded archive     | 16 MiB                                                                  |
| PNG                             | 8 MiB each                                                              |
| PNG dimensions                  | 8192 per side; 32 million pixels                                        |
| Localization strings            | 64 KiB each                                                             |
| Resources                       | 299 plus pass.json                                                      |
| Central-directory inflated size | 32 MiB total; service resource extraction additionally capped at 16 MiB |
| Native execution                | Two active jobs, twelve queued jobs                                     |
| Client operation                | 90 seconds                                                              |

Accepted input still needs to be meaningful to Apple's renderer. Unsupported/inconsistent pass combinations may produce a native error. The project does not add business validation or override Apple's fitting choices.

## Result

```ts
{
  renderer: 'apple-passkit',
  source: 'pass-designer', // exact path; 'passkit' for approximate path
  width: 343,             // point width
  height: 503,            // point height; depends on the pass
  scale: 4,
  png: 'iVBORw0KGgo...',    // base64 PNG, no data URL prefix
  layout: [               // native view tree; not a stable Apple schema
    { class: '...', x: 0, y: 0, width: 343, height: 503, fieldKey: 'name' },
  ],
}
```

Layout is collected by a separate native geometry worker. Available keys/text/classes vary by Apple's implementation. Its rectangles are useful for inspection and hit targets; they are not a public Apple API contract or a second rendering algorithm.
