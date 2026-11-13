// JSON Schema validation (ajv, draft 2020-12). Host and tests only: ajv compiles with
// `new Function`, which the webview CSP forbids (ADR-0001).
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import schema from '../../../schema/flow.schema.json';
import { keywordProblem } from './keywords';

export interface SchemaIssue {
  /** JSON pointer into the document, e.g. `/nodes/3/type`. */
  pointer: string;
  message: string;
  /** A finding code more precise than `schema` (AFD-26: task keywords). */
  code?: string;
}

export type SchemaValidator = (data: unknown) => SchemaIssue[];

/**
 * Compiles on first use: compiling takes ~150 ms, and the extension also starts in windows without
 * flows (AFD-20), where nothing is validated.
 */
export function createSchemaValidator(): SchemaValidator {
  let validate: ValidateFunction | undefined;
  return (data) => {
    validate ??= new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    if (validate(data)) return [];
    // AFD-160: the validator reports a bad input or output name (bad-name) in its own words; the
    // schema's rule is for editors that read the schema alone.
    return (validate.errors ?? []).filter((e) => !namesRule(e)).map(toIssue);
  };
}

const namesRule = (e: ErrorObject) => e.schemaPath.startsWith('#/$defs/contract/propertyNames');

function toIssue(e: ErrorObject): SchemaIssue {
  const params = e.params as Record<string, unknown>;
  let message = e.message ?? 'invalid';
  if (e.keyword === 'additionalProperties') {
    const key = String(params.additionalProperty);
    // A task keyword the flow models itself names its place (AFD-26).
    if (/\/(impl|undo)\/keywords$/.test(e.instancePath))
      return {
        pointer: `${e.instancePath}/${key}`,
        message: keywordProblem(key) ?? `unknown keyword "${key}"`,
        code: 'keyword-reserved',
      };
    message = `unknown field "${key}"`;
  }
  if (e.keyword === 'enum')
    message = `must be one of: ${(params.allowedValues as unknown[]).join(', ')}`;
  return { pointer: e.instancePath || '/', message };
}
