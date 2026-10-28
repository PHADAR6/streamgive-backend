import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

interface SecuritySchemeObject {
  type?: string;
  name?: string;
  in?: string;
  description?: string;
}

interface OperationObject {
  tags?: string[];
  security?: unknown;
  parameters?: Array<{ in?: string; name: string }>;
}

describe('OpenAPI documentation', () => {
  it('reads the version dynamically from package.json', async () => {
    const app = buildServer();
    await app.ready();

    const spec = app.swagger();
    expect(spec.info?.version).toBe(packageJson.version);
    expect(spec.info?.version).not.toBe('1.0.0');

    await app.close();
  });

  it('declares the three admin apiKey security schemes in components', async () => {
    const app = buildServer();
    await app.ready();

    const spec = app.swagger();
    const schemes = spec.components?.securitySchemes as Record<string, SecuritySchemeObject> | undefined;
    expect(schemes).toBeDefined();

    expect(schemes?.adminAddress).toEqual({
      type: 'apiKey',
      name: 'x-admin-address',
      in: 'header',
      description: expect.any(String),
    });

    expect(schemes?.adminSignature).toEqual({
      type: 'apiKey',
      name: 'x-admin-signature',
      in: 'header',
      description: expect.any(String),
    });

    expect(schemes?.adminTimestamp).toEqual({
      type: 'apiKey',
      name: 'x-admin-timestamp',
      in: 'header',
      description: expect.any(String),
    });

    await app.close();
  });

  it('secures all admin routes with the admin authentication scheme', async () => {
    const app = buildServer();
    await app.ready();

    const spec = app.swagger();
    const expectedSecurity = [
      {
        adminAddress: [],
        adminSignature: [],
        adminTimestamp: [],
      },
    ];

    const adminEndpoints: Array<[string, 'get' | 'post' | 'patch']> = [
      ['/v1/ngo-applications/stats', 'get'],
      ['/v1/ngo-applications', 'get'],
      ['/v1/ngo-applications/{id}', 'get'],
      ['/v1/ngo-applications/{id}/approve', 'post'],
      ['/v1/ngo-applications/{id}/reject', 'post'],
      ['/v1/ngos/all', 'get'],
      ['/v1/admin/ngos/{id}', 'patch'],
    ];

    for (const [path, method] of adminEndpoints) {
      const operation = (spec.paths?.[path] as Record<string, OperationObject> | undefined)?.[method];
      expect(operation, `Expected operation ${method.toUpperCase()} ${path} to exist`).toBeDefined();
      expect(operation?.security).toEqual(expectedSecurity);
    }

    // Public routes must not declare admin security requirement
    expect(spec.paths?.['/v1/ngo-applications/challenge']?.post?.security).toBeUndefined();
    expect(spec.paths?.['/v1/ngo-applications']?.post?.security).toBeUndefined();
    expect(spec.paths?.['/v1/ngo-applications/status']?.get?.security).toBeUndefined();
    expect(spec.paths?.['/v1/ngos']?.get?.security).toBeUndefined();

    await app.close();
  });

  it('ensures all routes have tags defined', async () => {
    const app = buildServer();
    await app.ready();

    const spec = app.swagger();
    const paths = spec.paths ?? {};

    for (const [pathKey, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem as Record<string, OperationObject>)) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
          expect(
            operation.tags,
            `Expected route ${method.toUpperCase()} ${pathKey} to have tags`,
          ).toBeDefined();
          expect(
            operation.tags?.length,
            `Expected route ${method.toUpperCase()} ${pathKey} to have at least one tag`,
          ).toBeGreaterThan(0);
        }
      }
    }

    await app.close();
  });

  it('lists limit, cursor, sort, and q query parameters for /v1/ngos', async () => {
    const app = buildServer();
    await app.ready();

    const spec = app.swagger();
    const ngoGet = spec.paths?.['/v1/ngos']?.get;
    expect(ngoGet).toBeDefined();

    const queryParameters = (ngoGet?.parameters ?? []).filter(
      (param: { in?: string; name: string }) => param.in === 'query',
    );
    const parameterNames = queryParameters.map(
      (param: { in?: string; name: string }) => param.name,
    );

    expect(parameterNames).toContain('limit');
    expect(parameterNames).toContain('cursor');
    expect(parameterNames).toContain('sort');
    expect(parameterNames).toContain('q');

    await app.close();
  });

  it('documents the /v1/streams query parameters generated from the validation schema', async () => {
    const app = buildServer();
    await app.ready();

    const streamsGet = app.swagger().paths?.['/v1/streams']?.get;
    expect(streamsGet).toBeDefined();

    const names = (streamsGet?.parameters ?? [])
      .filter((param: { in?: string }) => param.in === 'query')
      .map((param: { name: string }) => param.name);

    expect(names).toEqual(
      expect.arrayContaining(['donor', 'ngo', 'ngoAddress', 'token', 'status', 'limit', 'cursor']),
    );

    await app.close();
  });
});
