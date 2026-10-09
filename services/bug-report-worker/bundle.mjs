const contract = (() => { const module = { exports: {} };
'use strict';

// This module is intentionally dependency-free apart from the repository's closed
// diagnostic schema. The Worker build embeds that schema so the deployed module
// uses these exact same enums.
const diagnosticSchema = {"$id":"trace-format-diagnostic/1","$comment":["Closed whitelist of the content-free format diagnostic report (docs/DIAGNOSTIC-REPORT.md). Anything not listed here is excluded:","objects accept exactly their properties, enumerations are closed, numbers have ranges and rounding rules. Interpreted by","electron/diagnostics.cjs (the one validator, shared by the main process, the tests and owner-side scripts).","Node types: object (properties, required; closed), enum (values or a named list in enums), const, boolean, integer (min, max),","number (min, max, decimals), sig2 (a non-negative integer rounded to two significant digits, max), sig2real (a non-negative number","rounded to two significant digits, max), share (0..1, two decimals), string (pattern, maxLength), array (items, minItems, maxItems),","tuple (items), record (keys: enum or pattern; values; maxEntries), ref (a node of definitions). Any node may be nullable.","level 2 marks a property that only a level-2 report may carry. Adding a field means adding it here AND to","src/lib/diagnostics/schema.golden.txt; the golden test fails otherwise."],"rules":["privacy.level is 1: no property marked level 2 is present.","privacy.dedupe is true exactly when dedupe is a string.","detection.outcome is opened exactly when result and plausibility are objects; unrecognized exactly when detection.selected is null and detection.ambiguous is false; ambiguous implies failed."],"maxBytes":262144,"enums":{"os":["win32","darwin","linux","other"],"extension":["none","other",".cad",".gcd",".gr",".brd",".bdv",".bv",".bv2",".bvr",".fz",".cae",".asc",".pcb",".cst",".xzz",".tvw",".kicad_pcb",".pcbdoc",".cmpcbdoc",".cspcbdoc",".neu",".gbr",".tgz",".xml",".cvg",".obdata",".bom",".txt",".csv",".json",".zip",".gz",".tar",".7z",".rar",".ipc",".d356",".net",".hyp",".fab",".dsn",".ses",".epro",".eprj",".epcb",".sch",".schdoc",".pcblib",".schlib",".kicad_sch",".kicad_pro",".drl",".xln",".gtl",".gbl",".pdf",".mdb",".accdb",".db",".sqlite",".dat",".bin",".boardview",".asm",".lst",".f2b",".ict"],"container":["none","zip","gzip","tar","cfb","sqlite","jet","zlib"],"encoding":["binary","ascii","utf8","utf8-bom","utf16le-bom","utf16be-bom","windows-1252"],"lineEndings":["none","lf","crlf","cr","mixed","n/a"],"magic":["none","gzip","zip","ole-cfb","sqlite","jet-db","ace-db","zlib","tar","7z","rar","pdf","png","jpeg","xml-prolog","utf8-bom","utf16le-bom","utf16be-bom","allegro-16.0","allegro-16.2","allegro-16.4","allegro-16.5","allegro-16.6","allegro-17.2","allegro-17.4","allegro-17.5","allegro-18","xzzpcb","xzzpcb-xor","brd-encoded","bdv-encoded","cst-cdev"],"formatId":["allegro-brd","altium","asc","bdv","brd","brd2","brd-v1","bv","bv2","bvr","bvr1","cst","eagle","easyeda-pro","easyeda-std","fabmaster","farc","fz","gencad","gerber","hyperlynx","ipc2581","ipc356","kicad","mentor-neutral","odbpp","pads-binary","pinlist","samsung-cad","tebo-ict","tvw","unisoft-f2b","vs2","xzz","zip","other"],"sniff":["none","possible","likely","certain"],"hookId":["gencad","brd","bdv","bvr","asc","fz","xzz","cst","kicad","eagle","altium","samsung-cad","allegro-brd","farc","bv","unisoft-f2b","pads-binary","brd-v1","generic-text","generic-binary"],"detectionResult":["declined","claimed","error","skipped"],"errorCode":["INVALID_FORMAT","UNRECOGNIZED","LIMIT_EXCEEDED","KEY_REQUIRED","INVALID_KEY","COMPANIONS_REQUIRED","UNSUPPORTED_VARIANT","WRONG_KIND","AMBIGUOUS_FORMAT","INTERNAL"],"stage":["header","container","decrypt","decompress","records","build"],"keyKind":["fz","xzz"],"outcome":["opened","failed","unrecognized"],"structureKind":["text","binary"],"variant":["gencad-1.4","gencad-other","kicad-footprint","kicad-module","eagle-board","eagle-schematic","eagle-library","altium-cfb","altium-cfb-v4","altium-ascii","altium-schematic","xzz-plain","xzz-xor","cst-int16","samsung-cad","bdv-plain","bdv-encoded","bvr1","bvr3","bvr-other","brd-landrex","brd-landrex-encoded","brd2","asc-trio","fz-text","fz-zlib","fz-rc6","cae-text","cae-zlib","cae-rc6","farc-ascii","farc-faz","bv-jet3","bv-jet4","pads-sdb-2026","pads-sdb-2027","brd-v1-opaque"],"unitKind":["mm","inch","mil","thou","user","mil/10000","per-value","unknown"],"outline":["present","estimated","absent"],"unitsCandidate":["x1","x25.4","x0.0254"],"asReadUnits":["x1","x25.4","x0.0254","other","unknown"],"padAngleCandidate":["absolute","relative","as-read"],"asReadPadAngle":["absolute","relative","none","unknown"],"bottomCandidate":["as-read","mirrored"],"pitch":["0.4","0.5","0.65","0.8","1.0","1.27","2.54","below","between","above","none"],"parity":["valid","invalid","n/a"],"headerCode":["version","unitCode","cfbMajorVersion","cfbSectorShift","obfuscated","encrypted","containerLayout","contentLog2","descriptionLog2","declaredWidthLog2","declaredHeightLog2"],"headerCount":["declaredOutlinePoints","declaredParts","declaredPins","declaredNets","declaredNails","blocks","netRecords","streams","otherStreams","sections","otherSections","companionFiles"],"keyword":["(none)",":SECTION",":EOSECTION","FABMASTER","PARTS","NETS","FABXYDATA","FORMAT","EOARCHIVE","$HEADER","$ENDHEADER","$BOARD","$ENDBOARD","$PADS","$ENDPADS","$PADSTACKS","$ENDPADSTACKS","$SHAPES","$ENDSHAPES","$COMPONENTS","$ENDCOMPONENTS","$DEVICES","$ENDDEVICES","$SIGNALS","$ENDSIGNALS","$TRACKS","$ENDTRACKS","$LAYERS","$ENDLAYERS","$ROUTES","$ENDROUTES","$MECH","$ENDMECH","$TESTPINS","$ENDTESTPINS","$POWERPINS","$ENDPOWERPINS","$PSEUDOS","$ENDPSEUDOS","$CHANGES","$ENDCHANGES","$ARTWORKS","$ENDARTWORKS","$FIDUCIALS","$ENDFIDUCIALS","GENCAD","USER","DRAWING","REVISION","UNITS","ORIGIN","INTERTRACK","LINE","ARC","CIRCLE","RECTANGLE","FILLED","PAD","PADSTACK","SHAPE","INSERT","HEIGHT","PIN","FIDUCIAL","COMPONENT","DEVICE","PLACE","LAYER","ROTATION","MIRROR","FLIP","PART","TYPE","STYLE","PACKAGE","VALUE","TOL","NTOL","PTOL","VOLTS","PINCOUNT","PINDESC","PINFUNCT","PULL","SIGNAL","NODE","TRACK","ROUTE","VIA","TESTPAD","TESTPIN","ATTRIBUTE","ARTWORK","TEXT","SHEET","PLANE","POLYGON","CUTOUT","MASK","LAYERSET","DRILL","WIDTH","SHAPEMODE","str_length:","var_data:","Format:","format:","Parts:","Pins1:","Pins:","Pins2:","Nails:","BRDOUT:","NETS:","PARTS:","PINS:","NAILS:","<<format.asc>>","<<pins.asc>>","<<nails.asc>>","<<Layout>>","<<Pin>>","<<Nail>>","<<other>>","Part","format.asc","pins.asc","nails.asc","BVRAW_FORMAT_1","BVRAW_FORMAT_3","PART_NAME","PART_SIDE","PART_ORIGIN","PART_MOUNT","PART_END","PART_OUTLINE_RELATIVE","PIN_ID","PIN_NUMBER","PIN_NAME","PIN_SIDE","PIN_ORIGIN","PIN_RADIUS","PIN_NET","PIN_TYPE","PIN_COMMENT","PIN_OUTLINE_RELATIVE","PIN_END","OUTLINE_POINTS","OUTLINE_SEGMENTED","###Panel Added","COMP","C_PIN","NET","N_VIA","UNIT:","A!","S!","A!REFDES","A!NET_NAME","A!TESTVIA","A!GRAPHIC_DATA_NAME","A!CLASS","A!LOGOInfo","A!UnDrawSym","A!other","(kicad_pcb","(version","(generator","(generator_version","(general","(paper","(title_block","(layers","(setup","(net","(net_class","(footprint","(module","(gr_line","(gr_arc","(gr_circle","(gr_rect","(gr_poly","(gr_curve","(gr_text","(gr_text_box","(dimension","(segment","(arc","(via","(zone","(target","(group","(image","(embedded_fonts","(embedded_files","(property","(generated","(pad","(fp_line","(fp_arc","(fp_circle","(fp_rect","(fp_poly","(fp_curve","(fp_text","(fp_text_box","(model","(attr","<eagle>","<drawing>","<settings>","<setting>","<grid>","<layers>","<layer>","<board>","<plain>","<libraries>","<library>","<packages>","<package>","<smd>","<pad>","<wire>","<rectangle>","<circle>","<polygon>","<vertex>","<text>","<hole>","<attributes>","<attribute>","<elements>","<element>","<signals>","<signal>","<contactref>","<via>","<description>","<schematic>","<designrules>","<param>","<autorouter>","<pass>","<classes>","<class>","<variantdefs>","<variantdef>","<dimension>","<frame>","<compatibility>","<note>","<packages3d>","<package3d>","<approved>","/Board6","/Components6","/Nets6","/Pads6","/Tracks6","/Vias6","/Arcs6","/Fills6","/Regions6","/ShapeBasedRegions6","/Texts6","/Polygons6","/Classes6","/Rules6","/Dimensions6","/ComponentBodies6","/ShapeBasedComponentBodies6","/Models","/ModelsNoEmbed","/FileHeader","/FileVersionInfo","/Library","/WideStrings6","/Connections6","/DifferentialPairs6","/Embeddeds6","/EmbeddedBoards6","/EmbeddedFonts6","/ExtendedPrimitiveInformation","/FromTos6","/Coordinates6","/PadViaLibrary","/Textures","/BoardRegions","/SmartUnions","/Advanced Placer Options6","/Design Rule Checker Options6","/Pin Swap Options6","/Header","/Data","RECORD=Board","RECORD=Component","RECORD=Net","RECORD=Pad","RECORD=Track","RECORD=Via","RECORD=Arc","RECORD=Fill","RECORD=Region","RECORD=Text","RECORD=Polygon","RECORD=Class","RECORD=Rule","RECORD=Dimension","RECORD=ComponentBody","RECORD=Model","RECORD=other","CDev","CPad"]},"definitions":{"shape":{"type":"string","pattern":"^[A9 !-/:-@\\[-`{-~]{1,120}$","maxLength":120},"fieldStats":{"type":"object","properties":{"min":{"type":"integer","min":0,"max":1000000},"median":{"type":"number","min":0,"max":1000000,"decimals":1},"max":{"type":"integer","min":0,"max":1000000}},"required":["min","median","max"]}},"root":{"type":"object","required":["schema","app","privacy","input","detection","structure","result","plausibility","keys","performance","dedupe"],"properties":{"schema":{"type":"const","value":"trace-format-diagnostic/1"},"app":{"type":"object","required":["version","adapterSet","os"],"properties":{"version":{"type":"string","pattern":"^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$","maxLength":11},"adapterSet":{"type":"string","pattern":"^[0-9a-f]{8}$","maxLength":8},"os":{"type":"enum","values":"os"}}},"privacy":{"type":"object","required":["redaction","level","reviewedByUser","dedupe"],"properties":{"redaction":{"type":"const","value":1},"level":{"type":"integer","min":1,"max":2},"reviewedByUser":{"type":"boolean"},"dedupe":{"type":"boolean"}}},"input":{"type":"object","required":["extension","sizeLog2","companions","container","textLike","encoding","lineEndings","entropy","magic"],"properties":{"extension":{"type":"enum","values":"extension"},"sizeLog2":{"type":"integer","min":0,"max":27},"companions":{"type":"object","required":["count","extensions"],"properties":{"count":{"type":"integer","min":0,"max":8},"extensions":{"type":"array","items":{"type":"enum","values":"extension"},"maxItems":8}}},"container":{"type":"enum","values":"container"},"textLike":{"type":"boolean"},"encoding":{"type":"enum","values":"encoding"},"lineEndings":{"type":"enum","values":"lineEndings"},"entropy":{"type":"array","items":{"type":"number","min":0,"max":8,"decimals":1},"minItems":16,"maxItems":16},"magic":{"type":"enum","values":"magic"}}},"detection":{"type":"object","required":["outcome","selected","format","ambiguous","adapters"],"properties":{"outcome":{"type":"enum","values":"outcome"},"selected":{"type":"enum","values":"formatId","nullable":true},"format":{"type":"enum","values":"formatId","nullable":true},"ambiguous":{"type":"boolean"},"adapters":{"type":"array","maxItems":48,"items":{"type":"object","required":["id","sniff","result","code","stage","format","keyKind"],"properties":{"id":{"type":"enum","values":"formatId"},"sniff":{"type":"enum","values":"sniff"},"result":{"type":"enum","values":"detectionResult"},"code":{"type":"enum","values":"errorCode","nullable":true},"stage":{"type":"enum","values":"stage","nullable":true},"format":{"type":"enum","values":"formatId","nullable":true},"keyKind":{"type":"enum","values":"keyKind","nullable":true}}}}}},"structure":{"type":"object","nullable":true,"required":["hook","kind","variant","headerOk","linesLog2","keywords","fields","numbers","sections","header","blocks"],"properties":{"hook":{"type":"enum","values":"hookId"},"kind":{"type":"enum","values":"structureKind"},"variant":{"type":"enum","values":"variant","nullable":true},"headerOk":{"type":"boolean"},"linesLog2":{"type":"integer","min":0,"max":27,"nullable":true},"keywords":{"type":"record","keys":{"enum":"keyword"},"values":{"type":"sig2","max":100000000},"maxEntries":400},"fields":{"type":"record","keys":{"enum":"keyword"},"values":{"ref":"fieldStats"},"maxEntries":400},"numbers":{"type":"object","nullable":true,"required":["count","magnitude","decimals"],"properties":{"count":{"type":"sig2","max":100000000},"magnitude":{"type":"record","keys":{"pattern":"^(?:zero|-?(?:[0-9]|1[0-5]))$"},"values":{"type":"sig2","max":100000000},"maxEntries":32},"decimals":{"type":"record","keys":{"pattern":"^(?:[0-9]|10\\+)$"},"values":{"type":"sig2","max":100000000},"maxEntries":11}}},"sections":{"type":"array","maxItems":64,"items":{"type":"object","required":["name","records"],"properties":{"name":{"type":"enum","values":"keyword"},"records":{"type":"sig2","max":100000000},"distinctShapes":{"type":"sig2","max":100000000,"level":2},"shapes":{"type":"array","level":2,"maxItems":32,"items":{"type":"object","required":["shape","count"],"properties":{"shape":{"ref":"shape"},"count":{"type":"integer","min":1,"max":32}}}}}}},"header":{"type":"object","required":["codes","counts"],"properties":{"codes":{"type":"record","keys":{"enum":"headerCode"},"values":{"type":"integer","min":0,"max":4294967295},"maxEntries":16},"counts":{"type":"record","keys":{"enum":"headerCount"},"values":{"type":"sig2","max":100000000},"maxEntries":16}}},"blocks":{"type":"object","nullable":true,"required":["tagBits","tags","lengths"],"properties":{"tagBits":{"type":"integer","min":1,"max":32},"tags":{"type":"record","keys":{"pattern":"^(?:0|[1-9][0-9]{0,4})$"},"values":{"type":"sig2","max":100000000},"maxEntries":256},"lengths":{"type":"record","keys":{"pattern":"^(?:[0-9]|[12][0-9]|3[0-2])$"},"values":{"type":"sig2","max":100000000},"maxEntries":33},"sequence":{"type":"array","level":2,"maxItems":256,"items":{"type":"tuple","items":[{"type":"integer","min":0,"max":65535},{"type":"integer","min":0,"max":4294967295}]}}}}}},"result":{"type":"object","nullable":true,"required":["parts","pins","nets","sides","unitKind","outline","pinsWithoutNet","placeholderNets","padSizeKnown"],"properties":{"parts":{"type":"sig2","max":100000000},"pins":{"type":"sig2","max":100000000},"nets":{"type":"sig2","max":100000000},"sides":{"type":"object","required":["top","bottom","both"],"properties":{"top":{"type":"share"},"bottom":{"type":"share"},"both":{"type":"share"}}},"unitKind":{"type":"enum","values":"unitKind"},"outline":{"type":"enum","values":"outline"},"pinsWithoutNet":{"type":"share"},"placeholderNets":{"type":"share"},"padSizeKnown":{"type":"share"}}},"plausibility":{"type":"object","nullable":true,"required":["asReadUnits","asReadPadAngle","pinDensityTopBottom","limited","interpretations"],"properties":{"asReadUnits":{"type":"enum","values":"asReadUnits"},"asReadPadAngle":{"type":"enum","values":"asReadPadAngle"},"pinDensityTopBottom":{"type":"sig2real","max":1000000,"nullable":true},"limited":{"type":"boolean"},"interpretations":{"type":"array","maxItems":12,"items":{"type":"object","required":["units","padAngle","bottom","asRead","pinsInsideOutline","overlappingPadPairs","medianPitch"],"properties":{"units":{"type":"enum","values":"unitsCandidate"},"padAngle":{"type":"enum","values":"padAngleCandidate"},"bottom":{"type":"enum","values":"bottomCandidate"},"asRead":{"type":"boolean"},"pinsInsideOutline":{"type":"share","nullable":true},"overlappingPadPairs":{"type":"sig2","max":100000000,"nullable":true},"medianPitch":{"type":"enum","values":"pitch"}}}}}},"keys":{"type":"object","required":["supplied","parity"],"properties":{"supplied":{"type":"boolean"},"parity":{"type":"enum","values":"parity"}}},"performance":{"type":"object","required":["parseMs","peakHeapLog2"],"properties":{"parseMs":{"type":"sig2","max":100000000},"peakHeapLog2":{"type":"integer","min":0,"max":40,"nullable":true}}},"dedupe":{"type":"string","pattern":"^[0-9a-f]{16}$","maxLength":16,"nullable":true}}}};

const SCHEMA = 'trace-bug-report/1';
const ACK_SCHEMA = 'trace-bug-report-ack/1';
const MAX_BYTES = 16 * 1024;
const MAX_DESCRIPTION_CODE_POINTS = 2000;
const MAX_DESCRIPTION_RAW_CODE_UNITS = 8192;
const FORMATS = Object.freeze(diagnosticSchema.enums.formatId.slice());
const EXTENSIONS = Object.freeze(diagnosticSchema.enums.extension.slice());
const LOCALES = Object.freeze(['hu', 'en', 'de', 'fr', 'it', 'sk', 'pl', 'uk']);
const PLATFORMS = Object.freeze(['windows', 'macos', 'linux', 'other']);
const ARCHES = Object.freeze(['x64', 'arm64', 'other']);
const SURFACES = Object.freeze(['welcome', 'board', 'documents', 'schematic', 'settings', 'other']);
const OUTCOMES = Object.freeze(['reading', 'processing', 'opened', 'failed', 'cancelled', 'key-required', 'timeout', 'worker-failed']);
const STAGES = Object.freeze(['read', 'detect', 'unpack', 'parse', 'done', 'unknown']);
const ERROR_CODES = Object.freeze([...diagnosticSchema.enums.errorCode, 'READ_FAILED', 'WORKER_FAILED', 'TIMEOUT', 'CANCELLED', 'UNKNOWN']);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keysAre = (value, required, optional = []) => isRecord(value) && Object.keys(value).length >= required.length &&
  Object.keys(value).length <= required.length + optional.length && required.every(key => own(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const utf8Length = value => new TextEncoder().encode(value).length;
const codePoints = value => Array.from(value).length;
const enumHas = (values, value) => typeof value === 'string' && values.includes(value);
const uuidV4 = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function hasInvalidSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function validateLastImport(value) {
  if (value === null) return true;
  return keysAre(value, ['outcome', 'stage', 'formatId', 'extensionClass', 'errorCode']) &&
    enumHas(OUTCOMES, value.outcome) && enumHas(STAGES, value.stage) &&
    (value.formatId === null || enumHas(FORMATS, value.formatId)) &&
    enumHas(EXTENSIONS, value.extensionClass) &&
    (value.errorCode === null || enumHas(ERROR_CODES, value.errorCode));
}

function validateDiagnostics(value) {
  if (value === null) return true;
  return keysAre(value, ['app', 'locale', 'surface', 'lastImport']) &&
    keysAre(value.app, ['version', 'platform', 'arch']) &&
    typeof value.app.version === 'string' && value.app.version.length > 0 && value.app.version.length <= 32 &&
    /^[0-9A-Za-z.+-]+$/.test(value.app.version) && enumHas(PLATFORMS, value.app.platform) && enumHas(ARCHES, value.app.arch) &&
    enumHas(LOCALES, value.locale) && enumHas(SURFACES, value.surface) && validateLastImport(value.lastImport);
}

function validateBugReport(value) {
  if (!keysAre(value, ['schema', 'reportId', 'description', 'diagnostics'])) return { ok: false, error: 'INVALID_SHAPE' };
  if (value.schema !== SCHEMA || !uuidV4(value.reportId)) return { ok: false, error: 'INVALID_IDENTITY' };
  if (typeof value.description !== 'string' || value.description.length > MAX_DESCRIPTION_RAW_CODE_UNITS) return { ok: false, error: 'INVALID_DESCRIPTION' };
  if (codePoints(value.description) < 1 || codePoints(value.description) > MAX_DESCRIPTION_CODE_POINTS ||
      utf8Length(value.description) > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.description) ||
      value.description.includes('\r') || hasInvalidSurrogate(value.description)) return { ok: false, error: 'INVALID_DESCRIPTION' };
  if (!validateDiagnostics(value.diagnostics)) return { ok: false, error: 'INVALID_DIAGNOSTICS' };
  return { ok: true, value };
}

function canonicalizeBugReport(value) {
  const checked = validateBugReport(value);
  if (!checked.ok) throw new TypeError(checked.error);
  const diagnostics = value.diagnostics === null ? null : {
    app: { version: value.diagnostics.app.version, platform: value.diagnostics.app.platform, arch: value.diagnostics.app.arch },
    locale: value.diagnostics.locale,
    surface: value.diagnostics.surface,
    lastImport: value.diagnostics.lastImport === null ? null : {
      outcome: value.diagnostics.lastImport.outcome,
      stage: value.diagnostics.lastImport.stage,
      formatId: value.diagnostics.lastImport.formatId,
      extensionClass: value.diagnostics.lastImport.extensionClass,
      errorCode: value.diagnostics.lastImport.errorCode
    }
  };
  return JSON.stringify({ schema: value.schema, reportId: value.reportId, description: value.description, diagnostics });
}

function projectBugReport(input) {
  if (!isRecord(input)) throw new TypeError('INVALID_SHAPE');
  if (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION_RAW_CODE_UNITS) throw new TypeError('INVALID_DESCRIPTION');
  const description = typeof input.description === 'string'
    ? input.description.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    : '';
  const report = {
    schema: SCHEMA,
    reportId: input.reportId,
    description,
    diagnostics: input.diagnostics === null ? null : projectDiagnostics(input.diagnostics)
  };
  const checked = validateBugReport(report);
  if (!checked.ok) throw new TypeError(checked.error);
  return report;
}

function projectDiagnostics(input) {
  if (!isRecord(input)) return null;
  const app = isRecord(input.app) ? input.app : {};
  const last = isRecord(input.lastImport) ? input.lastImport : null;
  return {
    app: {
      version: typeof app.version === 'string' ? app.version.slice(0, 32) : '',
      platform: enumHas(PLATFORMS, app.platform) ? app.platform : 'other',
      arch: enumHas(ARCHES, app.arch) ? app.arch : 'other'
    },
    locale: enumHas(LOCALES, input.locale) ? input.locale : 'en',
    surface: enumHas(SURFACES, input.surface) ? input.surface : 'other',
    lastImport: last ? {
      outcome: enumHas(OUTCOMES, last.outcome) ? last.outcome : 'failed',
      stage: enumHas(STAGES, last.stage) ? last.stage : 'unknown',
      formatId: enumHas(FORMATS, last.formatId) ? last.formatId : null,
      extensionClass: enumHas(EXTENSIONS, last.extensionClass) ? last.extensionClass : 'other',
      errorCode: enumHas(ERROR_CODES, last.errorCode) ? last.errorCode : null
    } : null
  };
}

function isValidAcknowledgement(value, reportId, payloadHash) {
  return keysAre(value, ['schema', 'reportId', 'payloadHash', 'status']) && value.schema === ACK_SCHEMA &&
    value.reportId === reportId && value.payloadHash === payloadHash && value.status === 'received';
}

module.exports = Object.freeze({
  SCHEMA, ACK_SCHEMA, MAX_BYTES, MAX_DESCRIPTION_CODE_POINTS, MAX_DESCRIPTION_RAW_CODE_UNITS, FORMATS, EXTENSIONS, LOCALES, PLATFORMS, ARCHES,
  SURFACES, OUTCOMES, STAGES, ERROR_CODES, validateBugReport, canonicalizeBugReport, projectBugReport, isValidAcknowledgement
});

return module.exports; })();

const MAX_BODY_BYTES = contract.MAX_BYTES;
const BODY_DEADLINE_MS = 5000;
const RETENTION_MS = 29 * 24 * 60 * 60 * 1000;
const COUNTER_RETENTION_MS = 24 * 60 * 60 * 1000;
const REPORT_CLEANUP_LIMIT = 500;
const COUNTER_CLEANUP_LIMIT = 2500;

function reply(status, value, extra = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  return new Response(JSON.stringify(value), { status, headers });
}

const errors = Object.freeze({
  bad: () => reply(400, { error: 'invalid_request' }),
  tooLarge: () => reply(413, { error: 'request_too_large' }),
  media: () => reply(415, { error: 'unsupported_media_type' }),
  method: () => reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' }),
  forbidden: () => reply(403, { error: 'origin_not_allowed' }),
  unavailable: () => reply(503, { error: 'temporarily_unavailable' }),
  sourceLimit: () => reply(429, { error: 'rate_limited' }, { 'Retry-After': '60' }),
  globalLimit: () => reply(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '3600' }),
  conflict: () => reply(409, { error: 'report_conflict' })
});

function hasExcessiveDepth(text) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') {
      depth++;
      if (depth > 8) return true;
    } else if (c === '}' || c === ']') depth--;
  }
  return false;
}

async function readBody(request) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return { kind: 'large' };
  if (!request.body) return { kind: 'invalid' };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const read = (async () => {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) return { kind: 'ok', bytes: concat(chunks, size) };
        size += item.value.byteLength;
        if (size > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          return { kind: 'large' };
        }
        chunks.push(item.value);
      }
    } catch {
      return { kind: 'invalid' };
    }
  })();
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), BODY_DEADLINE_MS); });
  const result = await Promise.race([read, timeout]);
  clearTimeout(timer);
  if (result.kind === 'timeout') void reader.cancel().catch(() => {});
  return result;
}

function concat(chunks, size) {
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

function dayKey(now) { return new Date(now).toISOString().slice(0, 10); }
function windowKey(now) { return Math.floor(now / 600000) * 600000; }
async function sha256Hex(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}
function dbStatement(db, sql, ...values) { return db.prepare(sql).bind(...values); }
function changes(result) { return Number(result?.meta?.changes ?? result?.changes ?? 0); }

async function dailySalt(db, day, now) {
  const candidate = crypto.getRandomValues(new Uint8Array(32));
  await dbStatement(db,
    'INSERT OR IGNORE INTO bug_report_daily_salts(day, salt, created_at) VALUES (?, ?, ?)', day, candidate, now).run();
  const row = await dbStatement(db, 'SELECT salt FROM bug_report_daily_salts WHERE day = ?', day).first();
  if (!row?.salt) throw new Error('salt unavailable');
  return row.salt instanceof Uint8Array ? row.salt : new Uint8Array(row.salt);
}

async function sourceBucket(db, request, day, now) {
  const salt = await dailySalt(db, day, now);
  const ip = request.headers.get('CF-Connecting-IP') || 'missing-source-address';
  const text = new TextEncoder().encode(ip);
  const joined = new Uint8Array(salt.byteLength + text.byteLength);
  joined.set(salt); joined.set(text, salt.byteLength);
  return sha256Hex(joined);
}

async function classifyDenied(db, bucket, windowStart, day) {
  const source = await dbStatement(db,
    'SELECT attempts FROM bug_report_source_counts WHERE source_hash = ? AND window_start = ?', bucket, windowStart).first();
  if (Number(source?.attempts || 0) >= 20) return errors.sourceLimit();
  const global = await dbStatement(db, 'SELECT attempts FROM bug_report_request_counts WHERE day = ?', day).first();
  if (Number(global?.attempts || 0) >= 2000) return errors.globalLimit();
  return errors.unavailable();
}

async function submit(db, request, report, canonical, hash, now) {
  const day = dayKey(now);
  const windowStart = windowKey(now);
  const bucket = await sourceBucket(db, request, day, now);
  const admissionId = crypto.randomUUID();
  const receivedAt = Math.floor(now / 1000);
  const expiresAt = Math.floor((now + RETENTION_MS) / 1000);
  const results = await db.batch([
    dbStatement(db, 'INSERT INTO bug_report_admissions(admission_id, source_hash, window_start, day, admitted_at) VALUES (?, ?, ?, ?, ?)', admissionId, bucket, windowStart, day, now),
    dbStatement(db,
      'INSERT OR IGNORE INTO bug_reports(report_id, payload_hash, payload_json, received_at, received_day, expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bug_report_admissions WHERE admission_id = ?)',
      report.reportId, hash, canonical, receivedAt, day, expiresAt, admissionId)
  ]);
  if (changes(results?.[0]) === 0) return classifyDenied(db, bucket, windowStart, day);
  const row = await dbStatement(db, 'SELECT payload_hash FROM bug_reports WHERE report_id = ?', report.reportId).first();
  if (!row) return errors.globalLimit();
  if (row.payload_hash !== hash) return errors.conflict();
  const inserted = changes(results?.[1]) > 0;
  return reply(inserted ? 201 : 200, { schema: contract.ACK_SCHEMA, reportId: report.reportId, payloadHash: hash, status: 'received' });
}

async function handlePost(request, env) {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== 'null') return errors.forbidden();
  const contentType = request.headers.get('Content-Type') || '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) || request.headers.has('Content-Encoding')) return errors.media();
  const body = await readBody(request);
  if (body.kind === 'large') return errors.tooLarge();
  if (body.kind !== 'ok') return errors.bad();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes); } catch { return errors.bad(); }
  if (hasExcessiveDepth(text)) return errors.bad();
  let report;
  try { report = JSON.parse(text); } catch { return errors.bad(); }
  if (!contract.validateBugReport(report).ok) return errors.bad();
  const canonical = contract.canonicalizeBugReport(report);
  if (new TextEncoder().encode(canonical).byteLength > MAX_BODY_BYTES) return errors.tooLarge();
  const hash = await sha256Hex(new TextEncoder().encode(canonical));
  if (!env?.BUG_REPORT_DB) return errors.unavailable();
  try { return await submit(env.BUG_REPORT_DB, request, report, canonical, hash, Date.now()); }
  catch { return errors.unavailable(); }
}

async function fetchHandler(request, env) {
  let url;
  try { url = new URL(request.url); } catch { return errors.bad(); }
  if (url.protocol !== 'https:' || url.search || url.hash) return errors.bad();
  if (url.pathname === '/health' && request.method === 'GET') return reply(200, { status: 'ok' });
  if (url.pathname !== '/v1/reports') return reply(404, { error: 'not_found' });
  if (request.method !== 'POST') return errors.method();
  return handlePost(request, env);
}

async function cleanupBatch(db, table, predicate, beforeValue, limit) {
  return dbStatement(db,
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} < ? LIMIT ${limit})`, beforeValue).run();
}

async function scheduledHandler(_controller, env) {
  if (!env?.BUG_REPORT_DB) return;
  const now = Date.now();
  try {
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_reports', 'expires_at', Math.floor(now / 1000), REPORT_CLEANUP_LIMIT);
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_report_admissions', 'admitted_at', now - COUNTER_RETENTION_MS, COUNTER_CLEANUP_LIMIT);
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_report_source_counts', 'window_start', now - COUNTER_RETENTION_MS, COUNTER_CLEANUP_LIMIT);
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_report_request_counts', 'created_at', now - COUNTER_RETENTION_MS, 2);
    await cleanupBatch(env.BUG_REPORT_DB, 'bug_report_daily_salts', 'created_at', now - COUNTER_RETENTION_MS, 2);
  } catch { /* Scheduled cleanup is retried on the next invocation. */ }
}

export const worker = Object.freeze({ fetch: fetchHandler, scheduled: scheduledHandler });
export default worker;
