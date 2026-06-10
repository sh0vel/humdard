import { verifyToken } from '@clerk/backend';
import { Env } from './types';

export async function requireAuth(
  request: Request,
  env: Env
): Promise<{ userId: string } | Response> {
  if (!env.CLERK_SECRET_KEY) {
    return authError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured');
  }

  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) {
    return authError(401, 'UNAUTHORIZED', 'Authorization header required');
  }

  try {
    const payload = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    return { userId: payload.sub };
  } catch {
    return authError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }
}

function authError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
