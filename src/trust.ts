// 票作者可不可信：作者没有写权限的票，Sandcastle 不 prep、不开工，打 needs-triage 等有写权限的人确认（打 trusted）。
// 判定顺序：机器人 → 白名单（trustedAuthors）→ 仓库权限是 admin / write。查权限按登录名缓存 1 小时。
// 机器人可信：只有仓库管理员装过的 App 才能在本仓库开票；PAT 开的票作者是 token 的主人，本来就有写权限。
// 用权限接口而不是 authorAssociation：只读协作者也算 COLLABORATOR，没公开身份的组织成员会显示成 CONTRIBUTOR（#64）。
// Whether a ticket's author is trusted: Sandcastle doesn't prep or start tickets whose author lacks write access; it labels them needs-triage and waits for a maintainer to confirm (label trusted).
// Order: bot → allow-list (trustedAuthors) → repo permission is admin / write. Permission lookups are cached per login for an hour.
// Bots are trusted: only an App installed by a repo admin can open issues here; a PAT's tickets are authored by the token's owner, who already has write access.
// The permission API rather than authorAssociation: read-only collaborators also show as COLLABORATOR, and org members with private membership show as CONTRIBUTOR (#64).

export type Author = { login: string; bot: boolean };

const TTL_MS = 60 * 60 * 1000;
const TRUSTED_PERMISSIONS = ["admin", "write"];

/** 查权限的错误是不是 404（用户不存在等），这种算 none。 / Whether a permission lookup error is a 404 (e.g. no such user); that counts as none. */
const isNotFound = (e: unknown) => /HTTP 404|Not Found/.test(String((e as { stderr?: unknown }).stderr || (e as Error).message || e));

/**
 * 返回判定作者可不可信的函数。permission 返回 admin / write / read / none，404 时抛错；其他错误照旧抛出，不缓存。
 * Returns a function telling whether an author is trusted. permission returns admin / write / read / none and throws on 404; other errors are rethrown and not cached.
 */
export function createTrust(deps: {
  permission(login: string): string;
  trustedAuthors: readonly string[];
  now?: () => number;
}): (a: Author) => boolean {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; permission: string }>();
  const permissionOf = (login: string) => {
    const hit = cache.get(login);
    if (hit && now() - hit.at < TTL_MS) return hit.permission;
    let permission: string;
    try {
      permission = deps.permission(login);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      permission = "none";
    }
    cache.set(login, { at: now(), permission });
    return permission;
  };
  return (a) => a.bot || deps.trustedAuthors.includes(a.login) || TRUSTED_PERMISSIONS.includes(permissionOf(a.login));
}

/**
 * 这张票要不要挡住：带 trusted 标签的不查作者；否则作者不可信就挡。isTrusted 出错照旧抛出。
 * Whether to hold this ticket: tickets labelled trusted skip the author check; otherwise hold when the author isn't trusted. Errors from isTrusted propagate.
 */
export const needsHold = (issue: { labels: readonly string[]; author: Author }, trustedLabel: string, isTrusted: (a: Author) => boolean) =>
  !issue.labels.includes(trustedLabel) && !isTrusted(issue.author);
