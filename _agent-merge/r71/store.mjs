/* Verity AI家庭CFO · Cloudflare D1 适配存储
 *
 * 与 platform/adapters/node/server.mjs 里的 SqliteStore 是**同一套语义**：
 * 同样的方法、同样的归属隔离（每个读写都以 user_id 为唯一键）、同样的
 * 「先比 revision 再写」乐观并发。区别只有一个：D1 的绑定是异步的。
 *
 * 为什么不用 BEGIN/COMMIT：D1 的 Worker 绑定不提供跨 await 的交互式事务，
 * 硬写 BEGIN 只会得到「事务不生效」的假安全感。所以这里把「读—比—写」压成
 * **一条原子语句**：
 *   * 首次写入用 INSERT ... SELECT ... WHERE NOT EXISTS(...)；
 *   * 更新用 UPDATE ... WHERE user_id = ? AND revision = ?；
 * 然后只看 meta.changes 判断是否成功。零行改动 = 版本冲突，再从库里读当前版本号。
 * 这样即使在并发下也不需要事务，语义与 SqliteStore 的 BEGIN IMMEDIATE 完全一致。
 */

export class D1Store {
  constructor(db) {
    this.db = db;
  }

  static _row(result) {
    return (result && result.results && result.results[0]) || null;
  }

  async findUserByEmailNorm(emailNorm) {
    return (await this.db.prepare("SELECT * FROM users WHERE email_norm = ?").bind(emailNorm).first()) || null;
  }

  async getUserById(id) {
    return (await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first()) || null;
  }

  async createUser(row) {
    await this.db
      .prepare(
        `INSERT INTO users (id, email, email_norm, display_name, display_name_iv, password_hash, password_salt, password_iter,
                            kdf_salt, dek_wrapped, dek_iv, dek_version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        row.id,
        row.email,
        row.email_norm,
        row.display_name,
        row.display_name_iv,
        row.password_hash,
        row.password_salt,
        row.password_iter,
        row.kdf_salt,
        row.dek_wrapped,
        row.dek_iv,
        row.dek_version,
        row.created_at,
        row.updated_at
      )
      .run();
  }

  async createSession(row) {
    await this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)")
      .bind(row.tokenHash, row.userId, row.createdAt, row.expiresAt, row.lastSeenAt)
      .run();
  }

  async getSession(tokenHash) {
    return (await this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").bind(tokenHash).first()) || null;
  }

  async touchSession(tokenHash, at) {
    await this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(at, tokenHash).run();
  }

  async deleteSession(tokenHash) {
    await this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }

  /* 口令重置后吊销该账号的全部会话（新会话在调用之后才创建）。 */
  async deleteSessionsForUser(userId) {
    await this.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  }

  async getRecord(userId) {
    return (await this.db.prepare("SELECT * FROM household_records WHERE user_id = ?").bind(userId).first()) || null;
  }

  async putRecord(input) {
    const { userId, payload, payloadIv, expectedRevision, now } = input;
    const conflict = async () => {
      const existing = await this.db
        .prepare("SELECT revision FROM household_records WHERE user_id = ?")
        .bind(userId)
        .first();
      const err = new Error("conflict");
      err.code = "conflict";
      err.currentRevision = existing ? existing.revision : 0;
      return err;
    };

    if (expectedRevision === 0) {
      /* 首次写入：只有「确实还没有记录」时才插入，一条语句内完成判断与写入。 */
      const res = await this.db
        .prepare(
          `INSERT INTO household_records (user_id, payload, payload_iv, payload_tag, revision, created_at, updated_at)
           SELECT ?, ?, ?, ?, 1, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM household_records WHERE user_id = ?)`
        )
        .bind(userId, payload, payloadIv, "", now, now, userId)
        .run();
      if (res && res.meta && res.meta.changes > 0) return { revision: 1, updated_at: now };
      throw await conflict();
    }

    const res = await this.db
      .prepare(
        `UPDATE household_records
            SET payload = ?, payload_iv = ?, revision = ?, updated_at = ?
          WHERE user_id = ? AND revision = ?`
      )
      .bind(payload, payloadIv, expectedRevision + 1, now, userId, expectedRevision)
      .run();
    if (res && res.meta && res.meta.changes > 0) {
      return { revision: expectedRevision + 1, updated_at: now };
    }
    throw await conflict();
  }

  async deleteRecord(userId, expectedRevision) {
    const result = await this.db
      .prepare("DELETE FROM household_records WHERE user_id = ? AND revision = ?")
      .bind(userId, expectedRevision)
      .run();
    if (result && result.meta && result.meta.changes > 0) return;
    const existing = await this.db.prepare("SELECT revision FROM household_records WHERE user_id = ?").bind(userId).first();
    if (!existing && expectedRevision === 0) return;
    const err = new Error("conflict");
    err.code = "conflict";
    err.currentRevision = existing ? existing.revision : 0;
    throw err;
  }

  /* r71 · 找回口令（忘记密码）：
   * 恢复材料全部由端侧生成，服务端只做「照存 + 等值校验」，任何一步都拿不到明文口令或明文档案。
   * 恢复码本身永不落库，只落 sha256 摘要，因此库被读走也无法用来重置任何账号。 */
  async setRecovery(userId, material, now) {
    await this.db
      .prepare(
        "UPDATE users SET recovery_salt = ?, recovery_wrap = ?, recovery_verifier = ?, recovery_iter = ?, updated_at = ? WHERE id = ?"
      )
      .bind(
        material.recovery_salt,
        material.recovery_wrap,
        material.recovery_verifier,
        material.recovery_iter,
        now,
        userId
      )
      .run();
  }

  /* 重置口令：只改「服务端能校验的那一半」（口令散列 + 盐 + 端侧派生盐）与新的恢复材料。
     家庭档案正文仍是端侧密文，服务端既不解密也不重写，因此重置口令不会丢数据。 */
  async updatePassword(userId, input, now) {
    await this.db
      .prepare(
        `UPDATE users
            SET password_hash = ?, password_salt = ?, password_iter = ?, kdf_salt = ?,
                recovery_salt = ?, recovery_wrap = ?, recovery_verifier = ?, recovery_iter = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .bind(
        input.password_hash,
        input.password_salt,
        input.password_iter,
        input.kdf_salt,
        input.recovery_salt,
        input.recovery_wrap,
        input.recovery_verifier,
        input.recovery_iter,
        now,
        userId
      )
      .run();
  }

  async appendAudit(userId, at, action, detail) {
    await this.db
      .prepare("INSERT INTO audit_log (user_id, at, action, detail) VALUES (?,?,?,?)")
      .bind(userId, at, action, detail)
      .run();
  }

  async listAudit(userId, limit) {
    const res = await this.db
      .prepare("SELECT at, action, detail FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .bind(userId, limit)
      .all();
    return (res && res.results) || [];
  }

  async getLoginFailure(emailNorm) {
    return (await this.db.prepare("SELECT * FROM login_failures WHERE email_norm = ?").bind(emailNorm).first()) || null;
  }

  async bumpLoginFailure(emailNorm, at, lockMs, maxFailures) {
    const nowMs = Date.parse(at);
    const row = await this.getLoginFailure(emailNorm);
    let count = 1;
    let firstFail = at;
    if (row && nowMs - Date.parse(row.first_fail_at) <= lockMs) {
      count = row.fail_count + 1;
      firstFail = row.first_fail_at;
    }
    const lockedUntil = count >= maxFailures ? new Date(nowMs + lockMs).toISOString() : null;
    await this.db
      .prepare(
        `INSERT INTO login_failures (email_norm, fail_count, first_fail_at, last_fail_at, locked_until)
         VALUES (?,?,?,?,?)
         ON CONFLICT(email_norm) DO UPDATE SET fail_count = excluded.fail_count,
           first_fail_at = excluded.first_fail_at, last_fail_at = excluded.last_fail_at,
           locked_until = excluded.locked_until`
      )
      .bind(emailNorm, count, firstFail, at, lockedUntil)
      .run();
    return { fail_count: count, locked_until: lockedUntil };
  }

  async resetLoginFailure(emailNorm) {
    await this.db.prepare("DELETE FROM login_failures WHERE email_norm = ?").bind(emailNorm).run();
  }
}
