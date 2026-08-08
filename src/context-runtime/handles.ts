import { randomUUID } from "node:crypto";

/**
 * await/watch primitive（Issue #74）が使う opaque handle registry。
 *
 * handle は `HandleRegistry` インスタンス（= 1 MCP connection/session）にだけ属する。
 * 別 connection の `HandleRegistry` からは同じ id でも解決できない — persistent job id ではなく、
 * このプロセス・この connection の生存期間に閉じた参照。`dispose()` は connection/process
 * shutdown 時に呼び出し側が明示的に叩く（各エントリの `onDispose` を実行してから registry を空にする）。
 */
export class HandleRegistry<T> {
  private readonly entries = new Map<string, T>();
  private readonly disposers = new Map<string, (value: T) => void>();
  private readonly createId: () => string;

  constructor(options: { createId?: () => string } = {}) {
    this.createId = options.createId ?? randomUUID;
  }

  /** 新しい opaque handle を払い出し、値を登録する。id は衝突を避けるため呼び出し側が選べない。 */
  register(value: T, onDispose?: (value: T) => void): string {
    const id = `mh_${this.createId()}`;
    this.entries.set(id, value);
    if (onDispose !== undefined) this.disposers.set(id, onDispose);
    return id;
  }

  /** 未知の id / 他 connection の id は `undefined`（呼び出し側は invalid handle として扱う）。 */
  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  /** 該当エントリだけを個別に破棄する（await 完了後の handle 解放など）。 */
  delete(id: string): void {
    const value = this.entries.get(id);
    if (value === undefined) return;
    this.entries.delete(id);
    const dispose = this.disposers.get(id);
    this.disposers.delete(id);
    dispose?.(value);
  }

  /** connection/process shutdown 用。残存する全 handle を disposer 経由で片付けてから空にする。 */
  dispose(): void {
    for (const [id, value] of this.entries) {
      this.disposers.get(id)?.(value);
    }
    this.entries.clear();
    this.disposers.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
