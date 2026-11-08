// Text for the XML of an export (AFD-158): any value as a string, without the control characters
// XML 1.0 forbids even as character references. A task name with a terminal colour code, or a
// title that is a number in a broken flow, made a .drawio or .svg that would not open.

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

export const xmlClean = (value: unknown): string => String(value ?? '').replaceAll(FORBIDDEN, '');
