# Native setup

## Known working environment

- macOS 27.0, build 26A428, Apple Silicon.
- Xcode 27 SDK/toolchain selected with `xcode-select`.
- Pass Designer installed at `/Applications/Pass Designer.app`, build 28.
- Node 22.15+; the fresh native report was captured with Node 26.3.1.
- A logged-in desktop session. The bridge creates offscreen AppKit/Catalyst hosts; a headless stock Linux/macOS CI runner is not a substitute for this setup.

Supply your own Apple software installation. Open Pass Designer once so its signed extension is registered and its app-group directory exists. This project does not download, redistribute, modify, or re-sign that app.

```sh
npx awp-renderer doctor
npx awp-renderer serve --open
```

The doctor checks OS, SDK, compiler, SDK framework, extension, and existing app-group directory. A successful doctor is a prerequisite check; `render` or `npm run test:native` verifies actual extension execution.

## Configuration

| Variable                | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `AWP_PASS_DESIGNER_APP` | Custom path to the installed Pass Designer app.                        |
| `AWP_RENDER_TOKEN`      | Bearer token. Required if the CLI listens beyond loopback.             |
| `AWP_RENDER_URL`        | Full `/render` URL used by the CLI `render` command.                   |
| `AWP_TEST_ENDPOINT`     | Optional HTTP endpoint for the native parity suite.                    |
| `AWP_TEST_OUTPUT`       | Native report/output directory; defaults to `artifacts/native-parity`. |

Run `awp-renderer --help` for listen address, port, allowed browser origin, export scale, face, and language options. Remote clients should connect through a TLS application proxy. The bundled UI and API share an origin by default, so no CORS configuration is needed locally.

## Troubleshooting

- **Missing app group:** launch Pass Designer once under the same macOS account used by the service.
- **Missing SDK or Catalyst frameworks:** install/select full Xcode with a macOS 27 SDK; Command Line Tools alone may not supply the required frameworks.
- **Official source unavailable:** check the SDK framework and extension paths, registered extension, app group, and tested app build. Do not silently replace the exact path with another renderer.
- **401:** configure the same bearer token on the caller. The playground's Connection settings accept a token for a local/private test.
- **403:** use the loopback URL printed by the CLI. For another browser origin, supply one exact `--cors-origin http://localhost:5173` value.
- **429:** the native engine runs two jobs at a time with twelve queued slots. Wait and retry deliberately.
- **Changed Apple version:** run the native comparison suite before relying on exact parity. Interfaces used by the bridge are non-public and can change.

The first request compiles project-owned bridge source using Xcode into a temporary app bundle. Following requests reuse that build. Uploaded resources are copied only into disposable, bounded job directories. Workers never make the offscreen window the key window. Render/data failures are not retried; only a single pre-input scene startup SIGABRT is eligible for one bounded retry.
