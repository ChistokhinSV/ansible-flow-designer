// JSON Schema validation (ajv, draft 2020-12). Host and tests only: ajv compiles with
// `new Function`, which the webview CSP forbids (ADR-0001).
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import schema from '../../../schema/flow.schema.json';

export interface SchemaIssue {
  /** JSON pointer into the document, e.g. `/nodes/3/type`. */
  pointer: string;
  message: string;
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
    return (validate.errors ?? []).map(toIssue);
  };
}

function toIssue(e: ErrorObject): SchemaIssue {
  const params = e.params as Record<string, unknown>;
  let message = e.message ?? 'invalid';
  if (e.keyword === 'additionalProperties')
    message = `unknown field "${params.additionalProperty}"`;
  if (e.keyword === 'enum')
    message = `must be one of: ${(params.allowedValues as unknown[]).join(', ')}`;
  return { pointer: e.instancePath || '/', message };
}
