/**
 * CORS utilities for Cloudflare Worker
 */

import { Env } from './types';

const DEFAULT_ALLOWED_METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS'];
const DEFAULT_ALLOWED_HEADERS = ['Content-Type', 'Authorization'];
const DEFAULT_EXPOSED_HEADERS = ['ETag', 'Content-Type'];
const DEFAULT_MAX_AGE = '86400'; // 24 hours

/**
 * Get allowed origins from environment or default to wildcard in development
 */
function getAllowedOrigins(env: Env): string[] {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim());
  }
  // Default to wildcard for development
  return ['*'];
}

/**
 * Check if origin is allowed
 */
function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.includes(origin);
}

/**
 * Get CORS headers for a request
 */
export function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowedOrigins = getAllowedOrigins(env);
  
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': DEFAULT_ALLOWED_METHODS.join(', '),
    'Access-Control-Allow-Headers': DEFAULT_ALLOWED_HEADERS.join(', '),
    'Access-Control-Expose-Headers': DEFAULT_EXPOSED_HEADERS.join(', '),
    'Access-Control-Max-Age': DEFAULT_MAX_AGE,
  };

  if (isOriginAllowed(origin, allowedOrigins)) {
    // Use specific origin if provided and allowed, otherwise use wildcard
    headers['Access-Control-Allow-Origin'] = allowedOrigins.includes('*') ? '*' : origin!;
    
    // Only include credentials if not using wildcard
    if (!allowedOrigins.includes('*')) {
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers['Vary'] = 'Origin';
    }
  } else if (allowedOrigins.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  return headers;
}

/**
 * Handle OPTIONS preflight request
 */
export function handleCorsPreFlight(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request, env),
  });
}

/**
 * Add CORS headers to an existing response
 */
export function addCorsHeaders(response: Response, request: Request, env: Env): Response {
  const corsHeaders = getCorsHeaders(request, env);
  const newResponse = new Response(response.body, response);
  
  Object.entries(corsHeaders).forEach(([key, value]) => {
    newResponse.headers.set(key, value);
  });

  return newResponse;
}
