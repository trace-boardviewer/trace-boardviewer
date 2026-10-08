/** Content-free pair header and row facts; the existing generic-text schema vocabulary is sufficient. */
import { NO_SECTION } from '../diagnostics/report';
import { safeText, textLines, type StructureHook } from '../diagnostics/structure';
import { hasTeboIctHeader } from './tebo-ict';
const knownRole = (name: string) => /^(?:board|board_xy)(?:\.ict)?$/.test(name.split(/[\\/]/).pop()?.toLowerCase() ?? '');
export const teboIctHook: StructureHook = {
  id: 'generic-text', kind: 'text', steps: ['header'], keywords: ['NODE', 'UNITS'],
  collect(input, sink) {
    sink.padAngle('none'); sink.section(NO_SECTION);
    const files = [input.data, ...Object.entries(input.companions).filter(([name]) => knownRole(name)).map(([, data]) => data)];
    sink.count('companionFiles', files.length - 1);
    let geometry = false, program = false;
    for (const data of files) {
      if (!hasTeboIctHeader(data)) continue;
      const text = safeText(data); if (text === null) continue;
      sink.code('version', 30);
      let units = false, scale = false, outline = false, connections = false;
      for (const raw of textLines(text)) {
        const line = raw.trim(); sink.line(raw);
        if (!line || line.startsWith('!')) continue;
        const fields = line.split(/[\s,;]+/).filter(Boolean);
        if (/^units\s+inches\s*;$/i.test(line)) { units = true; sink.units('inch', 25.4); sink.keyword('UNITS', fields.length); }
        else if (line.startsWith('NODE ')) sink.keyword('NODE', fields.length);
        else sink.row(fields.length);
        scale ||= /^scale\s+1\s*;$/i.test(line); outline ||= line === 'OUTLINE'; connections ||= line === 'CONNECTIONS';
      }
      geometry ||= units && scale && outline; program ||= connections;
    }
    if (geometry && program) sink.reached('header');
  },
};
