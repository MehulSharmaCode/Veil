import { describe, expect, it } from 'vitest';
import { isAadhaar, isCard, isPan, luhnValid, verhoeffValid } from '../src/privacy/checksums';
import { classifyDigits, detect, detectAll, expectedAnswerCategory } from '../src/privacy/detectors';
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

// ---- address detection hardening (2026-09-28) ------------------------------------------------------
// Synthetic values only. Each case: task text → exact sanitized text + the exact vaulted values.

describe('address detection: coverage and boundaries in task text', () => {
  const E1 = 'mehul.test@example.com';
  const ADDR = '12 MG Road, Shivajinagar, Pune';
  const cases: [string, string, Record<string, string>][] = [
    // cue variants
    [`my address: ${ADDR} 411005`, 'my address: [ADDRESS_1]', { '[ADDRESS_1]': `${ADDR} 411005` }],
    [`my address is ${ADDR}`, 'my address is [ADDRESS_1]', { '[ADDRESS_1]': ADDR }],
    [`address: ${ADDR} and email is ${E1}`, 'address: [ADDRESS_1] and email is [EMAIL_1]', { '[ADDRESS_1]': ADDR, '[EMAIL_1]': E1 }],
    [`with address ${ADDR} please`, 'with address [ADDRESS_1] please', { '[ADDRESS_1]': ADDR }],
    ['use this address 45 Park Street, Kolkata for the address field', 'use this address [ADDRESS_1] for the address field', { '[ADDRESS_1]': '45 Park Street, Kolkata' }],
    ['enter this address 45 Park Street, Kolkata 700016 and stop', 'enter this address [ADDRESS_1] and stop', { '[ADDRESS_1]': '45 Park Street, Kolkata 700016' }],
    ['put this as my address: Flat 3B, Sunrise Apartments, Andheri West, Mumbai', 'put this as my address: [ADDRESS_1]', { '[ADDRESS_1]': 'Flat 3B, Sunrise Apartments, Andheri West, Mumbai' }],
    ['Set the address to 88 Nehru Nagar, Bhopal then fill alternate email with alt.user@example.org', 'Set the address to [ADDRESS_1] then fill alternate email with [EMAIL_1]', { '[ADDRESS_1]': '88 Nehru Nagar, Bhopal', '[EMAIL_1]': 'alt.user@example.org' }],
    [`Fill the address field with address ${ADDR} then save`, 'Fill the address field with address [ADDRESS_1] then save', { '[ADDRESS_1]': ADDR }],
    // the value precedes the cue
    ['Use 88 Nehru Nagar, Bhopal as my address and do not submit', 'Use [ADDRESS_1] as my address and do not submit', { '[ADDRESS_1]': '88 Nehru Nagar, Bhopal' }],
    [`Enter ${ADDR} 411005 in the address field and do not submit`, 'Enter [ADDRESS_1] in the address field and do not submit', { '[ADDRESS_1]': `${ADDR} 411005` }],
    ['Put 12 MG Road Shivajinagar Pune into the address field', 'Put [ADDRESS_1] into the address field', { '[ADDRESS_1]': '12 MG Road Shivajinagar Pune' }],
    ['Use Andheri West, Mumbai as my address', 'Use [ADDRESS_1] as my address', { '[ADDRESS_1]': 'Andheri West, Mumbai' }],
    // no PIN, lowercase, uppercase, no commas
    [`fill address shivajinagar pune and email ${E1}`, 'fill address [ADDRESS_1] and email [EMAIL_1]', { '[ADDRESS_1]': 'shivajinagar pune', '[EMAIL_1]': E1 }],
    ['fill address with 12 mg road, shivajinagar, pune and alternate email with alt.user@example.org', 'fill address with [ADDRESS_1] and alternate email with [EMAIL_1]', { '[ADDRESS_1]': '12 mg road, shivajinagar, pune', '[EMAIL_1]': 'alt.user@example.org' }],
    ['address 12 MG ROAD, SHIVAJINAGAR, PUNE. email MEHUL.TEST@EXAMPLE.COM', 'address [ADDRESS_1]. email [EMAIL_1]', { '[ADDRESS_1]': '12 MG ROAD, SHIVAJINAGAR, PUNE', '[EMAIL_1]': 'MEHUL.TEST@EXAMPLE.COM' }],
    [`Fill address 12 MG Road Shivajinagar Pune and email ${E1} do not submit`, 'Fill address [ADDRESS_1] and email [EMAIL_1] do not submit', { '[ADDRESS_1]': '12 MG Road Shivajinagar Pune', '[EMAIL_1]': E1 }],
    // followed by another instruction / field / sentence
    [`Type my address ${ADDR} into the address box, then fill email ${E1}, do not click save`, 'Type my address [ADDRESS_1] into the address box, then fill email [EMAIL_1], do not click save', { '[ADDRESS_1]': ADDR, '[EMAIL_1]': E1 }],
    [`Fill my email with ${E1} and my address with ${ADDR}. Do not submit the form.`, 'Fill my email with [EMAIL_1] and my address with [ADDRESS_1]. Do not submit the form.', { '[EMAIL_1]': E1, '[ADDRESS_1]': ADDR }],
    [`Fill my address with ${ADDR} and my phone with 9876543210`, 'Fill my address with [ADDRESS_1] and my phone with [PHONE_1]', { '[ADDRESS_1]': ADDR, '[PHONE_1]': '9876543210' }],
    [`Address: ${ADDR}, phone: 9876543210, email: ${E1}`, 'Address: [ADDRESS_1], phone: [PHONE_1], email: [EMAIL_1]', { '[ADDRESS_1]': ADDR, '[PHONE_1]': '9876543210', '[EMAIL_1]': E1 }],
    ['Fill my email and address. My address is House No. 5, Sector 21, Gurugram, Haryana 122001. Then stop.', 'Fill my email and address. My address is [ADDRESS_1]. Then stop.', { '[ADDRESS_1]': 'House No. 5, Sector 21, Gurugram, Haryana 122001' }],
    [`address - 14, Lake View Colony, Hyderabad; email ${E1}`, 'address - [ADDRESS_1]; email [EMAIL_1]', { '[ADDRESS_1]': '14, Lake View Colony, Hyderabad', '[EMAIL_1]': E1 }],
    ['Fill my address: 5, Lake Road, New Delhi 110001 and my phone 9876543210 and don\'t save', 'Fill my address: [ADDRESS_1] and my phone [PHONE_1] and don\'t save', { '[ADDRESS_1]': '5, Lake Road, New Delhi 110001', '[PHONE_1]': '9876543210' }],
    // a connector followed by more address stays inside; one followed by a new clause ends it
    ['address 12 MG Road and 5th Cross, Pune then save', 'address [ADDRESS_1] then save', { '[ADDRESS_1]': '12 MG Road and 5th Cross, Pune' }],
    ['my address is flat 4b sai apartments near city mall pune 411005 and my name is priya nair', 'my address is [ADDRESS_1] and my name is [PERSON_1]', { '[ADDRESS_1]': 'flat 4b sai apartments near city mall pune 411005', '[PERSON_1]': 'priya nair' }],
    // framed by dashes; lowercase prose with several categories
    ['Fill my address — 9/2 Residency Rd., Bengaluru — and stop', 'Fill my address — [ADDRESS_1] — and stop', { '[ADDRESS_1]': '9/2 Residency Rd., Bengaluru' }],
    [
      'my name is priya nair, my pan is BNZPM2501F and my phone is +91 91234 56780. fill my address with flat 4b sai apartments near city mall pune and the alternate email with Priya.Nair.Test@Example.org. do not submit.',
      'my name is [PERSON_1], my pan is [PAN_1] and my phone is [PHONE_1]. fill my address with [ADDRESS_1] and the alternate email with [EMAIL_1]. do not submit.',
      { '[PERSON_1]': 'priya nair', '[PAN_1]': 'BNZPM2501F', '[PHONE_1]': '+91 91234 56780', '[ADDRESS_1]': 'flat 4b sai apartments near city mall pune', '[EMAIL_1]': 'Priya.Nair.Test@Example.org' },
    ],
    // no value at all: nothing is invented
    ['Fill my email and address. Do not submit.', 'Fill my email and address. Do not submit.', {}],
    ['Fill the address and email fields. Do not submit.', 'Fill the address and email fields. Do not submit.', {}],
    ['Please send the letter to my address', 'Please send the letter to my address', {}],
  ];
  it.each(cases)('%s', (input, expected, vaulted) => {
    const { vault, s } = mk();
    const out = s.sanitize(input, task);
    expect(out).toBe(expected);
    expect(Object.fromEntries(vault.metadata().map((m) => [m.id, vault.getEntry(m.id)!.value]))).toEqual(vaulted);
    // what leaves is residual-clean under the gate's strict scan
    expect(scanStrict(out)).toEqual([]);
  });
});

describe('address detection: page text is not over-masked; cue-less shapes are masked whole', () => {
  const pageCases: [string, string][] = [
    ['Email address', 'Email address'],
    ['Enter your email address to receive updates', 'Enter your email address to receive updates'],
    ['Address is required', 'Address is required'],
    ['Address: required', 'Address: required'],
    ['Please enter your address below', 'Please enter your address below'],
    ['Update your address details in the profile section', 'Update your address details in the profile section'],
    ['Enter the address in the address field', 'Enter the address in the address field'],
    ['IP address 10.0.0.1 is blocked', 'IP address 10.0.0.1 is blocked'],
    ['Unit 3 of the course is due', 'Unit 3 of the course is due'],
    ['Get flat 50% off today', 'Get flat 50% off today'],
    ['Phase 2 rollout completes next week', 'Phase 2 rollout completes next week'],
    ['Visit us at 5 Park Street, Kolkata 700016 for help', 'Visit us at [ADDRESS_1] for help'],
    ['Our office: 22 Residency Road, Bengaluru 560025. Call us.', 'Our office: [ADDRESS_1]. Call us.'],
    ['Shipping to Flat 12, Green Park Apartments, Delhi', 'Shipping to [ADDRESS_1]'],
  ];
  it.each(pageCases)('%s', (input, expected) => {
    const { s } = mk();
    expect(s.sanitize(input, page)).toBe(expected);
  });
  it('an LLM that proposes typing a raw address as literal text is caught by the strict scan (T4)', () => {
    expect(scanStrict('12 MG Road, Shivajinagar, Pune').length).toBeGreaterThan(0);
    expect(scanStrict('Flat 3B, Sunrise Apartments, Andheri West').length).toBeGreaterThan(0);
  });
});

describe('ask_user answers: the question tells the sanitizer what a cue-less answer holds', () => {
  const answer = (q: string, a: string) => {
    const { vault, s } = mk();
    const out = s.sanitize(a, { source: 'user_answer', origin: 'http://localhost:8080', expect: expectedAnswerCategory(q) });
    return { out, values: vault.metadata().map((m) => vault.getEntry(m.id)!.value) };
  };
  it('maps questions to expected categories; yes/no questions expect nothing', () => {
    expect(expectedAnswerCategory('What is your address?')).toBe('ADDRESS');
    expect(expectedAnswerCategory('Please provide your full name.')).toBe('PERSON');
    expect(expectedAnswerCategory('Should I fill the address field?')).toBeNull();
    expect(expectedAnswerCategory('What is your email address?')).toBeNull();
    expect(expectedAnswerCategory('What should I do next?')).toBeNull();
  });
  it('masks cue-less, PIN-less address and name answers whole', () => {
    expect(answer('What is your address?', 'Shivajinagar, Pune')).toEqual({ out: '[ADDRESS_1]', values: ['Shivajinagar, Pune'] });
    expect(answer('Please provide your address.', 'shivajinagar pune')).toEqual({ out: '[ADDRESS_1]', values: ['shivajinagar pune'] });
    expect(answer('What is your address?', '12 MG Road, Shivajinagar, Pune')).toEqual({ out: '[ADDRESS_1]', values: ['12 MG Road, Shivajinagar, Pune'] });
    expect(answer('What is your full name?', 'priya nair')).toEqual({ out: '[PERSON_1]', values: ['priya nair'] });
  });
  it('leaves control answers alone and never merges other PII into the address', () => {
    expect(answer('Which address should I use?', 'skip').out).toBe('skip');
    expect(answer('Should I fill the address field?', 'yes').out).toBe('yes');
    expect(answer('Please provide your address.', 'my address is 12 MG Road, Pune and email a@b.co')).toEqual({
      out: 'my address is [ADDRESS_1] and email [EMAIL_1]',
      values: ['12 MG Road, Pune', 'a@b.co'],
    });
  });
});
