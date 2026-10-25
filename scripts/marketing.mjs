// Reproducible marketing artwork, made from real native previews + vector shapes.
// Run the native parity suite first. Fonts are read locally, never distributed.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
const directory = 'docs/assets';
await mkdir(directory, { recursive: true });
const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const text = (x, y, size, value, extra = '') =>
  `<text x="${x}" y="${y}" ${extra.includes('font-family=') ? '' : 'font-family="Arial, Helvetica, sans-serif"'} font-size="${size}" ${extra.includes('fill=') ? '' : 'fill="#292c36"'} ${extra}>${escape(value)}</text>`;
const mono = (x, y, size, value, fill = '#858390') =>
  `<text x="${x}" y="${y}" font-family="Menlo, Consolas, monospace" font-size="${size}" fill="${fill}">${escape(value)}</text>`;
const image = async (name, x, y, width, angle = 0) => {
  const png = await readFile(`artifacts/native-parity/${name}.png`);
  const height = (png.readUInt32BE(20) / png.readUInt32BE(16)) * width;
  return `<g transform="translate(${x} ${y}) rotate(${angle} ${width / 2} ${height / 2})"><rect x="-1" y="-1" width="${width + 2}" height="${height + 2}" rx="13" fill="#20283d" opacity=".12" filter="url(#shadow)"/><image href="data:image/png;base64,${png.toString('base64')}" width="${width}" height="${height}"/></g>`;
};
const defs = `<defs><filter id="shadow" x="-60%" y="-35%" width="230%" height="200%"><feGaussianBlur stdDeviation="20"/></filter><pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#c6c8da"/></pattern></defs>`;
const logo = `<rect x="70" y="58" width="44" height="48" rx="11" fill="#3153e9"/><text x="79" y="93" font-family="Arial" font-size="34" fill="#ffffff" font-weight="700">a</text><path d="M99 70h8v8m-8 0 8-8" fill="none" stroke="#ffffff" stroke-width="2.5"/>${text(130, 92, 27, 'awp renderer', 'font-weight="600" letter-spacing="-1"')}`;
const svg = (content) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img"><title>AWP Renderer — JSON to Apple Wallet pixels</title>${defs}${content}</svg>`;
const hero = svg(
  `<rect width="1600" height="900" fill="#f4f3ef"/><rect x="780" width="820" height="900" fill="#e7e8f1"/><rect x="780" width="820" height="900" fill="url(#dots)"/>${logo}${mono(72, 192, 12, 'APPLE WALLET / NATIVE RENDERING')}${text(70, 300, 77, 'Your JSON.', 'font-weight="550" letter-spacing="-4"')}${text(70, 386, 77, 'Wallet’s pixels.', 'font-family="Georgia, serif" font-style="italic" fill="#3657e8" letter-spacing="-4"')}${text(74, 456, 22, 'Real previews from Apple’s own renderer.', 'fill="#858390"')}${text(74, 493, 22, 'A React component, API, and CLI.', 'fill="#858390"')}<rect x="72" y="552" width="610" height="92" rx="12" fill="#22242f"/>${mono(98, 590, 15, 'import { PassRenderer } from "awp-renderer/react";', '#b4c2ff')}${mono(98, 622, 18, '<PassRenderer pass={json} />', '#f5f5ff')}<path d="M75 715h560" stroke="#d2d2df"/>${mono(75, 758, 12, 'MIT LICENSE    /    TYPESCRIPT    /    LOCAL-FIRST')}${mono(75, 839, 13, 'github.com/iebb/awp-renderer')}${await image('boarding-front-baseline', 790, 190, 285, -9)}${await image('event-front-baseline', 1230, 265, 285, 9)}${await image('membership-front-baseline', 1002, 130, 330, 0)}${mono(842, 842, 11, 'ACTUAL NATIVE OUTPUT · SYNTHETIC EXAMPLE PASSES')}`,
);
const faces = svg(
  `<rect width="1600" height="900" fill="#20232e"/><rect x="690" width="910" height="900" fill="#e9eaf3"/><rect x="690" width="910" height="900" fill="url(#dots)"/>${mono(70, 92, 14, 'AWP RENDERER / ONE INPUT, MULTIPLE FACES', '#aeb4ce')}<text x="70" y="227" font-family="Arial" font-size="67" fill="#f5f3ec" letter-spacing="-3">Same JSON.</text><text x="70" y="305" font-family="Georgia" font-style="italic" font-size="67" fill="#acbcff" letter-spacing="-3">Every face.</text>${mono(74, 371, 16, 'iPhone + Watch. Apple handles the layout.', '#aeb8dc')}<rect x="72" y="425" width="546" height="280" rx="13" fill="#191c26" stroke="#3c435a"/>${mono(98, 466, 13, 'pass.json', '#8e9fcc')}${mono(98, 510, 17, '{', '#d5ddf6')}${mono(120, 544, 17, '"logoText": "ATELIER / MEMBERS",', '#d5ddf6')}${mono(120, 578, 17, '"generic": {', '#d5ddf6')}${mono(142, 612, 17, '"primaryFields": [ … ]', '#a1b8ff')}${mono(120, 646, 17, '}', '#d5ddf6')}${mono(98, 680, 17, '}', '#d5ddf6')}${mono(74, 791, 12, '4× NATIVE PNG  /  LAYOUT METADATA  /  MIT', '#aeb4ce')}${mono(74, 840, 13, 'github.com/iebb/awp-renderer', '#aeb4ce')}${await image('membership-front-baseline', 760, 140, 336, 0)}${await image('membership-watch-baseline', 1175, 265, 335, 0)}${mono(762, 710, 12, 'PHONE / FRONT')}${mono(1178, 710, 12, 'WATCH')}${text(762, 799, 17, 'Rendering, fitting, wrapping, and barcodes — by Apple.', 'fill="#7f839b"')}${mono(762, 839, 10, 'EXACT PATH: INSTALLED PASS DESIGNER · 4× · SYSTEM LANGUAGE')}`,
);
for (const [name, source] of [
  ['hero', hero],
  ['phone-and-watch', faces],
]) {
  await writeFile(`${directory}/${name}.svg`, source);
  await writeFile(
    `${directory}/${name}.png`,
    new Resvg(source, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } })
      .render()
      .asPng(),
  );
}
await writeFile(
  `${directory}/mark.svg`,
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="30" fill="#3153e9"/><text x="22" y="98" font-family="Arial,sans-serif" font-weight="700" font-size="92" fill="#ffffff">a</text><path d="M81 25h23v23M80 49l24-24" stroke="#ffffff" stroke-width="7" fill="none"/></svg>',
);
console.log('Created editable SVGs and 1600×900 PNG marketing images from real previews.');
