import { describe, expect, it } from 'vitest'
import { isValidIBAN } from 'ibantools'
import {
  isIban,
  isIpv4,
  isIpv6,
  isMacAddress,
  isPaymentCard,
  passesLuhn,
  shannonEntropy,
} from '../src/redaction'

describe('Luhn and payment card validation', () => {
  it.each([
    '79927398713',
    '49927398716',
    '4111111111111111',
    '5555555555554444',
    '378282246310005',
    '6011111111111117',
    '3530111333300000',
    '4000000000000000006',
  ])('accepts the known checksum %s', (value) =>
    expect(passesLuhn(value)).toBe(true),
  )
  it.each(['', '79927398714', '4111111111111112', '4111x11111111111', '-'])(
    'rejects invalid checksum input %s',
    (value) => expect(passesLuhn(value)).toBe(false),
  )
  it('accepts card spacing but rejects implausible lengths and repeated digits', () => {
    expect(isPaymentCard('4111 1111-1111\u00a01111')).toBe(true)
    expect(isPaymentCard('3782 822463 10005')).toBe(true)
    expect(isPaymentCard('79927398713')).toBe(false)
    expect(isPaymentCard('0000000000000000')).toBe(false)
    expect(isPaymentCard('41111111111111111111')).toBe(false)
  })
  it('catches every single-digit mutation of a valid card', () => {
    const card = '5555555555554444'
    for (let index = 0; index < card.length; index++) {
      const changed = `${card.slice(0, index)}${(Number(card[index]) + 1) % 10}${card.slice(index + 1)}`
      expect(isPaymentCard(changed)).toBe(false)
    }
  })
})

describe('IBAN country lengths and mod-97', () => {
  const examples = [
    'DE89370400440532013000',
    'GB82WEST12345698765432',
    'FR1420041010050500013M02606',
    'NL91ABNA0417164300',
    'GR1601101250000000012300695',
    'SA0380000000608010167519',
    'CH9300762011623852957',
    'NO9386011117947',
    'XK051212012345678906',
  ]
  it.each(examples)('accepts the public format fixture %s', (value) => {
    expect(isIban(value)).toBe(true)
    expect(isValidIBAN(value)).toBe(true)
    // Independent whole-number oracle, also covering IBANs beyond JS integer precision.
    const expanded = (value.slice(4) + value.slice(0, 4)).replace(
      /[A-Z]/g,
      (character) => String(character.charCodeAt(0) - 55),
    )
    expect(BigInt(expanded) % 97n).toBe(1n)
    expect(
      isIban(`${value.slice(0, -1)}${(Number(value.at(-1)) + 1) % 10}`),
    ).toBe(false)
  })
  it('normalizes case and grouping whitespace', () =>
    expect(isIban('gb82 WEST 1234 5698 7654 32')).toBe(true))
  it.each([
    'DE89370400440532013001',
    'DE8937040044053201300',
    'ZZ89370400440532013000',
    'GB00WEST12345698765432',
    'GB99WEST12345698765432',
    'GB82-WEST-12345698765432',
    '',
  ])('rejects invalid IBAN %s', (value) => expect(isIban(value)).toBe(false))
})

describe('entropy', () => {
  it('measures Shannon bits per Unicode code point', () => {
    expect(shannonEntropy('')).toBe(0)
    expect(shannonEntropy('aaaaaaaa')).toBe(0)
    expect(shannonEntropy('abab')).toBe(1)
    expect(shannonEntropy('abcd')).toBe(2)
    expect(shannonEntropy('😀😀ab')).toBe(1.5)
    expect(shannonEntropy('0123456789abcdef')).toBe(4)
  })
})

describe('IP and MAC validation', () => {
  it.each(['0.0.0.0', '127.0.0.1', '192.168.1.24', '255.255.255.255'])(
    'accepts IPv4 %s',
    (value) => expect(isIpv4(value)).toBe(true),
  )
  it.each(['256.0.0.1', '1.2.3', '1.2.3.4.5', '1.2.3.-1', '1.2.3.1234'])(
    'rejects malformed IPv4 %s',
    (value) => expect(isIpv4(value)).toBe(false),
  )
  it.each([
    '::',
    '::1',
    '2001:db8::1',
    '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
    '::ffff:192.0.2.1',
    'fe80::1%eth0',
  ])('accepts IPv6 %s', (value) => expect(isIpv6(value)).toBe(true))
  it.each([
    '2001::db8::1',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '12345::1',
    '::ffff:999.0.2.1',
    ':1',
    '::1%',
    '::1%bad zone',
    '1.2.3.4',
    ':::',
  ])('rejects malformed IPv6 %s', (value) => expect(isIpv6(value)).toBe(false))
  it.each(['00:11:22:33:44:55', 'aa-bb-cc-dd-ee-ff', 'AABB.CCDD.EEFF'])(
    'accepts MAC %s',
    (value) => expect(isMacAddress(value)).toBe(true),
  )
  it.each([
    '00:11:22:33:44',
    '00:11-22:33:44:55',
    'GG:11:22:33:44:55',
    '00:11:22:33:44:55:66',
  ])('rejects malformed MAC %s', (value) =>
    expect(isMacAddress(value)).toBe(false),
  )
})
