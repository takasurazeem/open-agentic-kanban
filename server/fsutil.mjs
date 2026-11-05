import fs from 'node:fs';

/** Append text to a file, first adding a newline if the file does not already end with one. */
export function appendLines(file, text) {
  if (!text) return;
  let prefix = '';
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      fs.closeSync(fd);
      if (b[0] !== 0x0a) prefix = '\n';
    }
  } catch {}
  fs.appendFileSync(file, prefix + text);
}
