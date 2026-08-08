// @ts-nocheck
// 测试替身：用 Node 22 内置的 node:sqlite 模拟 better-sqlite3 的公开 API 子集。
// 原因：项目依赖的 better-sqlite3 原生二进制是按 Electron 的 ABI 预编译的，
// 在受管 Node 下加载会报 NODE_MODULE_VERSION 不匹配。node:sqlite 同样是真正的
// SQLite 引擎，能真实执行 db.ts 的建表/迁移/参数化查询，只是换了绑定实现。
import { DatabaseSync } from "node:sqlite";

class Statement {
  constructor(private stmt: any) {}
  all(...params: any[]): any[] {
    return this.stmt.all(...params);
  }
  get(...params: any[]): any {
    return this.stmt.get(...params);
  }
  run(...params: any[]): any {
    return this.stmt.run(...params);
  }
}

export default class Database {
  private db: any;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
  }
  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }
  exec(sql: string): void {
    this.db.exec(sql as any);
  }
  // better-sqlite3 的 pragma("journal_mode = WAL") 与 PRAGMA table_info(x)。
  // node:sqlite 没有同名便捷方法，这里统一转成 PRAGMA 语句执行。
  pragma(name: string, _opts?: unknown): any {
    return this.db.prepare("PRAGMA " + name).all();
  }
}
