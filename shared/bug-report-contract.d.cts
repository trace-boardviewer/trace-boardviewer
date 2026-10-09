declare namespace BugReportContract {
  type Platform = 'windows' | 'macos' | 'linux' | 'other';
  type Architecture = 'x64' | 'arm64' | 'other';
  type Locale = 'hu' | 'en' | 'de' | 'fr' | 'it' | 'sk' | 'pl' | 'uk';
  type LastImport = {
    outcome: 'reading' | 'processing' | 'opened' | 'failed' | 'cancelled' | 'key-required' | 'timeout' | 'worker-failed';
    stage: 'read' | 'detect' | 'unpack' | 'parse' | 'done' | 'unknown';
    formatId: string | null;
    extensionClass: string;
    errorCode: string | null;
  } | null;
  type Diagnostics = {
    app: { version: string; platform: Platform; arch: Architecture };
    locale: Locale;
    surface: 'welcome' | 'board' | 'documents' | 'schematic' | 'settings' | 'other';
    lastImport: LastImport;
  } | null;
  type BugReport = { schema: 'trace-bug-report/1'; reportId: string; description: string; diagnostics: Diagnostics };
  type Validation = { ok: true; value: BugReport } | { ok: false; error: string };
}

declare const BugReportContract: {
  readonly SCHEMA: 'trace-bug-report/1';
  readonly ACK_SCHEMA: 'trace-bug-report-ack/1';
  readonly MAX_BYTES: 16384;
  readonly MAX_DESCRIPTION_CODE_POINTS: 2000;
  readonly MAX_DESCRIPTION_RAW_CODE_UNITS: 8192;
  readonly FORMATS: readonly string[];
  readonly EXTENSIONS: readonly string[];
  readonly LOCALES: readonly BugReportContract.Locale[];
  readonly PLATFORMS: readonly BugReportContract.Platform[];
  readonly ARCHES: readonly BugReportContract.Architecture[];
  readonly SURFACES: readonly string[];
  readonly OUTCOMES: readonly string[];
  readonly STAGES: readonly string[];
  readonly ERROR_CODES: readonly string[];
  validateBugReport(value: unknown): BugReportContract.Validation;
  canonicalizeBugReport(value: unknown): string;
  projectBugReport(input: unknown): BugReportContract.BugReport;
  isValidAcknowledgement(value: unknown, reportId: string, payloadHash: string): boolean;
};

export = BugReportContract;
