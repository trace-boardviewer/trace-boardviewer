import { describe, expect, it } from 'vitest';
import {
  CP2110_MAX_DATA, CP2110_PRODUCT_ID, CP2110_VENDOR_ID, cp2110DataReports, cp2110Payload, cp2110PurgeFifo, cp2110UartConfig, cp2110UartEnable,
  lengthPrefixedPayload, UT61EPLUS_UART_SETUP,
} from './cp2110';
import { createUt61EplusDecoder, encodeUt61EplusFrame } from './ut61eplus';

describe('CP2110 report framing', () => {
  it('builds the feature reports of the UT61E+ UART setup', () => {
    expect(CP2110_VENDOR_ID).toBe(0x10c4);
    expect(CP2110_PRODUCT_ID).toBe(0xea80);
    expect(cp2110UartEnable()).toEqual({ reportId: 0x41, data: Uint8Array.of(1) });
    expect(cp2110UartEnable(false).data).toEqual(Uint8Array.of(0));
    expect(cp2110PurgeFifo()).toEqual({ reportId: 0x43, data: Uint8Array.of(3) });
    expect(cp2110PurgeFifo('rx').data).toEqual(Uint8Array.of(2));
    expect(cp2110PurgeFifo('tx').data).toEqual(Uint8Array.of(1));
    // 9600 baud = 0x2580, no parity, no flow control, 8 data bits (code 3), short stop bit.
    expect(UT61EPLUS_UART_SETUP).toEqual([
      { reportId: 0x41, data: Uint8Array.of(1) },
      { reportId: 0x50, data: Uint8Array.of(0x00, 0x00, 0x25, 0x80, 0x00, 0x00, 0x03, 0x00) },
    ]);
  });

  it('encodes other UART settings and refuses impossible baud rates', () => {
    expect(cp2110UartConfig({ baudRate: 115200, parity: 'even', flowControl: 'hardware', dataBits: 7, stopBits: 'long' }).data)
      .toEqual(Uint8Array.of(0x00, 0x01, 0xc2, 0x00, 2, 1, 2, 1));
    expect(() => cp2110UartConfig({ baudRate: 0 })).toThrow(RangeError);
    expect(() => cp2110UartConfig({ baudRate: 1.5 })).toThrow(RangeError);
    expect(() => cp2110UartConfig({ baudRate: 2_000_000 })).toThrow(RangeError);
  });

  it('cuts outgoing data into reports whose id is the byte count', () => {
    expect(cp2110DataReports([])).toEqual([]);
    expect(cp2110DataReports([0xab, 0xcd, 0x03, 0x5e, 0x01, 0xd9])).toEqual([{ reportId: 6, data: Uint8Array.of(0xab, 0xcd, 0x03, 0x5e, 0x01, 0xd9) }]);
    const reports = cp2110DataReports(new Uint8Array(CP2110_MAX_DATA * 2 + 5));
    expect(reports.map(r => r.reportId)).toEqual([63, 63, 5]);
    expect(reports.map(r => r.data.length)).toEqual([63, 63, 5]);
  });

  it('unpacks incoming reports and rejects impossible ones', () => {
    expect([...cp2110Payload(3, [1, 2, 3])]).toEqual([1, 2, 3]);
    expect([...cp2110Payload(2, [1, 2, 3, 4])]).toEqual([1, 2]);
    expect(cp2110Payload(0, [1]).length).toBe(0);
    expect(cp2110Payload(64, new Array(64).fill(1)).length).toBe(0);
    expect(cp2110Payload(5, [1, 2]).length).toBe(0);
    expect([...lengthPrefixedPayload([2, 0xaa, 0xbb, 0xcc])]).toEqual([0xaa, 0xbb]);
    expect(lengthPrefixedPayload([]).length).toBe(0);
    expect(lengthPrefixedPayload([0, 1]).length).toBe(0);
    expect(lengthPrefixedPayload([5, 1, 2]).length).toBe(0);
    expect(lengthPrefixedPayload([64, ...new Array(64).fill(0)]).length).toBe(0);
  });

  it('feeds a UT61E+ decoder from input reports, whatever the report boundaries', () => {
    const frame = encodeUt61EplusFrame({ mode: 2, range: 0, display: ' 4.5120' });
    const decoder = createUt61EplusDecoder();
    const out = [];
    // Two replies in three reports of uneven size; each report id is its byte count.
    const bytes = [...frame, ...frame];
    const sizes = [11, 20, 7];
    let offset = 0;
    for (const size of sizes) {
      const data = bytes.slice(offset, offset + size);
      out.push(...decoder.push(cp2110Payload(size, data), offset));
      offset += size;
    }
    expect(out.map(r => r.value)).toEqual([4.512, 4.512]);
    // The same bytes behind a length byte, as a bridge without report ids delivers them.
    const second = createUt61EplusDecoder();
    expect(second.push(lengthPrefixedPayload([frame.length, ...frame])).length).toBe(1);
  });
});
