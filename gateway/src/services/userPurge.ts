// E:\api中转站\meow-gateway\gateway\src\services\userPurge.ts
// F.1.7 销账核心 helper
// 路线 A: 销账留账本 —— 删 Users 行 + 名下 Tokens + 名下分组授权 + Redis 缓存清理;
// Bills/Logs 保留(财务孤儿记录合法,user_id 成为悬空引用是有意为之喵)。
//
// 调用方:
//   - routes/user.ts  DELETE /api/v1/user/account   (自助注销, 调用前已 bcrypt 二次验密码)
//   - routes/admin.ts DELETE /api/v1/admin/users/:id (超管删除)
//
// 设计:
//   - MySQL 改动全部在事务内,要么全成要么全回滚,绝不留半成品账号
//   - Redis 清理在事务外,失败只记日志不抛错(MySQL 已 commit, 让上层以为失败反而是更糟的状态)
//   - 不清 ratelimit key(TTL 60s 自然过期, 扫 key 不划算)

import { pool } from '../db';
import { redis } from '../redis';

export interface PurgeResult {
  deletedTokens: number;       // 顺手销毁了几把召唤铃, 上层打日志用
  deletedGrants: number;       // 顺手清掉了几条分组授权
}

/**
 * 销账:把这只猫从店里抹掉,但账本(Bills/Logs)留着。
 * @param userId 要销账的用户 ID
 * @returns 销账过程中清理的从属数据计数
 * @throws 若 user 不存在或事务失败, 抛错(由上层捕获并回 4xx/5xx)
 */
export async function purgeUser(userId: number): Promise<PurgeResult> {
  const connection = await pool.getConnection();
  let tokenStrings: string[] = [];
  let deletedGrants = 0;

  try {
    await connection.beginTransaction();

    // ① 先捞名下所有 sk-meow-xxx 字符串(事务外清 Redis token:info 用)
    const [tokenRows]: any = await connection.query(
      'SELECT token FROM Tokens WHERE user_id = ?',
      [userId]
    );
    tokenStrings = tokenRows.map((r: any) => r.token);

    // ② 删 Tokens (名下召唤铃全收走)
    await connection.query('DELETE FROM Tokens WHERE user_id = ?', [userId]);

    // ③ 删 ModelGroupGrants (顺手清, 免孤儿外键)
    const [grantRes]: any = await connection.query(
      'DELETE FROM ModelGroupGrants WHERE user_id = ?',
      [userId]
    );
    deletedGrants = grantRes.affectedRows || 0;

    // ④ 删 Users 主行 (用 affectedRows 判定存在性, 防"删了个不存在的用户却返回成功"的尴尬)
    const [userRes]: any = await connection.query(
      'DELETE FROM Users WHERE id = ?',
      [userId]
    );
    if (userRes.affectedRows === 0) {
      await connection.rollback();
      throw new Error(`USER_NOT_FOUND:${userId}`);
    }

    await connection.commit();
  } catch (txError) {
    try { await connection.rollback(); } catch { /* 二次保险, 已回滚就不再抛 */ }
    throw txError;
  } finally {
    connection.release();
  }

  // ⑤ Redis 清理 —— 事务外, 失败只记日志不抛错
  //    MySQL 已 commit, 孤儿缓存最多让人多一次 miss + 自愈, 不致命
  try {
    await redis.del(`gateway:user:balance:${userId}`);
    await redis.del(`gateway:user:used:${userId}`);

    // 名下每把召唤铃的鉴权缓存挨个清
    for (const tok of tokenStrings) {
      await redis.del(`gateway:token:info:${tok}`);
    }
  } catch (redisErr: any) {
    console.error(
      `[USER-PURGE][Redis清理失败] userId: ${userId}, 已 commit 的 MySQL 不回滚, 留缓存孤儿待自愈喵: ${redisErr.message || redisErr}`
    );
  }

  console.info(
    `[USER-PURGE] userId: ${userId} 销账完成, 顺手清掉 ${tokenStrings.length} 把召唤铃 + ${deletedGrants} 条分组授权 (Bills/Logs 已留底)`
  );

  return {
    deletedTokens: tokenStrings.length,
    deletedGrants,
  };
}
