import type { Tool, JsonSchemaType } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

/** Wire schemas have wider TS types than the SDK validator input. Compile them
 * at runtime: this assertion does not skip AJV's schema validation. */
export function compileToolSchema(validator: Pick<AjvJsonSchemaValidator, 'getValidator'>, schema: Tool['inputSchema'] | NonNullable<Tool['outputSchema']>) {
  return validator.getValidator(schema as JsonSchemaType);
}
