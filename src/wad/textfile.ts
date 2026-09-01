/**
 * The text file beside a WAD — `SCYTHE.TXT` next to `SCYTHE.WAD`, the release note every idgames
 * upload ships with. Finding it by name and decoding its bytes, shared by the three places a WAD
 * reaches the menu from. See docs/wad.md § The text file beside a WAD.
 */

/**
 * A WAD's sibling text file: what it is called, and how to read it. **Presence is the whole of the
 * question the menu asks** — the two WAD lists draw their info column from a source carrying one of
 * these, without reading a byte; `read` runs only when the player opens it.
 */
export interface WadTextFile {
  /** The file's own name, as it is spelled on disk — the popup's heading. */
  name: string;
  read(): Promise<string>;
}

/**
 * The sibling of `NAME.WAD` among `names`, or undefined. Matched case-insensitively and on the
 * base name alone: `SCYTHE.WAD` is shipped beside `scythe.txt` as often as beside `SCYTHE.TXT`,
 * and the name that comes back is the one that will actually open.
 */
export function siblingTextFile(wadName: string, names: Iterable<string>): string | undefined {
  const wanted = wadName.replace(/\.wad$/i, '').toLowerCase() + '.txt';
  for (const name of names) if (name.toLowerCase() === wanted) return name;
  return undefined;
}

/**
 * Code page 437's upper half, `0x80`–`0xFF`. These files are DOS-era: the standard idgames template
 * is plain ASCII, but the banners and rules authors draw over it are CP437 box art, which no
 * `TextDecoder` label covers (the encoding standard dropped the page). Latin-1 would render every
 * one of those as a stray accented letter.
 */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A text file's bytes as text. UTF-8 first and CP437 second, in that order because the two can't
 * both be guessed at: a file that decodes as UTF-8 at all was almost certainly written as one
 * (the high bytes of a CP437 banner are not valid sequences), while everything that fails is
 * DOS-era and is read through the table above.
 *
 * Line endings are normalised and the DOS end-of-file byte dropped, so a `<pre>` shows the file
 * rather than the file's transport.
 */
export function decodeTextFile(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text: string;
  try {
    text = UTF8.decode(view);
  } catch {
    let out = '';
    for (const byte of view) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
    text = out;
  }
  return text.replace(/\r\n?/g, '\n').replace(/\u001a+$/, '');
}
