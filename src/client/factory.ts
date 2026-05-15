/**
 * Make.com HTTP client factory.
 *
 * One factory, one surface — there's no "local vs cloud" split for Make.
 * The zone is encoded in `creds.baseUrl` and the token in `creds.apiKey`.
 */

import { HttpClient } from './http.js';
import type { MakeCreds } from '../tenant/context.js';

export interface MakeClientOptions {
  onWarn?: (msg: string) => void;
}

export function createMakeClient(creds: MakeCreds, opts: MakeClientOptions = {}): HttpClient {
  return new HttpClient({
    baseUrl: creds.baseUrl,
    pathPrefix: '',
    apiKey: creds.apiKey,
    label: 'make',
    ...(opts.onWarn ? { onWarn: opts.onWarn } : {}),
  });
}
