/**
 * Report framing of the CP2110 USB HID to UART bridge (built into the UT61E+), and of HID bridges that prefix a length byte.
 *
 * Follows the "CP2110/4 Interface Specification" (AN434) as far as the UT61E+ needs it, and the byte sequences the community
 * UT61E+ notes give:
 *   - data moves in interrupt reports whose report ID is the number of data bytes (1 to 63);
 *   - feature report 0x41 enables or disables the UART, 0x43 purges the FIFOs, 0x50 sets the UART configuration:
 *     baud rate (4 bytes, big endian), parity, flow control, data bits, stop bits.
 * The UT61E+ talks 9600 baud, 8 data bits, no parity, no flow control, one stop bit. The community client sends one more
 * trailing 0x00 after the stop bits; the transport must size the feature report as the device's HID descriptor says.
 *
 * Pure: the functions build and unpack byte arrays. Sending them is the transport's job (WebHID `sendReport`,
 * `sendFeatureReport`, and the `inputreport` event).
 */

export const CP2110_VENDOR_ID = 0x10c4;
export const CP2110_PRODUCT_ID = 0xea80;

export const CP2110_REPORT = { uartEnable: 0x41, uartStatus: 0x42, purgeFifo: 0x43, uartConfig: 0x50 } as const;

/** Most data one interrupt report carries. */
export const CP2110_MAX_DATA = 63;

export interface HidReport { reportId: number; data: Uint8Array; }

export function cp2110UartEnable(enable = true): HidReport {
  return { reportId: CP2110_REPORT.uartEnable, data: Uint8Array.of(enable ? 1 : 0) };
}

/** Which FIFOs to flush: 1 transmit, 2 receive, 3 both. */
export function cp2110PurgeFifo(which: 'tx' | 'rx' | 'both' = 'both'): HidReport {
  return { reportId: CP2110_REPORT.purgeFifo, data: Uint8Array.of(which === 'tx' ? 1 : which === 'rx' ? 2 : 3) };
}

export interface Cp2110UartConfig {
  baudRate: number;
  parity?: 'none' | 'odd' | 'even' | 'mark' | 'space';
  flowControl?: 'none' | 'hardware';
  dataBits?: 5 | 6 | 7 | 8;
  /** 'short' is one stop bit; 'long' is 1.5 bits for 5 data bits and 2 bits otherwise. */
  stopBits?: 'short' | 'long';
}

const PARITY = { none: 0, odd: 1, even: 2, mark: 3, space: 4 } as const;

export function cp2110UartConfig(config: Cp2110UartConfig): HidReport {
  if (!Number.isInteger(config.baudRate) || config.baudRate < 300 || config.baudRate > 1_000_000) throw new RangeError('baud rate out of range');
  const baud = config.baudRate;
  const data = Uint8Array.of(
    (baud >>> 24) & 0xff, (baud >>> 16) & 0xff, (baud >>> 8) & 0xff, baud & 0xff,
    PARITY[config.parity ?? 'none'],
    config.flowControl === 'hardware' ? 1 : 0,
    (config.dataBits ?? 8) - 5,
    config.stopBits === 'long' ? 1 : 0,
  );
  return { reportId: CP2110_REPORT.uartConfig, data };
}

/** The UART setup of the UT61E+: the two feature reports, in the order they must be sent. */
export const UT61EPLUS_UART_SETUP: readonly HidReport[] = [
  cp2110UartEnable(true),
  cp2110UartConfig({ baudRate: 9600, parity: 'none', flowControl: 'none', dataBits: 8, stopBits: 'short' }),
];

/** Outgoing data as interrupt reports of at most 63 bytes each; the report ID is the byte count. */
export function cp2110DataReports(bytes: ArrayLike<number>): HidReport[] {
  const reports: HidReport[] = [];
  for (let offset = 0; offset < bytes.length; offset += CP2110_MAX_DATA) {
    const size = Math.min(CP2110_MAX_DATA, bytes.length - offset);
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = bytes[offset + i] & 0xff;
    reports.push({ reportId: size, data });
  }
  return reports;
}

/**
 * The payload of an incoming interrupt report whose ID is its length (WebHID `inputreport`: `event.reportId` and the data
 * without the ID). Reports with an impossible ID, or shorter than their ID says, give an empty array.
 */
export function cp2110Payload(reportId: number, data: ArrayLike<number>): Uint8Array {
  if (reportId < 1 || reportId > CP2110_MAX_DATA || data.length < reportId) return new Uint8Array(0);
  const out = new Uint8Array(reportId);
  for (let i = 0; i < reportId; i++) out[i] = data[i] & 0xff;
  return out;
}

/**
 * HID bridges that deliver the length in the first data byte (report ID 0, data = [length, ...bytes]): the bytes after the
 * length, cut to it. An impossible length gives an empty array.
 */
export function lengthPrefixedPayload(report: ArrayLike<number>): Uint8Array {
  if (report.length < 1) return new Uint8Array(0);
  const size = report[0];
  if (size < 1 || size > CP2110_MAX_DATA || report.length < 1 + size) return new Uint8Array(0);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = report[1 + i] & 0xff;
  return out;
}
