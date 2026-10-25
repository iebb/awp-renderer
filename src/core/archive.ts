/** Validate ZIP central-directory sizes before JSZip inflates any browser input. */
export function validatePassArchive(bytes: Uint8Array) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('The pass exceeds the 16 MiB limit.');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  for (; end >= earliest; end--) {
    if (
      data.getUint32(end, true) === 0x06054b50 &&
      end + 22 + data.getUint16(end + 20, true) === bytes.length
    )
      break;
  }
  if (end < earliest) throw new Error('Invalid .pkpass ZIP archive.');
  const entries = data.getUint16(end + 10, true);
  let cursor = data.getUint32(end + 16, true),
    total = 0;
  if (
    data.getUint16(end + 4, true) ||
    data.getUint16(end + 6, true) ||
    entries === 65535 ||
    entries > 300
  )
    throw new Error('Unsupported pass archive or too many resources.');
  const names = new Set<string>();
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || data.getUint32(cursor, true) !== 0x02014b50)
      throw new Error('Invalid pass resource directory.');
    const length = data.getUint16(cursor + 28, true),
      extra = data.getUint16(cursor + 30, true),
      comment = data.getUint16(cursor + 32, true);
    const size = data.getUint32(cursor + 24, true);
    if (cursor + 46 + length + extra + comment > end)
      throw new Error('Invalid pass resource directory.');
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + length));
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      names.has(name)
    )
      throw new Error('Unsafe or duplicate pass resource name.');
    names.add(name);
    if (data.getUint16(cursor + 8, true) & 1)
      throw new Error('Encrypted pass archives are not supported.');
    const maximum =
      name === 'pass.json'
        ? 256 * 1024
        : name.endsWith('pass.strings')
          ? 64 * 1024
          : 8 * 1024 * 1024;
    total += size;
    if (size > maximum || total > 32 * 1024 * 1024)
      throw new Error('Uncompressed pass resources exceed the size limit.');
    cursor += 46 + length + extra + comment;
  }
}
