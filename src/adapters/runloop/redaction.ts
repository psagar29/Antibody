const tokenPatterns = [
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /gh[pousr]_[A-Za-z0-9]{20,}/gu,
  /rfx_[A-Za-z0-9_-]{16,}/gu,
  /(?:runloop|rl)[_-](?:api[_-]?)?[A-Za-z0-9_-]{20,}/giu,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/giu,
];

export class OutputRedactor {
  readonly #literalSecrets: readonly string[];

  constructor(literalSecrets: readonly string[] = []) {
    this.#literalSecrets = literalSecrets
      .filter((secret) => secret.length >= 6)
      .toSorted((left, right) => right.length - left.length);
  }

  redact(value: string): string {
    let redacted = value;
    for (const secret of this.#literalSecrets) {
      redacted = redacted.replaceAll(secret, '[REDACTED]');
    }
    for (const pattern of tokenPatterns) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }

  containsSecretLikeValue(value: string): boolean {
    if (this.#literalSecrets.some((secret) => value.includes(secret))) return true;
    return tokenPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
  }
}
