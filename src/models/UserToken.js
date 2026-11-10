'use strict';

const BaseModel = require('./BaseModel');

/** One-time tokens: password reset, email verification, staff invites (hash only). */
class UserToken extends BaseModel {
  static table = 'user_tokens';
  static columns = ['user_id', 'purpose', 'token_hash', 'expires_at', 'used_at'];

  static async findValid(db, tokenHash, purpose) {
    const { rows } = await db.query(
      `SELECT * FROM user_tokens
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        LIMIT 1`,
      [tokenHash, purpose]
    );
    return rows[0] || null;
  }

  static async markUsed(db, id) {
    const { rows } = await db.query(
      'UPDATE user_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING *',
      [id]
    );
    return rows[0] || null;
  }
}

module.exports = UserToken;
