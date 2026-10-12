import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse } from 'yaml';

/** Un problema de validacion, con la forma de ProblemDetails.errors[] en openapi.yaml. */
export interface FieldError {
  field?: string;
  code: string;
  message: string;
}

export interface OperationInfo {
  operationId: string;
  method: string;
  path: string;
  /** true si el contrato no exige bearer (security: [] o autenticacion opcional). */
  public: boolean;
}

export interface RequestParts {
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}

type Json = Record<string, unknown>;

interface Parameter {
  name: string;
  in: 'query' | 'path' | 'header';
  required?: boolean;
  schema?: Json;
}

interface Operation extends OperationInfo {
  definition: Json;
  parameters: Parameter[];
}

const DOCUMENT_ID = 'openapi';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const DEFAULT_FILE = fileURLToPath(new URL('../../../contract/openapi.yaml', import.meta.url));

// ajv-formats es CommonJS: segun el cargador, el plugin llega como modulo o como su export por defecto.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as (ajv: Ajv2020) => void;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** "/events/0/name" -> "events[0].name". */
const fieldPath = (pointer: string, extra?: string): string | undefined => {
  const parts = pointer.split('/').filter((part) => part !== '');
  if (extra !== undefined) parts.push(extra);
  if (parts.length === 0) return undefined;
  return parts
    .map((part, index) => (/^\d+$/.test(part) ? `[${part}]` : index === 0 ? part : `.${part}`))
    .join('');
};

const toFieldError = (error: ErrorObject): FieldError => {
  const missing =
    error.keyword === 'required'
      ? (error.params as { missingProperty?: string }).missingProperty
      : undefined;
  return {
    field: fieldPath(error.instancePath, missing),
    code: error.keyword,
    message: error.message ?? 'Valor invalido',
  };
};

/**
 * contract/openapi.yaml como fuente ejecutable: la API valida sus peticiones con los mismos esquemas
 * que publica, y las pruebas de contrato validan sus respuestas contra ellos (ADR-007).
 */
export class Contract {
  private readonly operations = new Map<string, Operation>();
  private readonly ajv: Ajv2020;
  /** Los parametros de consulta, ruta y cabecera llegan como texto: se convierten al tipo declarado. */
  private readonly coercingAjv: Ajv2020;
  private readonly compiled = new Map<object, ValidateFunction>();

  private constructor(private readonly document: Json) {
    const options = { strict: false, allErrors: true, validateSchema: false } as const;
    this.ajv = new Ajv2020(options);
    this.coercingAjv = new Ajv2020({ ...options, coerceTypes: true });
    for (const ajv of [this.ajv, this.coercingAjv]) {
      addFormats(ajv);
      ajv.addSchema(document, DOCUMENT_ID);
    }

    for (const [path, item] of Object.entries((document.paths ?? {}) as Record<string, Json>)) {
      const shared = (item.parameters ?? []) as Json[];
      for (const method of METHODS) {
        const definition = item[method];
        if (!isObject(definition) || typeof definition.operationId !== 'string') continue;
        const security = definition.security as unknown[] | undefined;
        const isPublic =
          Array.isArray(security) &&
          (security.length === 0 ||
            security.some((entry) => isObject(entry) && Object.keys(entry).length === 0));
        this.operations.set(definition.operationId, {
          operationId: definition.operationId,
          method,
          path,
          public: isPublic,
          definition,
          parameters: [...shared, ...((definition.parameters ?? []) as Json[])].map(
            (parameter) => this.resolve(parameter) as unknown as Parameter,
          ),
        });
      }
    }
  }

  static load(file: string = DEFAULT_FILE): Contract {
    return new Contract(parse(readFileSync(file, 'utf8')) as Json);
  }

  operation(operationId: string): OperationInfo {
    const { method, path, public: isPublic } = this.find(operationId);
    return { operationId, method, path, public: isPublic };
  }

  /** true si el contrato exige la cabecera Idempotency-Key en esa operacion. */
  requiresIdempotencyKey(operationId: string): boolean {
    return this.find(operationId).parameters.some(
      (parameter) =>
        parameter.in === 'header' &&
        parameter.name.toLowerCase() === 'idempotency-key' &&
        parameter.required === true,
    );
  }

  validateRequest(operationId: string, parts: RequestParts): FieldError[] {
    const operation = this.find(operationId);
    const errors: FieldError[] = [];

    for (const location of ['path', 'query', 'header'] as const) {
      const parameters = operation.parameters.filter((parameter) => parameter.in === location);
      if (parameters.length === 0) continue;
      const source =
        (location === 'path' ? parts.params : location === 'query' ? parts.query : parts.headers) ??
        {};
      // Las cabeceras llegan en minusculas; el contrato las declara con su nombre canonico.
      const values = Object.fromEntries(
        parameters
          .map((parameter) => [
            parameter.name,
            source[location === 'header' ? parameter.name.toLowerCase() : parameter.name],
          ])
          .filter(([, value]) => value !== undefined),
      );
      const schema = {
        type: 'object',
        properties: Object.fromEntries(
          parameters.map((parameter) => [parameter.name, parameter.schema ?? {}]),
        ),
        required: parameters
          .filter((parameter) => parameter.required)
          .map((parameter) => parameter.name),
      };
      errors.push(...this.validate(parameters, schema, values, this.coercingAjv));
    }

    const requestBody = operation.definition.requestBody
      ? this.resolve(operation.definition.requestBody as Json)
      : undefined;
    if (requestBody) {
      const schema = (requestBody.content as Record<string, Json> | undefined)?.['application/json']
        ?.schema as Json | undefined;
      if (parts.body === undefined || parts.body === null) {
        if (requestBody.required) {
          errors.push({ code: 'required', message: 'La peticion necesita un cuerpo JSON' });
        }
      } else if (schema) {
        errors.push(...this.validate(schema, schema, parts.body, this.ajv));
        if (errors.length === 0) {
          errors.push(...this.unknownProperties([schema], parts.body, ''));
        }
      }
    }
    return errors;
  }

  validateResponse(operationId: string, status: number, body: unknown): FieldError[] {
    const operation = this.find(operationId);
    const declared = (operation.definition.responses as Record<string, Json> | undefined)?.[
      String(status)
    ];
    if (!declared) {
      return [
        {
          code: 'undeclaredStatus',
          message: `El contrato no declara el estado ${status} para ${operationId}`,
        },
      ];
    }
    const content = this.resolve(declared).content as Record<string, Json> | undefined;
    const schema = (content?.['application/json'] ?? content?.['application/problem+json'])
      ?.schema as Json | undefined;
    if (!schema) {
      const empty = body === undefined || body === null || body === '';
      return empty
        ? []
        : [
            {
              code: 'unexpectedBody',
              message: `El contrato no declara cuerpo para el estado ${status}`,
            },
          ];
    }
    return this.validate(schema, schema, body, this.ajv);
  }

  private find(operationId: string): Operation {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`La operacion "${operationId}" no existe en el contrato`);
    }
    return operation;
  }

  /** Sigue un $ref local ("#/components/...") dentro del documento. */
  private resolve(node: Json): Json {
    let current = node;
    while (typeof current.$ref === 'string') {
      const pointer = current.$ref.replace(/^#\//, '').split('/');
      let target: unknown = this.document;
      for (const part of pointer) {
        target = isObject(target)
          ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')]
          : undefined;
      }
      if (!isObject(target)) {
        throw new Error(`Referencia rota en el contrato: ${current.$ref}`);
      }
      current = target;
    }
    return current;
  }

  private validate(cacheKey: object, schema: Json, data: unknown, ajv: Ajv2020): FieldError[] {
    let validator = this.compiled.get(cacheKey);
    if (!validator) {
      // Los $ref locales del fragmento se reescriben para que apunten al documento registrado en Ajv.
      const rewritten = JSON.parse(
        JSON.stringify(schema).replace(/"\$ref":"#\//g, `"$ref":"${DOCUMENT_ID}#/`),
      ) as Json;
      validator = ajv.compile(rewritten);
      this.compiled.set(cacheKey, validator);
    }
    return validator(data) ? [] : (validator.errors ?? []).map(toFieldError);
  }

  /**
   * Propiedades que el contrato no define (06_SECURITY_PRIVACY.md seccion 5). Se comprueba aparte
   * porque los esquemas no declaran additionalProperties: false, que romperia las composiciones allOf.
   */
  private unknownProperties(candidates: Json[], data: unknown, path: string): FieldError[] {
    const schemas = candidates.flatMap((candidate) => this.flatten(candidate));

    if (Array.isArray(data)) {
      const items = schemas.map((schema) => schema.items).filter(isObject);
      return items.length === 0
        ? []
        : data.flatMap((element, index) =>
            this.unknownProperties(items, element, `${path}[${index}]`),
          );
    }
    if (!isObject(data)) return [];

    const known = new Map<string, Json[]>();
    let open = false;
    for (const schema of schemas) {
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
        open = true;
      for (const [name, property] of Object.entries(
        (schema.properties ?? {}) as Record<string, Json>,
      )) {
        known.set(name, [...(known.get(name) ?? []), property]);
      }
    }
    // Un esquema que no describe ninguna propiedad acepta cualquier objeto.
    if (known.size === 0) open = true;

    return Object.entries(data).flatMap(([name, value]) => {
      const child = path === '' ? name : `${path}.${name}`;
      const property = known.get(name);
      if (property) return this.unknownProperties(property, value, child);
      return open
        ? []
        : [
            {
              field: child,
              code: 'additionalProperties',
              message: 'Propiedad no definida en el contrato',
            },
          ];
    });
  }

  /** Un esquema con sus ramas allOf/oneOf/anyOf resueltas, como lista plana. */
  private flatten(schema: Json): Json[] {
    const resolved = this.resolve(schema);
    const branches = ['allOf', 'oneOf', 'anyOf'].flatMap((keyword) =>
      Array.isArray(resolved[keyword]) ? (resolved[keyword] as Json[]) : [],
    );
    return [resolved, ...branches.filter(isObject).flatMap((branch) => this.flatten(branch))];
  }
}
