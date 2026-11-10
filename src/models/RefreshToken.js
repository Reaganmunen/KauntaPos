'use strict';

const BaseModel = require('./BaseModel');

/** Stores only the HASH of each refresh token. */
class RefreshToken extends BaseModel {
  static table = 'refresh_tokens';
  static columns = ['user_id', 'token_hash', 'user_agent', 'ip', 'expires_at', 'revoked_at'];

  static async findValid(db, tokenHash) {
    const { rows } = await db.query(
      `SELECT * FROM refresh_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
        LIMIT 1`,
      [tokenHash]
    );
    return rows[0] || null;
  }

  static async revoke(db, id) {
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
  }

  static async revokeAllForUser(db, userId) {
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  }

  static async deleteExpired(db) {
    const { rowCount } = await db.query('DELETE FROM refresh_tokens WHERE expires_at < now() - interval \'1 day\'');
    return rowCount;
  }
}

module.exports = RefreshToken;
