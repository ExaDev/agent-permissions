/**
 * Git remote normalisation, so a `when.remote` pattern compares the same repository whichever way its URL is written.
 */

/**
 * Reduce a git remote to `host/path`, lower case, without scheme, credentials, port, trailing slash or `.git` suffix: `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both become `github.com/org/repo`. A local path keeps its leading slash. Already-normalised input is returned unchanged.
 *
 * Credentials are dropped so a token embedded in a URL never reaches a comparison, a log or a trace. A remote can carry one in the user information of a `scheme://` URL (everything up to the last `@` of its authority, so an unencoded `@` in a password is not the end of it), in its query or fragment (cut at a literal `?` or `#` only, since an encoded one is part of the path), and in the user information of git's scp-like shorthand (`[user@]host:path`), which a `user:token@host:path` spelling extends with a password. A local path is never read as any of these: the input git itself would take as a path (it has no `scheme://`, and no `:` before its first `/`) keeps every character it has, `@`, `#` and `?` included.
 *
 * Stripping must never change which repository a remote names, and one repository must have one spelling, so a network remote (any `scheme://` URL except a `file:///` path, and the scp-like shorthand) is unknown when its spelling could reach a repository other than the one its text suggests, or the same one as another spelling. That is: text that starts or ends with whitespace; an empty authority on any scheme but `file`; a host that is not exactly a DNS name, a canonical IPv4 address or a canonical bracketed IPv6 address (see `cleanHost`), or whose port is not a number, or whose authority holds a backslash; a path with a non-ASCII character, a `.` or `..` segment, an empty segment, a control character, a backslash or an `@`, or a percent-encoding other than `%20` (a space is written `%20`, and a path that is not percent-decoded, the scp-like shorthand, holds no `%` or space); and a last segment of `.git`. The scheme and the port are dropped, so `host/path` reads an ssh URL's absolute path and the scp-like shorthand's home-relative path the same, as a forge serves them. A local path is returned as written, `..` segments included.
 *
 * Never throws. The empty string means the input is unknown in one of those ways. It matches no `when.remote` pattern, and `evaluate` treats it as unknown for `when.remote` and for a predicate's `remote` reference alike.
 */
export function normaliseRemote(remote: string): string {
  // git does not strip leading whitespace, so text that starts or ends with any is not the remote it appears to be.
  if (/^\s|\s$/u.test(remote)) return "";
  const interpreted = interpret(remote);
  if (interpreted === undefined) return "";
  return interpreted
    .toLowerCase()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

/** `host/path` of a `scheme://` URL, a scp-like remote or a local path; undefined when it cannot be read safely. */
function interpret(remote: string): string | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(remote);
  if (scheme?.[1] !== undefined) {
    return fromUrl(scheme[1].toLowerCase(), remote.slice(scheme[0].length));
  }

  // A Windows drive (`C:\repo`, `C:/repo`) is a local path, not a host.
  if (/^[a-z]:[\\/]/iu.test(remote)) return remote;

  // git takes the input as scp-like when a `:` comes before the first `/`.
  const slash = remote.indexOf("/");
  const head = slash === -1 ? remote : remote.slice(0, slash);
  if (!head.includes(":")) return remote;

  // The user information of the shorthand is dropped. A `user:token@host:path` spelling has a `:` before its `@`, which git does not read as user information but which holds a credential, so it is dropped only when a `host:path` follows it: anything else (`host:a@b/c` is a path under `host` for git) cannot be told from a password and is refused.
  const at = head.lastIndexOf("@");
  if (at === -1) return fromScp(remote, false);
  return fromScp(remote.slice(at + 1), head.slice(0, at).includes(":"));
}

/** What follows `scheme://`: `[userinfo@]host[:port][/path][?query][#fragment]`. */
function fromUrl(scheme: string, rest: string): string | undefined {
  const end = rest.search(/[/?#]/u);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const tail = end === -1 ? "" : withoutQueryAndFragment(rest.slice(end));
  if (authority.includes("\\")) return undefined;

  // Only a file URL has no host, and its path is a local path, which is kept as it is.
  if (authority === "") return scheme === "file" ? tail : undefined;

  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const bare = /^(\[[^\]]*\]|[^:[\]]*)(?::(\d*))?$/u.exec(host);
  const name = cleanHost(bare?.[1]);
  if (name === undefined) return undefined;
  const path = checkedPath(tail.slice(1), true);
  if (path === undefined) return undefined;
  return path === "" ? name : `${name}/${path}`;
}

/** `host:path` of the scp-like shorthand, with its user information already removed; `strict` refuses what is not that shape. */
function fromScp(rest: string, strict: boolean): string | undefined {
  const bracketed = /^(\[[^\]]*\]):(.*)$/su.exec(rest);
  const split = bracketed ?? /^([^:/]*):(.*)$/su.exec(rest);
  const [, host, path] = split ?? [];
  // A one-letter host is a Windows drive, never a host.
  if (host === undefined || path === undefined || host.length < 2) {
    return strict ? undefined : rest;
  }
  const name = cleanHost(host);
  // An absolute path (`host:/srv/repo`) differs from one relative to the home directory (`host:srv/repo`), so its leading slash is kept.
  const absolute = path.startsWith("/");
  const checked = checkedPath(
    withoutQueryAndFragment(absolute ? path.slice(1) : path),
    false,
  );
  if (name === undefined || checked === undefined) return undefined;
  return `${name}/${absolute ? "/" : ""}${checked}`;
}

/**
 * The host in its one canonical spelling, or undefined when it has any other. A host is exactly one of: a DNS name of ASCII letter, digit and hyphen labels separated by single dots (lower-cased, one trailing dot removed, no label starting or ending with a hyphen, a last label that is neither all digits nor starts with `0x`); an IPv4 address as four decimal octets without leading zeros; or a bracketed IPv6 address in canonical RFC 5952 text. Anything else reaches a machine under a spelling this function would compare differently (a non-ASCII look-alike, an integer, hex, octal or short IPv4, an uncompressed or upper-case IPv6), so it is unknown.
 */
function cleanHost(host: string | undefined): string | undefined {
  if (host === undefined || host === "") return undefined;
  if (host.startsWith("[")) {
    return isCanonicalIpv6(host.slice(1, -1)) && host.endsWith("]")
      ? host
      : undefined;
  }
  const name = host.toLowerCase().replace(/\.$/u, "");
  const label = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  if (!new RegExp(`^${label}(?:\\.${label})*$`, "u").test(name)) {
    return undefined;
  }
  const last = name.slice(name.lastIndexOf(".") + 1);
  if (/^[0-9]+$/u.test(last) || last.startsWith("0x")) {
    return isCanonicalIpv4(name) ? name : undefined;
  }
  return name;
}

/** Four decimal octets, each 0 to 255 without a leading zero. */
function isCanonicalIpv4(text: string): boolean {
  const octets = text.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(?:0|[1-9][0-9]{0,2})$/u.test(octet) && Number(octet) <= 255,
    )
  );
}

/** Whether `text` is an IPv6 address spelled as RFC 5952 writes it: lower case, no leading zeros in a group, the first longest run of two or more zero groups compressed, no zone and no embedded IPv4. */
function isCanonicalIpv6(text: string): boolean {
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const groups = (part: string): string[] | undefined => {
    if (part === "") return [];
    const found = part.split(":");
    return found.every((group) => /^[0-9a-f]{1,4}$/u.test(group))
      ? found
      : undefined;
  };
  const left = groups(halves[0] ?? "");
  const right = groups(halves[1] ?? "");
  if (left === undefined || right === undefined) return false;
  let all: string[];
  if (halves.length === 1) {
    all = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return false;
    all = [...left, ...Array<string>(missing).fill("0"), ...right];
  }
  if (all.length !== 8) return false;
  const plain = all.map((group) => Number.parseInt(group, 16).toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && plain[start + length] === "0") length += 1;
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }
  const canonical =
    bestStart === -1
      ? plain.join(":")
      : `${plain.slice(0, bestStart).join(":")}::${plain.slice(bestStart + bestLength).join(":")}`;
  return canonical === text;
}

/**
 * A network path (without its leading slash) with its trailing slashes removed, or undefined when it names something other than its plain spelling: a non-ASCII character, a `.` or `..` segment, an empty segment, a control character, a backslash, an `@`, a last segment of `.git`, or a percent-encoding other than `%20`. A space in a URL path is written `%20`, so both spellings read the same. A path that is not percent-decoded (`decoded` false, the scp-like shorthand) holds neither a `%` nor a space.
 */
function checkedPath(path: string, decoded: boolean): string | undefined {
  let body = path.replace(/\/+$/u, "");
  if (body === "") return "";
  if (/[\\@]/u.test(body) || hasControl(body) || hasNonAscii(body)) {
    return undefined;
  }
  if (decoded) {
    body = body.replaceAll(" ", "%20");
    if (body.replaceAll("%20", "").includes("%")) return undefined;
  } else if (/[% ]/u.test(body)) {
    return undefined;
  }
  const segments = body.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return undefined;
    }
  }
  if (segments[segments.length - 1]?.toLowerCase() === ".git") return undefined;
  return body;
}

/** The text before the first literal `?` or `#`: a query and a fragment can carry a token. An encoded one is path text and stays. */
function withoutQueryAndFragment(text: string): string {
  const cut = text.search(/[?#]/u);
  return cut === -1 ? text : text.slice(0, cut);
}

/** Whether `text` holds a control character. */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Whether `text` holds a character outside ASCII. */
function hasNonAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return true;
  }
  return false;
}
