'use strict';

const DEFAULT_CODES = {
  400: 'bad_request',
  401: 'unauthorized',
  402: 'payment_required',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'validation_error',
  429: 'rate_limited',
};

/**
 * Error with an HTTP status. The error middleware turns it into
 * { success: false, error: { message, code, details, request_id } }.
 * `code` is a stable machine-readable string the frontend can switch on
 * (e.g. 'token_expired', 'subscription_inactive', 'feature_disabled').
 */
class ApiError extends Error {
  constructor(status, message, details, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code || DEFAULT_CODES[status] || 'error';
    this.isOperational = true;
  }

  static badRequest(message = 'Bad request', details, code) {
    return new ApiError(400, message, details, code);
  }

  static unauthorized(message = 'Authentication required', details, code) {
    return new ApiError(401, message, details, code);
  }

  static forbidden(message = 'You do not have permission to do that', details, code) {
    return new ApiError(403, message, details, code);
  }

  static notFound(message = 'Not found', details, code) {
    return new ApiError(404, message, details, code);
  }

  static conflict(message = 'Conflict', details, code) {
    return new ApiError(409, message, details, code);
  }

  static unprocessable(message = 'Invalid data', details, code) {
    return new ApiError(422, message, details, code);
  }
}

module.exports = ApiError;
