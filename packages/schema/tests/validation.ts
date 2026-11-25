import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { guideJsonSchema } from '../src/guide'

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
})
addFormats(ajv)
export const validateJsonGuide = ajv.compile(guideJsonSchema)
