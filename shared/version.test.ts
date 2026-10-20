import { describe, expect, it } from 'vitest';

import pkg from '../package.json';
import { APP_USER_AGENT, APP_VERSION } from './version';

describe('the version metadata', () => {
  it('matches the version of package.json', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('uses the same version in the user agent', () => {
    expect(APP_USER_AGENT).toBe(`Kaggle-Kit/${pkg.version}`);
    expect(APP_USER_AGENT).not.toMatch(/key|token|secret/i);
  });
});
