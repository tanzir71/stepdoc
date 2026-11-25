import { expect, it, vi } from 'vitest'
import {
  createRedactionDetector,
  RedactionDetectionError,
} from '../src/redaction'

vi.mock('libphonenumber-js/min', () => ({
  isSupportedCountry: () => true,
  searchPhoneNumbersInText: () => {
    throw new Error('private-input-from-dependency')
  },
}))

it('sanitizes dependency errors without forwarding private messages or causes', () => {
  try {
    createRedactionDetector({ enabled: ['phone'] })('private-input')
    throw new Error('Expected detection failure')
  } catch (error) {
    expect(error).toBeInstanceOf(RedactionDetectionError)
    expect(String(error)).toContain('detector_failure')
    expect(String(error) + JSON.stringify(error)).not.toContain('private-input')
    expect(error).not.toHaveProperty('cause')
  }
})
