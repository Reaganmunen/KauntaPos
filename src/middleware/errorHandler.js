'use strict';

const ApiError = require('../utils/ApiError');

const isProd = () => process.env.NODE_ENV === 'production';

// "Key (tenant_id, sku)=(...) already exists." -> ['sku']
function columnsFromDetail(detail) {
  const match = /Key \(([^)]+)\)=/.exec(detail || '');
  if (!match) return [];
  return match[1].split(',').map((c) => c.trim()).filter((c) => c !== 'tenant_id');
}

/** Turns a PostgreSQL error into a friendly ApiError, or null when it is a genuine bug. */
function fromPostgres(err) {
  switch (err.code) {
    case '23505': {
      const fields = columnsFromDetail(err.detail);
      const label = fields.map((f) => f.replace(/_/g, ' ')).join(' + ');
      return new ApiError(
        409,
        fields.length ? `Another record with the same ${label} already exists` : 'This record already exists',
        { fields },
        'duplicate'
      );
    }
    case '23503':
      if (/still referenced/i.test(err.detail || '')) {
        return new ApiError(409, 'This record is in use and cannot be removed. Deactivate it instead.', undefined, 'in_use');
      }
      return new ApiError(422, 'A linked record (such as a product, customer or branch) does not exist', undefined, 'invalid_reference');
    case '23502':
      return new ApiError(422, `${(err.column || 'A required field').replace(/_/g, ' ')} is required`, { field: err.column });
    case '23514':
      return new ApiError(422, 'One of the values is not allowed (for example a negative amount)');
    case '22P02':
    case '22007':
    case '22008':
      return new ApiError(400, 'One of the values has the wrong format', undefined, 'bad_format');
    case '22003':
      return new ApiError(422, 'A number is too large');
    case '22001':
      return new ApiError(422, 'A text value is too long');
    case '42501': // row-level security: touching another shop's data (or none selected)
      return new ApiError(403, 'You do not have access to that record');
    case '40001': // serialization failure
    case '40P01': // deadlock
      return new ApiError(503, 'The system was busy. Please try again.', undefined, 'retry');
    case '55P03': // lock not available
      return new ApiError(409, 'Someone else is changing this record right now. Try again.', undefined, 'locked');
    default:
      return null;
  }
}

const SERVICE_DOWN_MESSAGE = 'The service is temporarily unavailable. Please try again in a few minutes.';
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE']);
// 28xxx = invalid authorization (wrong DB password), 3D000 = database missing, 08xxx = connection failures,
// 53300 = too many connections, 57P0x = server shutting down or starting up
const DB_DOWN_CODES = new Set(['28P01', '28000', '3D000', '53300', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006']);

/** The database or network is unreachable or misconfigured. Never a person's mistake, never shown in detail. */
function isInfrastructureError(err) {
  if (DB_DOWN_CODES.has(err.code) || NETWORK_CODES.has(err.code)) return true;
  return /password authentication failed|no pg_hba\.conf entry|connection terminated|timeout exceeded when trying to connect|ECONNREFUSED|self.signed certificate|SSL/i.test(err.message || '');
}

function toApiError(err) {
  if (err instanceof ApiError) return err;

  // body-parser
  if (err.type === 'entity.parse.failed') return new ApiError(400, 'The request body is not valid JSON', undefined, 'bad_json');
  if (err.type === 'entity.too.large') return new ApiError(413, 'The request is too large', undefined, 'payload_too_large');

  // jsonwebtoken
  if (err.name === 'TokenExpiredError') return new ApiError(401, 'Your session has expired', undefined, 'token_expired');
  if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
    return new ApiError(401, 'Your session is not valid. Please log in again.', undefined, 'invalid_token');
  }

  if (isInfrastructureError(err)) return new ApiError(503, SERVICE_DOWN_MESSAGE, undefined, 'service_unavailable');

  // PostgreSQL SQLSTATE codes are 5 characters
  if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return fromPostgres(err);

  return null;
}

function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl.split('?')[0]}`, undefined, 'route_not_found'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let apiError = toApiError(err);
  const unexpected = !apiError;
  if (unexpected) {
    apiError = new ApiError(
      500,
      'Something went wrong on our side. Please try again.',
      undefined,
      'server_error'
    );
  }

  if (unexpected || apiError.status >= 500) {
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: 'error',
        id: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        tenant: req.tenantId || null,
        user: (req.user && req.user.id) || null,
        message: err.message,
        code: err.code,
        stack: isProd() ? undefined : err.stack,
      })
    );
  }

  if (apiError.status === 429 && apiError.retryAfter) res.setHeader('Retry-After', String(apiError.retryAfter));

  const body = {
    success: false,
    error: {
      message: apiError.message,
      code: apiError.code,
      request_id: req.id,
    },
  };
  if (apiError.details !== undefined) body.error.details = apiError.details;
  // Developer-only: set ERROR_DEBUG=true in .env to see the real message in the API response. Ignored in production.
  if (!isProd() && process.env.ERROR_DEBUG === 'true' && (unexpected || apiError.status >= 500)) body.error.debug = err.message;
  return res.status(apiError.status).json(body);
}

module.exports = { notFound, errorHandler };