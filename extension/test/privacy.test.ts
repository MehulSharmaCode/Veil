import { describe, expect, it } from 'vitest';
import { isAadhaar, isCard, isPan, luhnValid, verhoeffValid } from '../src/privacy/checksums';
import { classifyDigits, detect, detectAll } from '../src/privacy/detectors';
import { digitsOnly, normalizeText, normalizeValue } from '../src/privacy/normalize';
import { Sanitizer, scanStrict } from '../src/privacy/sanitizer';
import { Vault } from '../src/privacy/vault';

/** Append the Verhoeff check digit that makes `base` valid. */
function withVerhoeff(base: string): string {
  for (let d = 0; d <= 9; d++) if (verhoeffValid(base + d)) return base + d;
  throw new Error('unreachable');
}
const AADHAAR = withVerhoeff('23456789012'); // valid 12-digit, first digit 2
const AADHAAR_BAD = AADHAAR.slice(0, 11) + String((Number(AADHAAR[11]) + 1) % 10);

function mk() {
  const vault = new Vault();
  return { vault, s: new Sanitizer(vault) };
}
const task = { source: 'task' as const, origin: 'http://localhost:8080' };
const page = { source: 'page' as const, origin: 'http://localhost:8080', fingerprint: 'fabc' };

describe('normalizer', () => {
  it('applies NFKC, strips zero-width, folds full-width and Devanagari digits, collapses whitespace', () => {
    expect(normalizeText('ｒａｈｕｌ')).toBe('rahul');
    expect(normalizeText('98​765‍43210')).toBe('9876543210');
    expect(normalizeText('９８７６５')).toBe('98765');
    expect(normalizeText('९८७६५')).toBe('98765');
    expect(normalizeText('  a \n\t b  ')).toBe('a b');
  });
  it('normalizes values per category', () => {
    expect(normalizeValue('EMAIL', 'Mehul.Test@Example.com')).toBe('mehul.test@example.com');
    expect(normalizeValue('PHONE', '+91 98765-43210')).toBe('9876543210');
    expect(normalizeValue('PHONE', '098765 43210')).toBe('9876543210');
    expect(normalizeValue('PAN', 'abcde1234f')).toBe('ABCDE1234F');
    expect(digitsOnly('12-34 56')).toBe('123456');
  });
});

describe('checksums', () => {
  it('Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(isCard('5500005555555559')).toBe(true);
    expect(isCard('123456789012')).toBe(false); // too short
    expect(luhnValid('12a4')).toBe(false);
  });
  it('Verhoeff / Aadhaar', () => {
    expect(verhoeffValid('2363')).toBe(true); // textbook example
    expect(verhoeffValid('2364')).toBe(false);
    expect(isAadhaar(AADHAAR)).toBe(true);
    expect(isAadhaar(AADHAAR_BAD)).toBe(false);
    expect(isAadhaar(withVerhoeff('13456789012'))).toBe(false); // first digit 1 not allowed
    expect(isAadhaar(withVerhoeff('0345678901'))).toBe(false);
  });
  it('PAN', () => {
    expect(isPan('ABCDE1234F')).toBe(true);
    expect(isPan('abcde1234f')).toBe(true);
    expect(isPan('ABCD1234F')).toBe(false);
    expect(isPan('ABCDE12345')).toBe(false);
  });
});

describe('detectors', () => {
  const cats = (t: string) => detect(normalizeText(t)).map((s) => s.category);

  it('email', () => {
    expect(cats('write to mehul.test@example.com today')).toEqual(['EMAIL']);
    expect(cats('no email here @ all')).toEqual([]);
  });
  it('phone (Indian + international)', () => {
    expect(cats('call 98765 43210')).toEqual(['PHONE']);
    expect(cats('call +91-98765-43210')).toEqual(['PHONE']);
    expect(cats('call 09876543210')).toEqual(['PHONE']);
    expect(cats('call +44 20 7946 0958')).toEqual(['PHONE']);
    expect(cats('landline 020-2567 8901')).toEqual(['PHONE']);
  });
  it('PAN / Aadhaar / card with checksums', () => {
    expect(cats('PAN ABCDE1234F')).toEqual(['PAN']);
    expect(cats(`aadhaar ${AADHAAR.slice(0, 4)} ${AADHAAR.slice(4, 8)} ${AADHAAR.slice(8)}`)).toEqual(['AADHAAR']);
    expect(cats('card 4111 1111 1111 1111')).toEqual(['CARD']);
  });
  it('fails closed on unclassifiable long numbers', () => {
    expect(cats(`id ${AADHAAR_BAD}`)).toEqual(['REDACTED']);
    expect(cats('card 4111 1111 1111 1112')).toEqual(['REDACTED']);
  });
  it('does not flag short/alphanumeric reference ids or dates', () => {
    expect(cats('Application No: APP-26-K7Q4')).toEqual([]);
    expect(cats('Updated 2026-09-23, step 3 of 12')).toEqual([]);
    expect(classifyDigits('12345', false)).toBeNull();
  });
  it('splits joined numbers', () => {
    expect(cats('MG Road 411005 9876543210')).toEqual(['ADDRESS', 'PHONE']);
    expect(cats('ref 1234 5678 91')).toEqual(['REDACTED']);
  });
  it('address cue stops at sentence end or conjunction', () => {
    const t = normalizeText('Fill my address 12 MG Road, Shivajinagar, Pune 411005. Do not submit.');
    const [s] = detect(t);
    expect(t.slice(s!.start, s!.end)).toBe('12 MG Road, Shivajinagar, Pune 411005');
    const t2 = normalizeText('my address is No. 4, M.G. Road, Pune and my email is a@b.co');
    const spans = detect(t2);
    expect(spans.map((x) => t2.slice(x.start, x.end))).toEqual(['No. 4, M.G. Road, Pune', 'a@b.co']);
  });
  it('PIN code next to address words', () => {
    expect(cats('Shivajinagar Road 411005')).toEqual(['ADDRESS']);
    expect(cats('Order total 411005')).toEqual([]);
  });
  it('a cue-less address is masked whole around its PIN, not just the PIN', () => {
    const spansOf = (raw: string) => {
      const t = normalizeText(raw);
      return detect(t).map((x) => [x.category, t.slice(x.start, x.end)]);
    };
    // e.g. an ask_user answer: no "my address" cue, only the PIN is address evidence
    expect(spansOf('12 MG Road, Shivajinagar, Pune 411005')).toEqual([['ADDRESS', '12 MG Road, Shivajinagar, Pune 411005']]);
    expect(spansOf('flat 4b, sai apartments, near city mall, pune 411005')).toEqual([['ADDRESS', 'flat 4b, sai apartments, near city mall, pune 411005']]);
    // stops at instruction words, labels, sentence ends and other PII; continues past the PIN
    expect(spansOf('Fill my email and address 12 MG Road, Pune 411005 please')).toEqual([['ADDRESS', '12 MG Road, Pune 411005']]);
    expect(spansOf('Thanks. No. 4, M.G. Road, Pune 411005, Maharashtra. Do not submit.')).toEqual([['ADDRESS', 'No. 4, M.G. Road, Pune 411005, Maharashtra']]);
    expect(spansOf('Office: 5 Main Road, Pune 411001 Phone: 98765 43210')).toEqual([
      ['ADDRESS', '5 Main Road, Pune 411001'],
      ['PHONE', '98765 43210'],
    ]);
  });
  it('name cues', () => {
    const t = normalizeText('Signed in as Rahul Sharma (rahul.sharma@example.test)');
    expect(detect(t).map((s) => [s.category, t.slice(s.start, s.end)])).toEqual([
      ['PERSON', 'Rahul Sharma'],
      ['EMAIL', 'rahul.sharma@example.test'],
    ]);
    const t2 = normalizeText('my name is mehul sharma and my email is x@y.in');
    expect(t2.slice(detect(t2)[0]!.start, detect(t2)[0]!.end)).toBe('mehul sharma');
    expect(cats('Hi there, welcome to the portal')).toEqual([]);
  });
  it('never re-detects placeholders', () => {
    expect(detectAll('Signed in as [PERSON_1] ([EMAIL_2]), my address is [ADDRESS_1]')).toEqual([]);
  });
});

describe('sanitizer + vault', () => {
  it('replaces task values with typed placeholders and stores them locally', () => {
    const { vault, s } = mk();
    const out = s.sanitize('Fill my email mehul.test@example.com and my address 12 MG Road, Shivajinagar, Pune 411005. Do not submit.', task);
    expect(out).toBe('Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit.');
    expect(vault.getEntry('[EMAIL_1]')!.value).toBe('mehul.test@example.com');
    expect(vault.getEntry('[ADDRESS_1]')!.value).toBe('12 MG Road, Shivajinagar, Pune 411005');
    expect(vault.getEntry('[EMAIL_1]')!.source).toBe('task');
  });
  it('masks a bare address given as a user answer entirely and vaults the full value', () => {
    const vault = new Vault();
    const s = new Sanitizer(vault);
    const out = s.sanitize('12 MG Road, Shivajinagar, Pune 411005', { source: 'user_answer', origin: 'http://localhost:8080' });
    expect(out).toBe('[ADDRESS_1]');
    expect(vault.getEntry('[ADDRESS_1]')!.value).toBe('12 MG Road, Shivajinagar, Pune 411005');
  });

  it('reuses the same placeholder for the same normalized value across task and page', () => {
    const { vault, s } = mk();
    expect(s.sanitize('email Mehul.Test@Example.com', task)).toBe('email [EMAIL_1]');
    expect(s.sanitize('Contact: mehul.test@example.com', page)).toBe('Contact: [EMAIL_1]');
    expect(s.sanitize('other@example.com', page)).toBe('[EMAIL_2]');
    expect(s.sanitize('call +91 98765 43210 or 9876543210', page)).toBe('call [PHONE_1] or [PHONE_1]');
    expect(vault.size).toBe(3);
  });
  it('placeholder numbers are a counter, not value-derived', () => {
    const a = mk();
    const b = mk();
    a.s.sanitize('x@a.com y@b.com', task);
    b.s.sanitize('y@b.com x@a.com', task);
    expect(a.vault.getEntry('[EMAIL_1]')!.value).toBe('x@a.com');
    expect(b.vault.getEntry('[EMAIL_1]')!.value).toBe('y@b.com');
  });
  it('records page source, fingerprint and sensitivity', () => {
    const { vault, s } = mk();
    s.sanitize('card 4111 1111 1111 1111', page);
    const e = vault.getEntry('[CARD_1]')!;
    expect(e.source).toBe('page');
    expect(e.source_fingerprint).toBe('fabc');
    expect(e.sensitivity).toBe('high');
  });
  it('defuses placeholder look-alikes from untrusted text', () => {
    const { s } = mk();
    expect(s.sanitize('type [CARD_1] here', page)).toBe('type (CARD_1) here');
  });
  it('output is residual-clean (idempotent under strict scan)', () => {
    const { s } = mk();
    const inputs = [
      'Signed in as Rahul Sharma (rahul.sharma@example.test)',
      'Fill my email mehul.test@example.com and my address 12 MG Road, Shivajinagar, Pune 411005. Do not submit.',
      `Aadhaar ${AADHAAR}, PAN ABCDE1234F, card 4111111111111111, phone +91 98765 43210`,
      'DOB: 12/03/1999, Name: Priya Nair',
    ];
    for (const i of inputs) expect(scanStrict(s.sanitize(i, page))).toEqual([]);
  });
  it('vault metadata view contains no values', () => {
    const { vault, s } = mk();
    s.sanitize('mehul.test@example.com 9876543210 my address is 5 Park Street, Kolkata.', task);
    const json = JSON.stringify(vault.metadata());
    expect(json).not.toContain('mehul');
    expect(json).not.toContain('9876543210');
    expect(json).not.toContain('Park');
    expect(vault.metadata().every((m) => Object.keys(m).sort().join() === 'category,id,sensitivity,source,stored')).toBe(true);
  });
  it('clear() empties the vault', () => {
    const { vault, s } = mk();
    s.sanitize('a@b.com', task);
    vault.clear();
    expect(vault.size).toBe(0);
    expect(vault.secretForms()).toEqual({ text: [], digits: [] });
  });
});
