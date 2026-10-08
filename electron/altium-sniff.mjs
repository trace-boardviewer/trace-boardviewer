/** Bounded schematic header signature; no compound-file parse in the main process. */
export function isSchDoc(data) {
 const head = data.subarray(0, 64 * 1024);
 let text = '';
 for (let at = 0; at < head.length; at += 4096) text += String.fromCharCode(...head.subarray(at, at + 4096));
 const binary = head.length >= 8 && [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((byte,index) => head[index] === byte);
 const signature = '|HEADER=Protel for Windows - Schematic Capture ';
 return binary ? text.includes(signature + 'Binary File Version') : text.trimStart().startsWith(signature + 'Ascii File Version');
}
