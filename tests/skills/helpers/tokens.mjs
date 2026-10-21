// Fake credentials for the skill tests. They are assembled at run time from short pieces so that no
// token-shaped literal exists in the repository (secret scanners read source text, not process memory).
// They are never valid anywhere: the curl stub accepts only the ones a test lists in valid_tokens.
const join = (...p) => p.join("");
const body = (tag, n) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = `${tag}`;
  while (s.length < n) s += alphabet;
  return s.slice(0, n);
};

export const fake = {
  notion: (tag = "A") => join("nt", "n_", body(tag, 40)),
  notionLegacy: (tag = "A") => join("sec", "ret_", body(tag, 40)),
  github: (tag = "A") => join("gh", "p_", body(tag, 36)),
  githubFine: (tag = "A") => join("github", "_pat_", body(tag, 40)),
  telegram: (tag = "A", id = "123456789") => join(id, ":", body(tag, 35)),
  openrouter: (tag = "A") => join("sk-", "or-", "v1-", body(tag, 32)),
  anthropic: (tag = "A") => join("sk-", "ant-", "api03-", body(tag, 32)),
  openai: (tag = "A") => join("sk-", "proj-", body(tag, 32)),
  deepseek: (tag = "A") => join("sk-", body(tag, 32)),
};
