import { describe, expect, it } from 'vitest';
import adapter from './index';
import { textInput } from '../../common';
describe('VS2 assembly listing recognition', () => {
  it('explains the missing plane/electrical semantics for an exact first-line header', () => {
    const input = textInput('$VS2 SYNTHETIC\n$ASM SYNTHETIC\n', 'synthetic.lst');
    expect(adapter.sniff({ head: input.data, name: input.name, size: input.data.length })).toMatchObject({ confidence: 95 });
    expect(() => adapter.parse(input, {} as never)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VARIANT', format: 'vs2' }));
  });
  it.each(['prefix $VS2', '$VS20', '$VS2_OTHER', '\0$VS2', '$HEADER\nGENCAD 1.4\n'])('does not claim unrelated text %j', text => {
    const input = textInput(text, 'synthetic.lst');
    expect(adapter.sniff({ head: input.data, name: input.name, size: input.data.length }).confidence).toBe(0);
    expect(adapter.parse(input, {} as never)).toBeNull();
  });
});
