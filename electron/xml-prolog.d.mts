/** Outcome of `xmlRoot`: the root element name, an unsafe DOCTYPE (entity declarations), or no XML root at all. */
export type XmlRoot = { root: string } | { unsafe: true } | null;
/** Root element of an XML text after its prolog (declaration, processing instructions, comments, DOCTYPE); nothing is expanded. */
export function xmlRoot(text: string): XmlRoot;
