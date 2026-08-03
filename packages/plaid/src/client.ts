import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

export type PlaidEnvName = 'sandbox' | 'production';

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: PlaidEnvName;
}

export function loadPlaidConfig(): PlaidConfig {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = (process.env.PLAID_ENV ?? 'sandbox') as PlaidEnvName;

  if (!clientId || !secret) {
    throw new Error(
      'PLAID_CLIENT_ID and PLAID_SECRET must be set. Copy .env.example to .env and fill them in.',
    );
  }
  if (!(env in PlaidEnvironments)) {
    throw new Error(`PLAID_ENV must be one of ${Object.keys(PlaidEnvironments).join(', ')}.`);
  }
  return { clientId, secret, env };
}

export function createPlaidClient(config: PlaidConfig = loadPlaidConfig()): PlaidApi {
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[config.env],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': config.clientId,
          'PLAID-SECRET': config.secret,
        },
      },
    }),
  );
}

export interface PlaidErrorShape {
  error_code?: string;
  error_type?: string;
  error_message?: string;
  display_message?: string;
}

/**
 * Plaid errors arrive as Axios errors with the useful part buried in
 * `response.data`. Pull it out so callers can branch on `error_code` instead of
 * string-matching a stack trace.
 */
export function asPlaidError(error: unknown): PlaidErrorShape | null {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object' && 'error_code' in data) {
    return data as PlaidErrorShape;
  }
  return null;
}

export function describePlaidError(error: unknown): { message: string; code?: string } {
  const plaid = asPlaidError(error);
  if (plaid) {
    return {
      message: plaid.display_message ?? plaid.error_message ?? plaid.error_code ?? 'Plaid error',
      ...(plaid.error_code ? { code: plaid.error_code } : {}),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
