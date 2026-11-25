import { getCountrySpecifications } from 'ibantools'

const ibanLengths = new Map<string, number>()
for (const [country, spec] of Object.entries(getCountrySpecifications())) {
  if (typeof spec.chars === 'number') ibanLengths.set(country, spec.chars)
}

export function ibanLength(country: string): number | undefined {
  return ibanLengths.get(country.toUpperCase())
}

export function passesLuhn(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '')
  if (!/^[0-9]+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

export function isPaymentCard(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '')
  return (
    /^[0-9]{13,19}$/.test(digits) &&
    !/^([0-9])\1+$/.test(digits) &&
    passesLuhn(digits)
  )
}

/** Country length + ISO 7064 MOD 97-10, without large-integer precision loss. */
export function isIban(value: string): boolean {
  const normalized = value.replace(/\s/g, '').toUpperCase()
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(normalized)) return false
  if (ibanLength(normalized.slice(0, 2)) !== normalized.length) return false
  const check = Number(normalized.slice(2, 4))
  if (check < 2 || check > 98) return false
  let remainder = 0
  for (const character of normalized.slice(4) + normalized.slice(0, 4)) {
    const code = character.charCodeAt(0)
    remainder =
      code >= 65
        ? (remainder * 100 + code - 55) % 97
        : (remainder * 10 + code - 48) % 97
  }
  return remainder === 1
}

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  let length = 0
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1)
    length++
  }
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

export function isIpv4(value: string): boolean {
  return (
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value) &&
    value.split('.').every((part) => Number(part) <= 255)
  )
}

export function isIpv6(value: string): boolean {
  let address = value
  const zone = address.indexOf('%')
  if (zone >= 0) {
    if (!/^[A-Za-z0-9_.-]+$/.test(address.slice(zone + 1))) return false
    address = address.slice(0, zone)
  }
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':')
    if (lastColon < 0 || !isIpv4(address.slice(lastColon + 1))) return false
    address = `${address.slice(0, lastColon + 1)}0:0`
  }
  if (!/^[0-9A-Fa-f:]+$/.test(address)) return false
  const compressed = address.indexOf('::')
  if (compressed >= 0 && address.indexOf('::', compressed + 2) >= 0)
    return false
  const sides = address.split('::')
  const parts = sides.flatMap((side) => (side ? side.split(':') : []))
  if (!parts.every((part) => /^[0-9A-Fa-f]{1,4}$/.test(part))) return false
  return compressed >= 0 ? parts.length < 8 : parts.length === 8
}

export function isMacAddress(value: string): boolean {
  return (
    /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value) ||
    /^(?:[0-9a-f]{2}-){5}[0-9a-f]{2}$/i.test(value) ||
    /^(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}$/i.test(value)
  )
}
