import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { PUBLISHED_PATH, readYaml } from '../../scripts/contract/generate';

const CONTRACT_ID = 'https://hakoremfarms.com/contract/openapi.yaml';

let ajv: Ajv2020 | undefined;

/**
 * A validator for a schema in the committed contract. OpenAPI 3.1 schemas are JSON Schema 2020-12; the OpenAPI
 * keywords around them (examples, extensions) are not validation keywords, so strict mode is off.
 */
export function contractSchema(name: string): ValidateFunction {
  if (ajv === undefined) {
    ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const document = readYaml(PUBLISHED_PATH);
    ajv.addSchema({ $id: CONTRACT_ID, components: document['components'] });
  }
  const validate = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (validate === undefined) {
    throw new Error(`the contract has no schema ${name}`);
  }
  return validate;
}
