import { describe, expect, it } from 'vitest';
import { originOf, parseSite, siteName } from './sites';

describe('sites (origins) for saved secrets', () => {
  it('is scheme, host and port, as the engine compares them', () => {
    expect(originOf('https://App.Example.com/login?x=1#y')).toBe('https://app.example.com');
    expect(originOf('https://app.example.com:443/')).toBe('https://app.example.com');
    expect(originOf('http://127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080');
    expect(originOf('https://example.com./')).toBe('https://example.com');
    for (const bad of ['file:///etc/passwd', 'data:text/html,x', 'app.example.com', '', null, undefined]) expect(originOf(bad)).toBeNull();
  });
  it('reads a typed site, allowing a bare host', () => {
    expect(parseSite('app.example.com')).toBe('https://app.example.com');
    expect(parseSite('localhost:3000')).toBe('https://localhost:3000');
    expect(parseSite('http://localhost:3000/x')).toBe('http://localhost:3000');
    expect(parseSite('ftp://x.com')).toBeNull();
    expect(parseSite('  ')).toBeNull();
  });
  it('reads plainly in a sentence', () => {
    expect(siteName('https://evil.example')).toBe('evil.example');
    expect(siteName('http://localhost:3000')).toBe('localhost:3000');
  });
});
