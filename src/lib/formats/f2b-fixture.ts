/** Original synthetic MFC archive; no bytes or labels originate in an input board. */
export function makeF2b(options: { version?: 6 | 8; payloadVersion?: 7 | 8 | 9; bottom?: boolean; through?: boolean; resolution?: number } = {}) {
  const bytes: number[] = [], offsets: Record<string, number> = {}, version = options.version ?? 8;
  const mark = (name: string) => { offsets[name] = bytes.length; };
  const u16 = (value: number) => { bytes.push(value & 255, value >>> 8 & 255); };
  const u32 = (value: number) => { u16(value); u16(value >>> 16); };
  const zeros = (length: number) => { for (let n = 0; n < length; n++) bytes.push(0); };
  const string = (value: string) => { const text = new TextEncoder().encode(value); if (text.length >= 255) throw new Error('fixture string too long'); bytes.push(text.length, ...text); };
  const classHeader = (name: string) => { u16(0xffff); u16(1); u16(name.length); bytes.push(...new TextEncoder().encode(name)); };
  u32(version); [-100, -100, 2000, 2000].forEach(u16); bytes.push(0);
  const float = new Uint8Array(4); new DataView(float.buffer).setFloat32(0, options.resolution ?? 1000, true); bytes.push(...float);
  u16(1); u16(1);
  mark('traceList'); u16(1); string('CTraceList'); u16(1); mark('traceCount'); u16(1); zeros(28);
  u16(0x7fff); u16(0);
  string('CPinList'); u16(1); mark('pinCount'); u16(2);
  const flags = options.through ? options.bottom ? 164 : 80 : options.bottom ? 44 : 24;
  for (let n = 0; n < 2; n++) {
    mark(`pin${n}`); u16(1); u16(1000 + n * 500); u16(1000); u16(flags); u16(n ? 2 : -1); u16(n + 1);
    mark(`owner${n}`);
    if (n) { u16(2); continue; }
    mark('componentClass'); classHeader('CComponent'); mark('componentVersion');
    const payload = options.payloadVersion ?? (version === 6 ? 7 : 8); u16(payload);
    [1000, 1500, 1000, 1000].forEach(u16);
    ['U1', 'PN-DEMO', '', '', '', ''].forEach(string);
    mark('componentTail'); u16(2); zeros(({ 7: 43, 8: 47, 9: 51 } as const)[payload] - 2);
  }
  u16(1); string('U1'); mark('dictionaryOwner'); u16(2);
  string('NetNames'); u16(1); u16(3);
  for (const [key, name] of [[1, 'GND'], [2, 'SIGNAL_A'], [0xffff, 'A1']] as const) { mark(`nameKey${key}`); u16(key); string(name); }
  mark('metadata'); string('synthetic.fba'); u16(6); string('synthetic.fba'); zeros(19); u16(6); string('synthetic.fba'); zeros(22);
  if (version === 8) {
    u16(1); string('PN-DEMO'); mark('partClass'); classHeader('CPartNumber'); mark('partVersion');
    u16(3); string('PN-DEMO'); string(''); mark('partReferences'); u32(1); string('U1'); zeros(12);
    mark('settings'); u32(2); u32(0); u32(0xff00); u32(2); u32(1); u32(2); u32(3);
  }
  return { data: Uint8Array.from(bytes), offsets };
}
