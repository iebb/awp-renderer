# Contributing

Use `master` for the default branch. Changes should keep each rendering boundary small and independently usable.

```sh
npm ci
npm run build
npm run check
python3 -m pip install Pillow
npm run test:png
```

On a configured Mac, also run `npm run test:native`. The suite must compare raw RGBA and color metadata; visually similar images are not sufficient. Include the tested macOS and Pass Designer build in any parity report. Never claim universal compatibility from one tested version.

`npm run dev` starts the Vite playground on port 5173 and proxies the API to `awp-renderer serve` on port 43877. Keep native setup and image data out of React. Keep React and Node built-ins out of the core export.

Do not commit private pass data, credentials, Apple binaries, Apple fonts, Apple template assets, compiled native workers, or local artifacts. Use the fictional examples for screenshots and bug reproductions.

Submit focused pull requests with behavior, validation, and version-specific limitations. For a release, update package.json and CHANGELOG, run the checks, create a tag, and attach the `npm pack` tarball to a GitHub Release. Registry publishing is a separate maintainer action.
