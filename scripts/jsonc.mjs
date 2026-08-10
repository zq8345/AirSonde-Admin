// JSONC → JSON。
// ⚠️ 不能用 naive 正则：字符串里的 `//` 不是注释（"https://api.github.com" 会被切掉半个值）。
//    所以必须逐字符走，并且知道自己此刻在不在字符串里。
export function stripJsonc(src) {
  let out = "", i = 0, inStr = false, esc = false;
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i++; continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += ch; i++;
  }
  // 尾逗号（JSONC 允许，JSON.parse 不允许）—— 同样要避开字符串内部
  let res = "", j = 0; inStr = false; esc = false;
  while (j < out.length) {
    const ch = out[j];
    if (inStr) {
      res += ch;
      if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false;
      j++; continue;
    }
    if (ch === '"') { inStr = true; res += ch; j++; continue; }
    if (ch === ",") {
      let k = j + 1; while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === "}" || out[k] === "]") { j++; continue; }
    }
    res += ch; j++;
  }
  return res;
}
